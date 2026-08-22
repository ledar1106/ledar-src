/**
 * Building a history file in a schema this build no longer writes.
 *
 * The diff slice has to read schema-1 and schema-2 history files, and the
 * only two that exist in the world are on the machine where they were made.
 * A test that reads those would pass there and skip everywhere else, and this
 * repository treats a skip as a missing measurement rather than a pass.
 *
 * So the schemas themselves are captured instead. `legacy/schema-1.sql` and
 * `legacy/schema-2.sql` are `sqlite_master` dumped straight out of the real
 * retired files — not a reconstruction from memory, not a hand-typed subset.
 * A test builds a file from one of them and gets the shape the reader will
 * actually meet in the field, on any machine, with no container running.
 *
 * The one thing this cannot capture is a schema-1 `structure_hash` computed
 * by the code that was running at the time, because that code is gone. Tests
 * that care about the hash recipe having changed supply the two hashes
 * directly — the real measured pair is quoted in `store/test/legacy.test.ts`.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = join(HERE, '..', 'legacy');

/** The schema versions there are captured DDL files for. */
export type LegacySchemaVersion = 1 | 2;

export type LegacyFinding = {
  findingKey: string;
  rule: string;
  structureHash?: string;
  kind?: string;
  confidence?: string;
  severity?: string;
  schema?: string;
  table?: string;
  columns?: string[];
  rowCount?: number | null;
  /** Ignored when the file is schema 1, which has no column for it. */
  engineRuleVersion?: string;
};

export type LegacyRule = {
  rule: string;
  ran?: boolean;
  checked?: number | null;
  eligible?: number | null;
  skipped?: number | null;
  note?: string | null;
};

export type LegacyRun = {
  runId: number;
  startedAt: string;
  outcome?: 'running' | 'completed' | 'failed' | 'refused';
  outcomeNote?: string | null;
  label?: string;
  fingerprint?: string;
  role?: string;
  schemas?: string[];
  visibleTables?: number;
  totalTables?: number | null;
  costTruncated?: boolean;
  truncationNote?: string | null;
  findings?: LegacyFinding[];
  rules?: LegacyRule[];
};

/** The fingerprint used when a run does not name one. Any 64 hex chars will do. */
export const FIXTURE_FINGERPRINT = 'f'.repeat(64);

/**
 * Writes a history file at `path` in the given legacy schema version.
 *
 * Returns `path`, so a test can inline it. Nothing here goes near the real
 * `%LOCALAPPDATA%\ledar` directory — the caller supplies a path, and every
 * caller in this repository supplies one under `mkdtemp`.
 */
