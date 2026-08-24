/**
 * The scan history, on the user's own machine.
 *
 * One reason this exists: without a record of the last scan, the second scan
 * is just the first scan again. "What changed since you last looked" is the
 * only reason anybody opens this product twice, and it is a question about
 * two runs, not about a database.
 *
 * Everything here is deliberately dull. The interesting decisions — what
 * makes two findings the same finding, what a hostname is worth keeping —
 * live in `identity.ts` and in the CHECK constraints in `schema.ts`, where
 * they can be read in one sitting.
 */

import { DatabaseSync } from 'node:sqlite';

import type { Coverage, Evidence, Finding } from '@ledar/contracts';

import {
  assertNoCredentials,
  assertSampleIsRedacted,
  databaseFingerprint,
  findingKey,
  structureHash,
} from './identity.js';
import { SCHEMA_VERSION, applySchema } from './schema.js';
import {
  bool,
  int,
  intOrNull,
  json,
  real,
  text,
  textOrNull,
} from './rows.js';
import type { Row } from './rows.js';
import {
  RUN_SELECT,
  readRunSnapshot,
  toRuleRun,
  toRunSummary,
} from './snapshot.js';
import type {
  DatabaseIdentity,
  FinishRunInput,
  FindingHistoryEntry,
  OpenRunInput,
  RuleRun,
  RunOutcome,
  RunSnapshot,
  RunSummary,
  ScanCost,
  StoredFinding,
} from './types.js';


/**
 * The claim kinds this build can read back.
 *
 * Not a CHECK constraint in the DDL — that would be a second copy of a list
 * `@ledar/contracts` already owns, and copies go stale. Here it only guards
 * the read path, where a value it does not recognise is a reason to stop
 * rather than to widen.
 */
const KNOWN_KINDS = new Set([
  'observation',
  'inference',
  'recommendation',
  'negative',
]);

/**
 * How long a write waits for the other window before it gives up.
 *
 * SQLite ships with this at 0, which means a second window does not wait at
 * all: it fails on contact with `SQLITE_BUSY` ("database is locked"). This is
 * an app on somebody's laptop and having two of its windows open is ordinary,
 * so the default turns an ordinary Tuesday into a scan that read the database
 * perfectly and then has no record of having run.
 *
 * Five seconds is chosen against what these transactions actually are, not by
 * feel: every write here is one short statement or a handful of inserts, so
 * the realistic wait is milliseconds. A five second wait therefore does not
 * mean "busy", it means something is wrong — a stuck process, a file on a
 * network share — and at that point failing is the honest answer rather than
 * hanging the window for a minute. The error the user then sees is still
 * SQLite's, and it is still true.
 *
 * This is not a lock and it is not a queue. It converts "fails instantly" into
 * "waits, then usually succeeds". Two windows that genuinely want to write for
 * longer than this at the same time will still collide, and should.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Makes this connection wait for the other window instead of failing at it.
 *
 * Verified rather than assumed. `PRAGMA busy_timeout` is a statement SQLite is
 * free to ignore, and a pragma that quietly did nothing would leave every
 * write here as fragile as it was before while looking handled — which is the
 * shape of bug this package exists to refuse elsewhere.
 *
 * WAL is deliberately NOT turned on here. It is the usual next line in a
 * paragraph like this one, and it does not solve this problem: WAL lets
 * readers run while a writer works, but writers still take turns exactly as
 * they do now — measured, both journal modes fail an unprotected second
 * writer in ~1ms and both make a protected one wait. What WAL would change is
 * the promise that the history is one file: its committed tail lives in
 * `history.db-wal` until a checkpoint, so a user who attaches `history.db` to
 * a bug report after a crash sends a history that is missing its most recent
 * runs and says nothing about it. Paying that for concurrency we would not
 * get is a bad trade. `test/concurrency.test.ts` holds the trip wire.
 */
