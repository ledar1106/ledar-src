/**
 * Reading — and only reading — a history file this build refuses to write to.
 *
 * `openHistory` moves an unreadable history aside and starts a new one, whole
 * and byte-for-byte, under a name that says what it is. That was the right
 * half of the problem to solve first: nothing is lost. But nothing is *read*
 * either, and on the machine this was written on that means eleven runs of
 * real history sitting one directory away from a diff that reports "there is
 * only one run; there is nothing to compare".
 *
 * So this opens them. Three constraints, and each one is load-bearing:
 *
 * ① **Read-only, enforced by SQLite, not by care.** The connection is opened
 *    with `readOnly: true`, so a write is an error from the driver rather
 *    than a mistake this module has to remember not to make. `applySchema` is
 *    never called — it is the thing that would take a write lock and stamp a
 *    new schema onto a file whose whole value is that it was left alone.
 *
 * ② **No migration, and no migration in disguise.** Nothing here fills in the
 *    six provenance columns that schema 1 does not have. `RecordedFinding`
 *    carries `engineRuleVersion: string | null` precisely so that a reader
 *    can say *this file cannot tell you* instead of inventing a version
 *    string that compares equal to something. Writing `origin: 'catalog'`
 *    into a claim recorded before the rule knew its own origin would be a
 *    fabricated measurement, which is what `retire.ts` refused and why.
 *
 * ③ **Every column it needs is checked by name at open time.** The three
 *    tables a snapshot reads happen to be identical in shape across schemas
 *    1, 2 and 3 — measured, not assumed — and `engine_rule_version` is the
 *    single column whose absence is expected. Anything else missing means
 *    this reader is looking at a file shaped in a way it has never seen, and
 *    it says which column rather than failing later inside a row mapper with
 *    "Column started_at should be text, got undefined".
 */

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, readSchemaVersion } from './schema.js';
import { RUN_SELECT, readRunSnapshot, toRunSummary } from './snapshot.js';
import type { RunSnapshot, RunSummary, SnapshotSource } from './types.js';

/**
 * The columns a snapshot reads, per table.
 *
 * `engine_rule_version` is deliberately absent from this list: schema 1 does
 * not have it, and `absentOrText` reads it as null there. Everything that IS
 * here is required, and a file missing any of it is refused by name.
 */
const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  scanned_database: ['id', 'fingerprint', 'label'],
  run: [
    'id',
    'database_id',
    'started_at',
    'finished_at',
    'outcome',
    'outcome_note',
    'scope_database',
    'scope_role',
    'scope_schemas',
    'scope_visible_tables',
    'scope_total_tables',
    'scope_granted_at',
    'scope_read_only_enforced',
    'scope_disclosure',
    'cost_queries',
    'cost_total_ms',
    'cost_rows_scanned',
    'cost_truncated',
    'truncation_note',
    'samples_stored',
  ],
  finding: [
    'run_id',
    'finding_key',
    'structure_hash',
    'rule',
    'kind',
    'severity',
    'confidence',
    'evidence_row_count',
  ],
  run_rule: ['run_id', 'rule', 'ran', 'checked', 'eligible', 'skipped', 'truncated_at', 'note'],
};

/**
 * The first schema that recorded which rule version produced a claim.
 *
 * Named rather than spelled `>= 2` at each use. The number means something —
 * it is the version where the six provenance columns arrived — and a bare 2
 * in a comparison is a number nobody can check against anything.
 */
const FIRST_VERSION_WITH_PROVENANCE = 2;

/**
 * The first schema whose `structure_hash` means what this build means by it.
 *
 * The same number as `FIRST_VERSION_WITH_PROVENANCE`, and not a duplicate of
 * it. `structureHash` hashes `origin` and `confidenceBasis`, so the arrival of
 * those two columns silently changed the recipe — the hash moved for every
 * finding, including ones on a database that holds no rows and cannot change.
 * They share a value because the same schema bump caused both, and they are
 * two constants because the next bump will not necessarily move both.
 */