export function writeLegacyHistory(
  path: string,
  version: LegacySchemaVersion,
  runs: readonly LegacyRun[],
): string {
  const ddl = readFileSync(join(SQL_DIR, `schema-${version}.sql`), 'utf8');
  const db = new DatabaseSync(path);
  try {
    // The captured dump is one `CREATE` per statement, separated by blank
    // lines. `exec` takes the lot; splitting it would only add a way to get
    // the splitting wrong.
    db.exec(ddl);
    db.prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?)`).run(
      'schema_version',
      String(version),
    );
    db.prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?)`).run(
      'created_at',
      '2026-01-01T00:00:00.000Z',
    );

    const databaseIds = new Map<string, number>();
    const databaseFor = (fingerprint: string, label: string, at: string): number => {
      const known = databaseIds.get(fingerprint);
      if (known !== undefined) return known;
      const id = databaseIds.size + 1;
      db.prepare(
        `INSERT INTO scanned_database (id, fingerprint, label, first_seen_at)
         VALUES (?, ?, ?, ?)`,
      ).run(id, fingerprint, label, at);
      databaseIds.set(fingerprint, id);
      return id;
    };

    for (const run of runs) {
      const fingerprint = run.fingerprint ?? FIXTURE_FINGERPRINT;
      const label = run.label ?? 'fixture';
      const databaseId = databaseFor(fingerprint, label, run.startedAt);

      db.prepare(
        `INSERT INTO run (
           id, database_id, started_at, finished_at, outcome, outcome_note,
           scope_database, scope_role, scope_schemas, scope_visible_tables,
           scope_total_tables, scope_granted_at, scope_read_only_enforced,
           scope_disclosure, cost_queries, cost_total_ms, cost_rows_scanned,
           cost_truncated, truncation_note, samples_stored
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        run.runId,
        databaseId,
        run.startedAt,
        // `CHECK ((outcome = 'running') = (finished_at IS NULL))` in the real
        // schema. A run still in flight has not finished, and the file will
        // not hold a row that says otherwise.
        (run.outcome ?? 'completed') === 'running' ? null : run.startedAt,
        run.outcome ?? 'completed',
        run.outcomeNote ?? null,
        label,
        run.role ?? 'ledar_reader',
        JSON.stringify(run.schemas ?? ['public']),
        run.visibleTables ?? 10,
        run.totalTables === undefined ? 10 : run.totalTables,
        null,
        1,
        null,
        1,
        1,
        0,
        run.costTruncated === true ? 1 : 0,
        run.truncationNote ?? null,
        0,
      );

      // Two whole statements rather than one built from a column list.
      // `check-sql.py` refuses a template literal that splices anything into
      // SQL, and it is right to: the exception this would need is one nobody
      // could check by reading it, and a gate with exceptions in it is a gate
      // people learn to argue with. Six columns of duplication is cheaper.
      const insertFinding =
        version >= 2
          ? db.prepare(
              `INSERT INTO finding (
                 run_id, database_id, finding_key, structure_hash, rule, kind,
                 confidence, severity, schema_name, table_name, columns_json,
                 origin, confidence_basis, egress_class, observed_at,
                 engine_rule_version, user_status, plain_text, technical,
                 boundary, evidence_sql, evidence_row_count,
                 evidence_sample_size, evidence_duration_ms,
                 evidence_sample_json, coverage_checked, coverage_eligible,
                 coverage_skipped_json, coverage_truncated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
          : db.prepare(
              `INSERT INTO finding (
                 run_id, database_id, finding_key, structure_hash, rule, kind,
                 confidence, severity, schema_name, table_name, columns_json,
                 plain_text, technical, boundary, evidence_sql,
                 evidence_row_count, evidence_sample_size,
                 evidence_duration_ms, evidence_sample_json, coverage_checked,
                 coverage_eligible, coverage_skipped_json,
                 coverage_truncated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                         ?, ?, ?, ?, ?)`,
            );

      for (const f of run.findings ?? []) {
        const kind = f.kind ?? 'observation';
        // `CHECK ((evidence_sql IS NULL) = (evidence_row_count IS NULL))`.
        // The two travel together or not at all: a row count with no query
        // behind it is a number nobody measured, which is the fault this
        // codebase spends most of its effort refusing to commit.
        const rows = f.rowCount === undefined ? 1 : f.rowCount;
        const head = [
          run.runId,
          databaseId,
          f.findingKey,
          f.structureHash ?? `hash-${f.findingKey}`,
          f.rule,
          kind,
          f.confidence ?? 'certain',
          f.severity ?? 'high',
          f.schema ?? 'public',
          f.table ?? 'fixture_table',
          JSON.stringify(f.columns ?? ['fixture_column']),
        ];
        const provenance =
          version >= 2
            ? [
                'catalog',
                'database_constraint',
                'customer-system-metadata',
                run.startedAt,
                f.engineRuleVersion ?? 'layer-a@1.0.0',
                'unreviewed',
              ]
            : [];
        const tail = [
          'A fixture finding.',
          'fixture technical detail',
          // `CHECK ((kind = 'negative') = (boundary IS NOT NULL))`.
          kind === 'negative' ? 'What this run did not look at.' : null,
          rows === null ? null : 'SELECT 1',
          rows,
          null,
          rows === null ? null : 1.0,
          null,
          1,
          1,
          '[]',
          null,
        ];
        insertFinding.run(...head, ...provenance, ...tail);
      }

      for (const r of run.rules ?? []) {
        db.prepare(
          `INSERT INTO run_rule (run_id, rule, ran, checked, eligible, skipped,
                                 truncated_at, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          run.runId,
          r.rule,
          r.ran === false ? 0 : 1,
          r.checked === undefined ? null : r.checked,
          r.eligible === undefined ? null : r.eligible,
          r.skipped === undefined ? null : r.skipped,
          null,
          r.note ?? null,
        );
      }
    }
  } finally {
    db.close();
  }
  return path;
}