function waitForOtherWriters(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const applied = db.prepare(`PRAGMA busy_timeout`).get()?.['timeout'];
  if (applied !== BUSY_TIMEOUT_MS) {
    throw new Error(
      `This SQLite build did not take a busy timeout: asked for ` +
        `${BUSY_TIMEOUT_MS}ms and it reports ${String(applied)}. Without it a ` +
        `second window writing at the same moment fails immediately instead ` +
        `of waiting, and the scan it belonged to is never recorded.`,
    );
  }
}

/**
 * Timestamps normalised to UTC, because runs are sorted by this string.
 *
 * Two runs written in two timezones sort by whichever offset they carried,
 * not by when they happened, and a history in the wrong order produces a diff
 * that reads backwards.
 */
function isoTime(value: string | undefined, field: string): string {
  if (value === undefined) return new Date().toISOString();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`${field} is not a date this can order: ${value}`);
  }
  return new Date(parsed).toISOString();
}

/**
 * The six provenance fields, and what a person is being told when one is
 * missing.
 *
 * The columns are NOT NULL in the DDL as well, and that is not a duplicate:
 * the DDL guards a *second writer* — an import tool, a repair script someone
 * runs at 2am — that never comes through this function. This list guards the
 * one caller that does, and it exists because leaving it to SQLite does not
 * work. `node:sqlite` refuses to bind `undefined` at all, so a missing field
 * arrives as
 *
 *     TypeError: Provided value cannot be bound to SQLite parameter 12.
 *
 * — a sentence about a parameter index, thrown before the constraint that
 * would have named the column ever runs. Measured on 2026-08-21, not assumed:
 * the first version of this guard was the NOT NULL columns alone, and that is
 * what came out.
 */
type ProvenanceField =
  | 'origin'
  | 'confidenceBasis'
  | 'egressClass'
  | 'observedAt'
  | 'engineRuleVersion'
  | 'userStatus';

const PROVENANCE_FIELDS: readonly { field: ProvenanceField; why: string }[] = [
  {
    field: 'origin',
    why:
      'Origin is how the claim came to exist — read out of pg_catalog, ' +
      'counted, sampled, or proposed because two names looked alike. Without ' +
      'it a Layer B guess and a Layer A count are the same row.',
  },
  {
    field: 'confidenceBasis',
    why:
      'Confidence asserts; the basis is the part a reader can argue with. A ' +
      'certainty with nothing underneath it is the one claim nobody can check.',
  },
  {
    field: 'egressClass',
    why:
      'It says how far this claim may travel. A claim with no class attached ' +
      'gets classified by whoever exports it next, which is exactly the ' +
      'decision that must not be made downstream.',
  },
  {
    field: 'observedAt',
    why:
      'A count is a statement about a database at a moment, and a scan is ' +
      'long enough for the database to move underneath it. The time the run ' +
      'started is not a substitute.',
  },
  {
    field: 'engineRuleVersion',
    why:
      'It is the only thing that lets a later diff tell your data changing ' +
      'from us having rewritten the rule.',
  },
  {
    field: 'userStatus',
    why:
      'Today the only honest value is `unreviewed`, and that is a fact about ' +
      'the claim rather than a placeholder: nobody has been asked yet, which ' +
      'is not the same as having agreed.',
  },
];

/**
 * Refuses a claim that does not say where it came from.
 *
 * Blank counts as missing, for the reason `saying()` in the contract gives:
 * a whitespace origin passes every presence check and means nothing, which is
 * the worst of both. No default is filled in — `unreviewed` looks like a safe
 * one and is not, because the day the product starts asking the question, a
 * default written here is indistinguishable from an answer somebody gave.
 */
function assertProvenance(finding: Finding, key: string): void {
  for (const { field, why } of PROVENANCE_FIELDS) {
    const value: unknown = finding[field];
    if (typeof value === 'string' && value.trim() !== '') continue;

    throw new Error(
      `Finding "${key}" arrived without a usable \`${field}\` (got ` +
        `${value === undefined ? 'nothing' : JSON.stringify(value)}). ${why} ` +
        `A claim in a history file is read on its own, long after the run ` +
        `that produced it is gone, so everything needed to weigh it has to be ` +
        `on the claim. Nothing was written.`,
    );
  }
}