const FIRST_VERSION_WITH_COMPARABLE_HASH = 2;

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  // `pragma_table_info` as a table-valued function rather than the `PRAGMA`
  // statement, so the table name is a bound parameter and not spliced into
  // SQL. Same reason as everywhere else in this codebase; see check-sql.py.
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table) as { name: unknown }[];
  return new Set(rows.map((r) => String(r.name)));
}

/**
 * A retired history file, opened for reading and nothing else.
 *
 * `close()` is the caller's job. There is no finaliser: a SQLite handle left
 * open on Windows keeps a lock on the file, and the one thing worse than not
 * reading a retired history is holding it hostage.
 */
export class RetiredHistoryReader {
  private constructor(
    private readonly db: DatabaseSync,
    readonly source: SnapshotSource,
  ) {}

  /**
   * Opens a retired history file.
   *
   * Refuses, by name and with a reason:
   *   - a path that does not exist (opening read-only would create nothing,
   *     but SQLite's error for it says less than this does)
   *   - a file that is not a LEDAR history
   *   - a file at the *current* schema version, which belongs to `ScanStore`
   *   - a file from a newer build than this one
   *   - a file missing a column a snapshot reads
   */
  static open(path: string): RetiredHistoryReader {
    if (!existsSync(path)) {
      throw new Error(
        `There is no history file at ${path}. A retired history is one this ` +
          `build moved aside — look for a name like history.v1.db next to the ` +
          `history you are using.`,
      );
    }

    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, { readOnly: true });
    } catch (err) {
      throw new Error(
        `${path} could not be opened for reading as a SQLite database: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const version = readSchemaVersion(db);
      if (version === null) {
        throw new Error(
          `${path} is not a LEDAR history: it has no store_meta table saying ` +
            `which schema wrote it. Refusing to guess at its shape.`,
        );
      }
      if (version === SCHEMA_VERSION) {
        throw new Error(
          `${path} was written by schema version ${version}, which is the one ` +
            `this build speaks. Open it with ScanStore, which can read and ` +
            `write it, instead of this reader, which only reads.`,
        );
      }
      if (version > SCHEMA_VERSION) {
        throw new Error(
          `${path} was written by schema version ${version}; this build ` +
            `speaks version ${SCHEMA_VERSION}. A newer file may hold columns ` +
            `whose meaning this build has never seen, and reading it as if it ` +
            `were older would put those meanings into a diff silently.`,
        );
      }

      for (const [table, needed] of Object.entries(REQUIRED)) {
        const present = columnsOf(db, table);
        if (present.size === 0) {
          throw new Error(
            `${path} is a schema-${version} history with no ${table} table. ` +
              `This reader knows schema 1 and 2, and both of them have one.`,
          );
        }
        const missing = needed.filter((c) => !present.has(c));
        if (missing.length > 0) {
          throw new Error(
            `${path} is a schema-${version} history whose ${table} table is ` +
              `missing ${missing.join(', ')}. This reader was written against ` +
              `schemas 1 and 2, which both have those columns; refusing to ` +
              `read a shape it has not seen rather than misreading it.`,
          );
        }
      }

      return new RetiredHistoryReader(db, {
        path,
        schemaVersion: version,
        recordsEngineVersion: version >= FIRST_VERSION_WITH_PROVENANCE,
        comparableStructureHash: version >= FIRST_VERSION_WITH_COMPARABLE_HASH,
      });
    } catch (err) {
      db.close();
      throw err;
    }
  }

  /** Every run in the file, newest first. */
  runs(limit = 50): RunSummary[] {
    return this.db
      .prepare(`${RUN_SELECT} ORDER BY run.started_at DESC, run.id DESC LIMIT ?`)
      .all(limit)
      .map((row) => toRunSummary(row));
  }

  /** Every run against one database, newest first. */
  runsFor(fingerprint: string, limit = 50): RunSummary[] {
    return this.db
      .prepare(
        `${RUN_SELECT} WHERE d.fingerprint = ?
         ORDER BY run.started_at DESC, run.id DESC
         LIMIT ?`,
      )
      .all(fingerprint, limit)
      .map((row) => toRunSummary(row));
  }

  snapshotOf(runId: number): RunSnapshot | null {
    return readRunSnapshot(this.db, runId, this.source);
  }

  close(): void {
    this.db.close();
  }
}
