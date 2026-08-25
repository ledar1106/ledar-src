/**
 * Turning rows into one shape, whichever history file they came out of.
 *
 * A diff has two sides, and there is no rule that both sides were written by
 * the same build. The older one is frequently a file this build refuses to
 * *write* to — schema 1 or 2, moved aside by `openHistory` — and the whole
 * value of reading it is lost if it arrives in a different shape than the
 * live side, because then every comparison has two code paths and only one of
 * them gets exercised by the tests.
 *
 * So: one row-mapper, used by `ScanStore` and by `legacy.ts` alike. The only
 * thing that varies between schema versions is whether the six provenance
 * columns exist, and that variation is handled in exactly one place —
 * `absentOrText` in `rows.ts` — rather than by two readers that agree today.
 */

import type { DatabaseSync } from 'node:sqlite';

import { absentOrText, bool, int, intOrNull, json, text, textOrNull } from './rows.js';
import type { Row } from './rows.js';
import type {
  LlmCallOutcome,
  LlmCallRow,
  RecordedFinding,
  RunOutcome,
  RunSnapshot,
  RunSummary,
  RuleRun,
  SnapshotSource,
} from './types.js';
import { isLang } from '@ledar/contracts';
import type { Lang } from '@ledar/contracts';

/**
 * The run row plus the two things that are never on it.
 *
 * `finding_count` is counted rather than stored: a stored count is a second
 * copy of a number the `finding` table already holds, and the day they
 * disagree the stored one wins silently.
 */
export const RUN_SELECT = `
  SELECT run.*, d.fingerprint AS fingerprint, d.label AS label,
         (SELECT count(*) FROM finding WHERE finding.run_id = run.id) AS finding_count
  FROM run
  JOIN scanned_database d ON d.id = run.database_id
`;

export function toRunSummary(row: Row): RunSummary {
  // Debt N44, read defensively for the same reason `rule_version` is: this
  // function also runs over retired schema-1, -2 and -3 files, which have no
  // such column. Absent reads as null — "this file does not say" — never as
  // 'en', which would be a guess dressed as a record.
  const langRaw = 'lang' in row ? textOrNull(row, 'lang') : null;
  const lang: Lang | null = langRaw !== null && isLang(langRaw) ? langRaw : null;
  return {
    lang,
    runId: int(row, 'id'),
    databaseId: int(row, 'database_id'),
    fingerprint: text(row, 'fingerprint'),
    label: text(row, 'label'),
    startedAt: text(row, 'started_at'),
    finishedAt: textOrNull(row, 'finished_at'),
    outcome: text(row, 'outcome') as RunOutcome,
    outcomeNote: textOrNull(row, 'outcome_note'),
    scope: {
      database: text(row, 'scope_database'),
      role: text(row, 'scope_role'),
      schemas: json<string[]>(text(row, 'scope_schemas'), 'scope_schemas'),
      visibleTables: int(row, 'scope_visible_tables'),
      // Stays null. Turning it into 0 here is the one-line version of the
      // bug this whole package is trying not to have.
      totalTables: intOrNull(row, 'scope_total_tables'),
      grantedAt: textOrNull(row, 'scope_granted_at'),
      readOnlyEnforcedByDatabase: bool(row, 'scope_read_only_enforced'),
      disclosure: textOrNull(row, 'scope_disclosure'),
    },
    cost: {
      queries: int(row, 'cost_queries'),
      totalMs: int(row, 'cost_total_ms'),
      rowsScanned: int(row, 'cost_rows_scanned'),
    },
    costTruncated: bool(row, 'cost_truncated'),
    truncationNote: textOrNull(row, 'truncation_note'),
    samplesStored: bool(row, 'samples_stored'),
    findingCount: int(row, 'finding_count'),
  };
}

/**
 * One finding, reduced to what a diff compares.
 *
 * Deliberately not `toStoredFinding`. That one rebuilds a whole `Finding`,
 * which cannot be done from a schema-1 row at all — six of its fields are
 * NOT NULL in the contract and absent from the file — and a diff does not
 * need the plain-language sentence or the evidence sample to tell whether a
 * finding moved. Reading less is what makes the old files readable honestly.
 */
export function toRecordedFinding(row: Row): RecordedFinding {
  return {
    runId: int(row, 'run_id'),
    findingKey: text(row, 'finding_key'),
    structureHash: text(row, 'structure_hash'),
    rule: text(row, 'rule'),
    kind: text(row, 'kind'),
    severity: text(row, 'severity'),
    confidence: text(row, 'confidence'),
    measuredRows: intOrNull(row, 'evidence_row_count'),
    // The one column whose absence is meaningful rather than accidental.
    engineRuleVersion: absentOrText(row, 'engine_rule_version'),
  };
}