/** Costs are integers in the schema; a float here would be rejected by STRICT. */
function wholeCost(cost: ScanCost): ScanCost {
  return {
    queries: Math.max(0, Math.round(cost.queries)),
    totalMs: Math.max(0, Math.round(cost.totalMs)),
    rowsScanned: Math.max(0, Math.round(cost.rowsScanned)),
  };
}

export class ScanStore {
  private constructor(
    private readonly db: DatabaseSync,
    /** Where this history lives, so a snapshot can say where it came from. */
    private readonly path: string,
  ) {}

  /**
   * Opens (or creates) a history file.
   *
   * `:memory:` is accepted and is what the tests use. Nothing here writes a
   * `.db` anywhere by itself — the caller names the file, so the caller is
   * the one who decides whether it lands somewhere that gets committed.
   */
  static open(path: string): ScanStore {
    const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
    try {
      // Before `applySchema`, which takes a write lock of its own the first
      // time a file is opened and would hit the same wall.
      waitForOtherWriters(db);
      applySchema(db);
    } catch (err) {
      db.close();
      throw err;
    }
    return new ScanStore(db, path);
  }

  /** A history that exists only for the length of a test. */
  static memory(): ScanStore {
    return ScanStore.open(':memory:');
  }

  close(): void {
    this.db.close();
  }

  /**
   * Every write in this file, wrapped so it lands whole or not at all.
   *
   * `BEGIN IMMEDIATE`, not `BEGIN`, and the difference is not stylistic. A
   * plain `BEGIN` starts a read transaction and only asks for the write lock
   * at the first statement that needs it. If another window took that lock in
   * between, SQLite will not wait — it returns `SQLITE_BUSY` at once and
   * skips the busy timeout entirely, on purpose, because two connections each
   * holding a read and each waiting to upgrade would wait on each other
   * forever. So the timeout set at open would have covered every write here
   * except `openRun`, which reads the database row before inserting the run
   * and is therefore the one transaction shaped like that deadlock.
   *
   * Measured, on this build: deferred `BEGIN` with a read first fails in 1ms
   * with a 1200ms timeout set; `BEGIN IMMEDIATE` waits the full 1200ms. The
   * timeout alone would have looked like a fix and left the most common write
   * in the product — starting a run — failing exactly as before.
   */
  private tx<T>(body: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = body();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The original failure is the one worth reporting.
      }
      throw err;
    }
  }

  // ---- writing -------------------------------------------------------------

  /**
   * Starts a run and returns its id.
   *
   * The run is written before the scan does anything, with `outcome` set to
   * `running`. A scan that dies halfway therefore leaves a row saying so,
   * rather than leaving nothing — and "nothing" would later read as "that
   * scan never happened", which is how a finding that was never re-checked
   * comes to look fixed.
   */
  openRun(input: OpenRunInput): number {
    const identity = input.database;
    const fingerprint = databaseFingerprint(identity);
    const label = (input.label ?? identity.database).trim();
    assertNoCredentials(label, 'label');
    if (label === '') {
      throw new Error('A database label cannot be empty.');
    }

    const scope = input.scope;

    if (scope.database !== identity.database) {
      throw new Error(
        `The scope manifest says the database is "${scope.database}" but the ` +
          `identity says "${identity.database}". One of them is about a ` +
          `different database, and storing either would attach this run to the ` +
          `wrong history.`,
      );
    }

    if (!Number.isInteger(scope.visibleTables) || scope.visibleTables < 0) {
      throw new Error(
        `visibleTables must be a whole number, got ${String(scope.visibleTables)}.`,
      );
    }

    // The single most important line in this file. `undefined` here would be
    // bound as NULL, which the schema reads as "nobody knows how many tables
    // exist" — a claim the caller did not make. Refuse instead of guessing,
    // in either direction: null is a real answer and must be passed on
    // purpose, and 0 is a real answer too.
    if (scope.totalTables === undefined) {
      throw new Error(
        `totalTables is undefined. Pass null if the total is genuinely ` +
          `unknown, or the number if it is known. Leaving it out would be ` +
          `stored as "unknown", which is a statement about scope that nobody ` +
          `made.`,
      );
    }
    if (
      scope.totalTables !== null &&
      (!Number.isInteger(scope.totalTables) || scope.totalTables < scope.visibleTables)
    ) {
      throw new Error(
        `totalTables (${String(scope.totalTables)}) is not a whole number at ` +
          `least as large as visibleTables (${scope.visibleTables}). The two ` +
          `denominators have probably been swapped.`,
      );
    }

    const startedAt = isoTime(input.startedAt, 'startedAt');
    const storeSamples = input.storeSamples === true;

    return this.tx(() => {
      const databaseId = this.upsertDatabase(fingerprint, label, startedAt);

      const inserted = this.db
        .prepare(
          `
          INSERT INTO run (
            database_id, started_at, finished_at, outcome, outcome_note,
            scope_database, scope_role, scope_schemas,
            scope_visible_tables, scope_total_tables, scope_granted_at,
            scope_read_only_enforced, scope_disclosure,
            samples_stored, lang
          ) VALUES (?, ?, NULL, 'running', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          databaseId,
          startedAt,
          scope.database,
          scope.role,
          JSON.stringify(scope.schemas),
          scope.visibleTables,
          scope.totalTables,
          scope.grantedAt,
          scope.readOnlyEnforcedByDatabase ? 1 : 0,
          scope.disclosure,
          storeSamples ? 1 : 0,
          input.lang ?? 'en',
        );

      return Number(inserted.lastInsertRowid);
    });
  }

  private upsertDatabase(fingerprint: string, label: string, seenAt: string): number {
    const existing = this.db
      .prepare(`SELECT id FROM scanned_database WHERE fingerprint = ?`)
      .get(fingerprint);

    if (existing !== undefined) {
      // The label is what a person calls it and they are allowed to change
      // their mind. The fingerprint is the identity and never moves.
      this.db
        .prepare(`UPDATE scanned_database SET label = ? WHERE fingerprint = ?`)
        .run(label, fingerprint);
      return int(existing, 'id');
    }

    const inserted = this.db
      .prepare(
        `INSERT INTO scanned_database (fingerprint, label, first_seen_at) VALUES (?, ?, ?)`,
      )
      .run(fingerprint, label, seenAt);
    return Number(inserted.lastInsertRowid);
  }

  /**
   * Attaches findings to a run. Safe to call more than once as a scan goes.
   *
   * Also records, for every rule that produced something, that the rule ran —
   * because a finding from a rule is proof the rule executed. The coverage
   * numbers are left NULL, since a per-finding coverage of "1 of 1" says
   * nothing about how much of the database that rule covered. Callers who
   * know the real numbers should say so with `recordRules`, which wins.
   *
   * A finding that cannot say where it came from is refused here, and the
   * whole batch rolls back with it — see `assertProvenance`. Refused rather
   * than stored with a default, because the default that looks safest
   * (`unreviewed`, `catalog`) is the one that would later be indistinguishable
   * from a real answer.
   */
  recordFindings(runId: number, findings: readonly Finding[]): void {
    const run = this.requireOpenRun(runId);
    const databaseId = int(run, 'database_id');
    const storeSamples = bool(run, 'samples_stored');

    this.tx(() => {
      for (const finding of findings) {
        this.insertFinding(runId, databaseId, finding, storeSamples);
        this.noteRuleRan(runId, finding.rule, finding.engineRuleVersion);
      }
    });
  }

  private insertFinding(
    runId: number,
    databaseId: number,
    finding: Finding,
    storeSamples: boolean,
  ): void {
    const key = findingKey(finding);
    assertProvenance(finding, key);
    const evidence: Evidence | null = finding.evidence;

    let sampleJson: string | null = null;
    if (evidence !== null && storeSamples && evidence.sample.length > 0) {
      assertSampleIsRedacted(evidence.sample, finding.id);
      sampleJson = JSON.stringify(evidence.sample);
    }

    const coverage: Coverage = finding.coverage;
    const boundary = finding.kind === 'negative' ? finding.boundary : null;

    try {
      this.db
        .prepare(
          `
          INSERT INTO finding (
            run_id, database_id, finding_key, structure_hash,
            rule, kind, confidence, severity, schema_name, table_name, columns_json,
            origin, confidence_basis, egress_class,
            observed_at, engine_rule_version, user_status,
            plain_text, technical, boundary,
            evidence_sql, evidence_row_count, evidence_sample_size,
            evidence_duration_ms, evidence_sample_json,
            coverage_checked, coverage_eligible, coverage_skipped_json,
            coverage_truncated_at,
            coverage_visible_to_role, coverage_verified, coverage_sampled,
            coverage_excluded
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
        )
        .run(
          runId,
          databaseId,
          key,
          structureHash(finding),
          finding.rule,
          finding.kind,
          finding.confidence,
          finding.severity,
          finding.schema,
          finding.table,
          JSON.stringify(finding.columns),
          // Checked by `assertProvenance` above, never defaulted here. A
          // default written at this line would be the store answering a
          // question the rule never answered.
          finding.origin,
          finding.confidenceBasis,
          finding.egressClass,
          finding.observedAt,
          finding.engineRuleVersion,
          finding.userStatus,
          finding.plainText,
          finding.technical,
          boundary,
          evidence === null ? null : evidence.sql,
          evidence === null ? null : evidence.rowCount,
          evidence === null ? null : evidence.sampleSize,
          evidence === null ? null : evidence.durationMs,
          sampleJson,
          coverage.checked,
          coverage.eligible,
          JSON.stringify(coverage.skipped),
          coverage.truncatedAt,
          coverage.visibleToRole,
          coverage.verified,
          coverage.sampled,
          coverage.excluded,
        );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('UNIQUE constraint failed')) {
        throw new Error(
          `Two findings in run ${runId} both claim the id "${key}". That id is ` +
            `what a later scan uses to recognise this finding again, so two ` +
            `findings sharing one would make every diff built on this history ` +
            `wrong. Give the rule a discriminator that is unique per target.`,
        );
      }
      throw err;
    }
  }

  private noteRuleRan(
    runId: number,
    rule: string,
    ruleVersion: string | null,
  ): void {
    this.db
      .prepare(
        `
        INSERT INTO run_rule (run_id, rule, ran, note, rule_version)
        VALUES (?, ?, 1, ?, ?)
        ON CONFLICT (run_id, rule) DO NOTHING
        `,
      )
      .run(
        runId,
        rule,
        'Ran — inferred from a finding it produced. Coverage was never declared.',
        // Debt N40. This row exists because a finding arrived for a rule
        // nobody declared coverage for, and that finding states the version it
        // was produced by. Taking it from there is reading, not inferring —
        // the alternative is a NULL beside a finding that is holding the
        // answer, which sends the diff looking for something it already has.
        ruleVersion,
      );
  }

  /**
   * Records what each rule was able to cover, including rules that found
   * nothing and rules that never got to run.
   *
   * This is the half of a run that has no findings in it and matters most.
   */
  recordRules(runId: number, rules: readonly RuleRun[]): void {
    this.requireOpenRun(runId);

    this.tx(() => {
      for (const entry of rules) {
        const coverage = entry.coverage;
        this.db
          .prepare(
            `
            INSERT INTO run_rule (
              run_id, rule, ran, checked, eligible, skipped, truncated_at, note,
              rule_version, visible_to_role, verified, sampled, excluded
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (run_id, rule) DO UPDATE SET
              ran             = excluded.ran,
              checked         = excluded.checked,
              eligible        = excluded.eligible,
              skipped         = excluded.skipped,
              truncated_at    = excluded.truncated_at,
              note            = excluded.note,
              rule_version    = excluded.rule_version,
              visible_to_role = excluded.visible_to_role,
              verified        = excluded.verified,
              sampled         = excluded.sampled,
              excluded        = excluded.excluded
            `,
          )
          .run(
            runId,
            entry.rule,
            entry.ran ? 1 : 0,
            coverage === undefined ? null : coverage.checked,
            coverage === undefined ? null : coverage.eligible,
            coverage === undefined ? null : coverage.skipped.length,
            coverage === undefined ? null : coverage.truncatedAt,
            entry.note ?? null,
            // Debt N40. Never defaulted and never inferred: a rule that did
            // not state its version stores NULL, and the diff says
            // `rule-version-unknown`, which is true. Filling it in from
            // another rule in the same package would be a fabricated
            // measurement wearing the shape of an answer.
            entry.ruleVersion ?? null,
            coverage === undefined ? null : coverage.visibleToRole,
            coverage === undefined ? null : coverage.verified,
            coverage === undefined ? null : coverage.sampled,
            coverage === undefined ? null : coverage.excluded,
          );
      }
    });
  }

  /**
   * Closes a run with how it ended and what it cost.
   *
   * Refuses to close a run twice. Overwriting an outcome would let a retry
   * quietly relabel a failed scan as a clean one, and the whole point of
   * keeping history is that it cannot be edited into a more comfortable
   * shape after the fact.
   */
  finishRun(runId: number, input: FinishRunInput): void {
    const run = this.requireOpenRun(runId);
    const startedAt = text(run, 'started_at');
    const finishedAt = isoTime(input.finishedAt, 'finishedAt');

    if (finishedAt < startedAt) {
      throw new Error(
        `Run ${runId} would finish (${finishedAt}) before it started ` +
          `(${startedAt}).`,
      );
    }

    if (input.outcome !== 'completed' && (input.note ?? '').trim() === '') {
      throw new Error(
        `Run ${runId} ended as "${input.outcome}" with no note. A run that did ` +
          `not complete is a hole in the history, and a hole with no reason ` +
          `attached cannot be told apart from one nobody noticed.`,
      );
    }

    const cost = wholeCost(input.cost);
    const truncationNote = input.truncationNote ?? null;

    this.db
      .prepare(
        `
        UPDATE run SET
          finished_at       = ?,
          outcome           = ?,
          outcome_note      = ?,
          cost_queries      = ?,
          cost_total_ms     = ?,
          cost_rows_scanned = ?,
          cost_truncated    = ?,
          truncation_note   = ?
        WHERE id = ?
        `,
      )
      .run(
        finishedAt,
        input.outcome,
        input.note ?? null,
        cost.queries,
        cost.totalMs,
        cost.rowsScanned,
        truncationNote === null ? 0 : 1,
        truncationNote,
        runId,
      );
  }

  private requireOpenRun(runId: number): Row {
    const row = this.db.prepare(`SELECT * FROM run WHERE id = ?`).get(runId);
    if (row === undefined) {
      throw new Error(`There is no run ${runId} in this history.`);
    }
    if (text(row, 'outcome') !== 'running') {
      throw new Error(
        `Run ${runId} already ended as "${text(row, 'outcome')}". A finished ` +
          `run is a record of what was true at a moment, and rewriting it ` +
          `would make every diff drawn against it a claim about a past that ` +
          `no longer matches.`,
      );
    }
    return row;
  }

  // ---- reading -------------------------------------------------------------

  /** Every run against one database, newest first. */
  runsFor(database: DatabaseIdentity | string, limit = 50): RunSummary[] {
    const fingerprint =
      typeof database === 'string' ? database : databaseFingerprint(database);

    const rows = this.db
      .prepare(
        `${RUN_SELECT} WHERE d.fingerprint = ?
         ORDER BY run.started_at DESC, run.id DESC
         LIMIT ?`,
      )
      .all(fingerprint, limit);

    return rows.map((row) => toRunSummary(row));
  }

  /**
   * Every run in the file, newest first, whichever database it belongs to.
   *
   * The mirror of `RetiredHistoryReader.runs`, and added for the same caller:
   * a diff assembling one timeline across several history files has to ask
   * each of them "what is in here" before it knows which database it is
   * being asked about. Without this the live store was the only source that
   * could not answer, and the caller walked run ids upward until they ran
   * out — which silently stops at the first gap wide enough to look like the
   * end of the file.
   */
  everyRun(limit = 200): RunSummary[] {
    return this.db
      .prepare(`${RUN_SELECT} ORDER BY run.started_at DESC, run.id DESC LIMIT ?`)
      .all(limit)
      .map((row) => toRunSummary(row));
  }

  runById(runId: number): RunSummary | null {
    const row = this.db.prepare(`${RUN_SELECT} WHERE run.id = ?`).get(runId);
    return row === undefined ? null : toRunSummary(row);
  }

  findingsOf(runId: number): StoredFinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM finding WHERE run_id = ? ORDER BY id`)
      .all(runId);
    return rows.map((row) => toStoredFinding(row));
  }

  rulesOf(runId: number): RuleRun[] {
    return this.db
      .prepare(`SELECT * FROM run_rule WHERE run_id = ? ORDER BY rule`)
      .all(runId)
      .map((row) => toRuleRun(row));
  }

  /**
   * Everything one run recorded, in the shape a diff takes.
   *
   * The same shape `legacy.ts` produces from a retired file, and that is the
   * point: a diff's two sides can come from two different schema versions
   * without the diff itself knowing which. What the older file could not
   * record is on `source`, said once, rather than inferred from missing
   * values at every place that reads one.
   */
  snapshotOf(runId: number): RunSnapshot | null {
    return readRunSnapshot(this.db, runId, {
      path: this.path,
      schemaVersion: SCHEMA_VERSION,
      recordsEngineVersion: true,
      comparableStructureHash: true,
    });
  }

  /**
   * One finding, across every run it appeared in — newest first.
   *
   * This is the read a diff is built out of. A gap in the returned list is
   * not proof the finding was absent from those runs: pair it with
   * `rulesOf(runId)` to tell "the rule ran and found nothing" apart from
   * "the rule never ran".
   *
   * `engineRuleVersion` comes back beside `structureHash` and is not optional
   * reading: a hash that moved while the version also moved is a rule we
   * rewrote, and a diff that looks only at the hash will report it as a change
   * in the customer's database. See `structureHash` for why it is beside the
   * hash rather than inside it.
   */
  historyOf(
    database: DatabaseIdentity | string,
    key: string,
    limit = 50,
  ): FindingHistoryEntry[] {
    const fingerprint =
      typeof database === 'string' ? database : databaseFingerprint(database);

    const rows = this.db
      .prepare(
        `
        SELECT run.id AS run_id, run.started_at, run.outcome,
               f.finding_key, f.structure_hash, f.severity, f.confidence,
               f.evidence_row_count,
               f.origin, f.confidence_basis, f.egress_class,
               f.observed_at, f.engine_rule_version, f.user_status
        FROM finding f
        JOIN run ON run.id = f.run_id
        JOIN scanned_database d ON d.id = f.database_id
        WHERE d.fingerprint = ? AND f.finding_key = ?
        ORDER BY run.started_at DESC, run.id DESC
        LIMIT ?
        `,
      )
      .all(fingerprint, key, limit);

    return rows.map((row) => ({
      runId: int(row, 'run_id'),
      startedAt: text(row, 'started_at'),
      outcome: text(row, 'outcome') as RunOutcome,
      findingKey: text(row, 'finding_key'),
      structureHash: text(row, 'structure_hash'),
      severity: text(row, 'severity'),
      confidence: text(row, 'confidence'),
      measuredRows: intOrNull(row, 'evidence_row_count'),
      origin: text(row, 'origin'),
      confidenceBasis: text(row, 'confidence_basis'),
      egressClass: text(row, 'egress_class'),
      observedAt: text(row, 'observed_at'),
      // Beside `structureHash`, not inside it. Two rows whose hashes differ
      // and whose versions also differ are a rule we rewrote; blaming that on
      // the database is the mistake this column exists to make avoidable.
      engineRuleVersion: text(row, 'engine_rule_version'),
      userStatus: text(row, 'user_status'),
    }));
  }
}

function toStoredFinding(row: Row): StoredFinding {
  const sql = textOrNull(row, 'evidence_sql');
  const sampleJson = textOrNull(row, 'evidence_sample_json');

  const evidence: Evidence | null =
    sql === null
      ? null
      : {
          sql,
          rowCount: int(row, 'evidence_row_count'),
          sampleSize: intOrNull(row, 'evidence_sample_size'),
          durationMs: real(row, 'evidence_duration_ms'),
          sample:
            sampleJson === null
              ? []
              : json<Record<string, unknown>[]>(sampleJson, 'evidence_sample_json'),
        };

  const coverage: Coverage = {
    checked: int(row, 'coverage_checked'),
    // `intOrNull` on all four, and never coalesced to 0. A stored NULL means
    // the rule did not separate these; reading it back as a zero would turn
    // "did not say" into "none", which is the substitution this whole column
    // family exists to keep out of the record.
    visibleToRole: intOrNull(row, 'coverage_visible_to_role'),
    verified: intOrNull(row, 'coverage_verified'),
    sampled: intOrNull(row, 'coverage_sampled'),
    excluded: intOrNull(row, 'coverage_excluded'),
    // `intOrNull`, not `int`. A stored NULL means the rule did not know its
    // denominator, and reading that back as 0 would turn "I could not tell
    // how many applied" into "none applied" on the way out of the file.
    eligible: intOrNull(row, 'coverage_eligible'),
    skipped: json<{ target: string; reason: string }[]>(
      text(row, 'coverage_skipped_json'),
      'coverage_skipped_json',
    ),
    truncatedAt: intOrNull(row, 'coverage_truncated_at'),
  };

  const common = {
    id: text(row, 'finding_key'),
    rule: text(row, 'rule'),
    confidence: text(row, 'confidence'),
    severity: text(row, 'severity'),
    // Read back as written, not re-validated. This package holds no runtime
    // dependency on `@ledar/contracts` — a scan history has to be readable on
    // a machine where nothing else is installed — so a value outside the
    // vocabulary is caught by `sealFindings`, which every consumer of these
    // rows goes through before it publishes or exports them.
    origin: text(row, 'origin'),
    confidenceBasis: text(row, 'confidence_basis'),
    egressClass: text(row, 'egress_class'),
    observedAt: text(row, 'observed_at'),
    engineRuleVersion: text(row, 'engine_rule_version'),
    userStatus: text(row, 'user_status'),
    schema: text(row, 'schema_name'),
    table: text(row, 'table_name'),
    columns: json<string[]>(text(row, 'columns_json'), 'columns_json'),
    plainText: text(row, 'plain_text'),
    technical: text(row, 'technical'),
    evidence,
    coverage,
  } as const;

  const kind = text(row, 'kind');
  const boundary = textOrNull(row, 'boundary');

  // The cast below is unavoidable — a discriminated union cannot be built
  // from a string the compiler has never seen — so the string is checked
  // first. Without this, a row written by a future build with a fifth claim
  // kind would come back typed as one of the four and be read as such.
  if (!KNOWN_KINDS.has(kind)) {
    throw new Error(
      `Finding "${text(row, 'finding_key')}" has claim kind "${kind}", which ` +
        `this build does not know. It was probably written by a newer ` +
        `version; reading it as one of the kinds we do know would be a ` +
        `guess about how strongly it was meant to be stated.`,
    );
  }

  const finding = (
    kind === 'negative'
      ? { ...common, kind, boundary }
      : { ...common, kind }
  ) as unknown as Finding;

  return {
    runId: int(row, 'run_id'),
    findingKey: text(row, 'finding_key'),
    structureHash: text(row, 'structure_hash'),
    finding,
  };
}