/**
 * What a rule covered, or the fact that it declared nothing.
 *
 * Identical to `ScanStore.rulesOf`'s mapping, and shared with it, because a
 * disappeared finding is judged against this on both sides of a diff. Two
 * mappings that round `checked` differently would decide "fixed" versus "not
 * looked at" differently depending on which file the run came from.
 */
/**
 * One `llm_call` row, as it comes back out — HS-D D.4.
 *
 * Beside `toRuleRun` rather than inside `store.ts` for the reason that one is
 * here: a second mapping of the same table, written later by whoever needed to
 * read it from somewhere else, is how two readers come to disagree about what
 * a null meant.
 */
export function toLlmCall(row: Row): LlmCallRow {
  return {
    id: int(row, 'id'),
    runId: intOrNull(row, 'run_id'),
    at: text(row, 'at'),
    tier: text(row, 'tier'),
    model: text(row, 'model'),
    outcome: text(row, 'outcome') as LlmCallOutcome,
    cacheHit: bool(row, 'cache_hit'),
    // `intOrNull`, never `int`. Reading an absent token count as 0 here would
    // undo in one line the distinction the whole table is shaped to keep.
    promptTokens: intOrNull(row, 'prompt_tokens'),
    completionTokens: intOrNull(row, 'completion_tokens'),
    costMicros: intOrNull(row, 'cost_micros'),
    priceBasis: textOrNull(row, 'price_basis'),
    note: textOrNull(row, 'note'),
  };
}

export function toRuleRun(row: Row): RuleRun {
  const checked = intOrNull(row, 'checked');
  const eligible = intOrNull(row, 'eligible');
  const skipped = intOrNull(row, 'skipped');
  const entry: RuleRun = {
    rule: text(row, 'rule'),
    ran: bool(row, 'ran'),
    note: textOrNull(row, 'note'),
  };
  // Debt N40. Absent from schemas 1-3, which is why this is read defensively
  // rather than with `textOrNull` straight: the retired-history reader runs
  // this same function over files that have no such column.
  const version = 'rule_version' in row ? textOrNull(row, 'rule_version') : null;
  if (version !== null) entry.ruleVersion = version;
  // Coverage is only reconstructed when it was actually declared. The
  // skipped *targets* are not kept here — only how many there were — so
  // the array is empty and `checked`/`eligible` carry the meaning.
  if (checked !== null && eligible !== null) {
    entry.coverage = {
      checked,
      eligible,
      skipped: [],
      truncatedAt: intOrNull(row, 'truncated_at'),
      // Debt N1, and read the same defensive way: a schema-1 or schema-2 file
      // has none of these columns, and a reader that assumed them would throw
      // on exactly the histories the retirement path exists to keep readable.
      visibleToRole: 'visible_to_role' in row ? intOrNull(row, 'visible_to_role') : null,
      verified: 'verified' in row ? intOrNull(row, 'verified') : null,
      sampled: 'sampled' in row ? intOrNull(row, 'sampled') : null,
      excluded: 'excluded' in row ? intOrNull(row, 'excluded') : null,
    };
    if (skipped !== null && skipped > 0) {
      const said = `${skipped} targets were skipped; the reasons are on the findings.`;
      entry.note = entry.note === null ? said : `${entry.note} ${said}`;
    }
  }
  return entry;
}

/**
 * Everything about one run, gathered into the shape a diff takes.
 *
 * Returns null when there is no such run, rather than an empty snapshot. An
 * empty snapshot compares cleanly against anything and reports every finding
 * on the other side as appeared or disappeared — a confident answer about a
 * run that does not exist.
 */
export function readRunSnapshot(
  db: DatabaseSync,
  runId: number,
  source: SnapshotSource,
): RunSnapshot | null {
  const row = db.prepare(`${RUN_SELECT} WHERE run.id = ?`).get(runId);
  if (row === undefined) return null;

  const findings = db
    .prepare(`SELECT * FROM finding WHERE run_id = ? ORDER BY id`)
    .all(runId)
    .map((r) => toRecordedFinding(r));

  const rules = db
    .prepare(`SELECT * FROM run_rule WHERE run_id = ? ORDER BY rule`)
    .all(runId)
    .map((r) => toRuleRun(r));

  return { source, run: toRunSummary(row), findings, rules };
}
