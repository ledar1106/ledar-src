/**
 * What changed between two scans — and what a difference is allowed to mean.
 *
 * The whole difficulty of this file is in one sentence: **a finding that is
 * not in the second report is not the same thing as a problem that was
 * fixed.** It may have been fixed. The rule may also have not run, or run
 * against fewer rows, or been rewritten between the two scans so that it no
 * longer asks the same question. Those are opposite answers and they leave
 * identical traces in the `finding` table, which is why `RunSnapshot` carries
 * `rules` and `source` beside `findings` and why every verdict below is
 * paired with the reason it is allowed to be stated.
 *
 * Three things are compared, and they are kept apart deliberately:
 *
 *   `findingKey`      does this claim still exist
 *   `structureHash`   is it still about the same shape of thing   → SCHEMA
 *   `measuredRows`    is the number behind it bigger or smaller   → DATA
 *
 * That is the schema-versus-data split, and it comes for free from columns
 * the store was already keeping. What does not come for free is knowing when
 * those columns are comparable at all — see `comparableStructureHash` and
 * `recordsEngineVersion` on `SnapshotSource`, both of which are false for a
 * schema-1 history and both of which turn a confident answer into an honest
 * one.
 *
 * ## The blind spot, stated rather than left to be discovered
 *
 * `engineRuleVersion` is recorded on findings, not on `run_rule`. So a rule
 * that produced no findings in a run leaves no version behind for that run.
 * When a finding *appears*, that is frequently the situation on the earlier
 * side — the rule was there, it found nothing, and it did not say which
 * version of itself found nothing. This code reports such a pair as
 * `rule-version-unknown` rather than guessing, which is right, but the reason
 * it has to is a gap in the schema and not a fact about the world.
 */

import { IDENTITY_LIMITS } from './identity.js';
import { STORE_VOCABULARY } from './schema.js';
import type { RecordedFinding, RunSnapshot, RuleRun } from './types.js';

/**
 * Severity, worst last, taken from the one list the store already tripwires.
 *
 * Not a new copy of the vocabulary — `STORE_VOCABULARY.severity` is already
 * compared against `@ledar/contracts` at test time. What is new is the
 * dependency on its *order*, which that tripwire does not check, so
 * `diff.test.ts` checks it separately. Without that, a reordering in
 * contracts would leave every gate green while this file quietly decided that
 * `critical` was an improvement on `info`.
 */
const SEVERITY_ORDER: readonly string[] = STORE_VOCABULARY['severity'] ?? [];

function severityRank(severity: string): number {
  return SEVERITY_ORDER.indexOf(severity);
}

/** What happened to one finding between the two runs. */
export type ChangeVerdict =
  | 'appeared'
  | 'disappeared'
  | 'structure-changed'
  | 'worsened'
  | 'improved'
  | 'unchanged';

/**
 * Whether the two sides were produced by the same question.
 *
 * This is not about the database. It is about whether the *scanner* was the
 * same on both sides, which decides whether a difference is allowed to be
 * read as news about the customer's data.
 */
export type Comparability =
  /** Same rule, same version. A difference here is a difference in the data. */
  | 'like-for-like'
  /** The rule itself moved between the runs. The difference may be ours. */
  | 'rule-changed'
  /** One side does not say which version ran. Nothing can be attributed. */
  | 'rule-version-unknown';

/** Why a finding is missing from the second run. */
export type Absence =
  /** The rule ran again and covered at least as much. It is genuinely gone. */
  | 'examined'
  /** The rule ran but covered less than before. It may not have been looked at. */
  | 'less-examined'
  /** The rule did not run, or covered nothing. This is not evidence of a fix. */
  | 'not-examined'
  /** Neither run declared a denominator, so the two cannot be told apart. */
  | 'coverage-unknown';

export type FindingChange = {
  findingKey: string;
  rule: string;
  verdict: ChangeVerdict;
  comparability: Comparability;
  /** Null when the finding is new. */
  before: RecordedFinding | null;
  /** Null when the finding is gone. */
  after: RecordedFinding | null;
  /** Only set when `verdict` is `disappeared`. */
  absence: Absence | null;
  /** What this row means, in the product's voice, hedged exactly as far as it must be. */
  says: string;
};

/** A rule that did not do the same amount of work in both runs. */
export type RuleGap = {
  rule: string;
  ranBefore: boolean;
  ranAfter: boolean;
  checkedBefore: number | null;
  checkedAfter: number | null;
  says: string;
};

export type RunDiff = {
  before: RunSnapshot;
  after: RunSnapshot;
  /** Ordered: the ones that need a decision first, `unchanged` last. */
  changes: FindingChange[];
  ruleGaps: RuleGap[];
  /**
   * Reasons the whole comparison may not mean what it looks like.
   *
   * Empty is a real answer and a rare one. These are printed above the
   * findings, not below them, because a caution read after the numbers is a
   * caution that arrives too late to change how the numbers were read.
   */
  cautions: string[];
  /**
   * The standing limits of finding identity, from `identity.ts`.
   *
   * Carried here rather than reimplemented, because they are true of every
   * diff this system will ever draw and a copy would drift from the code that
   * actually decides identity.
   */
  identityLimits: readonly string[];
};

function byKey(findings: readonly RecordedFinding[]): Map<string, RecordedFinding> {
  const out = new Map<string, RecordedFinding>();
  for (const f of findings) out.set(f.findingKey, f);
  return out;
}

function ruleIn(snapshot: RunSnapshot, rule: string): RuleRun | undefined {
  return snapshot.rules.find((r) => r.rule === rule);
}

/**
 * Which version of a rule was running, as far as one snapshot can say.
 *
 * Reads the version off any finding that rule produced. That is the only
 * place it is recorded — see the blind spot at the top of this file — so a
 * rule that found nothing returns null, meaning *unknown*, never *unchanged*.
 */
function ruleVersionIn(snapshot: RunSnapshot, rule: string): string | null {
  if (!snapshot.source.recordsEngineVersion) return null;

  // The coverage row first. Debt N40 added `rule_version` to `run_rule`
  // precisely because the findings could not answer for a rule that raised
  // nothing — which is the older side of every `appeared` verdict, and the
  // single most common thing a diff is asked about.
  //
  // Before this, a rule upgrade produced exactly the picture of "the old build
  // saw nothing, the new one sees something", and the diff had to answer
  // `rule-version-unknown` at the moment the question "your data or your
  // tool?" was worth the most.
  const covered = snapshot.rules.find((r) => r.rule === rule);
  if (covered?.ruleVersion !== undefined) return covered.ruleVersion;

  // Then the findings, which is where every history before schema 4 kept it.
  // A retired schema-3 file still answers here, so reading an older history
  // did not get worse when the newer one got better.
  for (const f of snapshot.findings) {
    if (f.rule === rule && f.engineRuleVersion !== null) return f.engineRuleVersion;
  }
  return null;
}

function comparabilityOf(
  before: RunSnapshot,
  after: RunSnapshot,
  rule: string,
  beforeFinding: RecordedFinding | null,
  afterFinding: RecordedFinding | null,
): Comparability {
  const b = beforeFinding?.engineRuleVersion ?? ruleVersionIn(before, rule);
  const a = afterFinding?.engineRuleVersion ?? ruleVersionIn(after, rule);
  if (b === null || a === null) return 'rule-version-unknown';
  return b === a ? 'like-for-like' : 'rule-changed';
}

/** The clause that says whether a difference can be blamed on the database. */
function attributionClause(
  comparability: Comparability,
  before: RunSnapshot,
  after: RunSnapshot,
  rule: string,
  beforeFinding: RecordedFinding | null,
  afterFinding: RecordedFinding | null,
): string {
  if (comparability === 'like-for-like') return '';
  if (comparability === 'rule-changed') {
    const b = beforeFinding?.engineRuleVersion ?? ruleVersionIn(before, rule);
    const a = afterFinding?.engineRuleVersion ?? ruleVersionIn(after, rule);
    return (
      ` The rule that produced it changed from ${b} to ${a} between these two` +
      ` runs, so this difference may be a change to the scanner rather than to` +
      ` your database.`
    );
  }
  // Which side is silent matters to the sentence. Saying "the earlier run
  // does not record it" when neither of them does implies the later one
  // does, which sends the reader looking for a version string that is not
  // there in either file.
  const bSays = beforeFinding?.engineRuleVersion ?? ruleVersionIn(before, rule);
  const aSays = afterFinding?.engineRuleVersion ?? ruleVersionIn(after, rule);
  const subject =
    bSays === null && aSays === null
      ? 'Neither run records'
      : bSays === null
        ? 'The earlier run does not record'
        : 'The later run does not record';
  return (
    ` ${subject} which version of this rule ran, so whether this difference is` +
    ` your database or a change to the scanner cannot be told from here.`
  );
}

function absenceOf(before: RunSnapshot, after: RunSnapshot, rule: string): Absence {
  const ran = ruleIn(after, rule);
  if (ran === undefined || !ran.ran) return 'not-examined';
  if (ran.coverage === undefined) return 'coverage-unknown';
  if (ran.coverage.checked === 0) return 'not-examined';

  const was = ruleIn(before, rule)?.coverage;
  if (was !== undefined && ran.coverage.checked < was.checked) return 'less-examined';
  return 'examined';
}

function absenceClause(absence: Absence, before: RunSnapshot, after: RunSnapshot, rule: string): string {
  switch (absence) {
    case 'examined':
      return 'Gone. The rule ran again, covered at least as much as before, and did not report it.';
    case 'less-examined': {
      const now = ruleIn(after, rule)?.coverage?.checked;
      const was = ruleIn(before, rule)?.coverage?.checked;
      return (
        `Not in this report — but the rule checked ${now} this time and ${was} last time.` +
        ` Fewer things were looked at, so this is not evidence it was fixed.`
      );
    }
    case 'not-examined':
      return (
        'Not in this report, and the rule did not examine anything this time.' +
        ' This is not evidence it was fixed.'
      );
    case 'coverage-unknown':
      return (
        'Not in this report. Neither run said how much this rule covered, so' +
        ' "gone" cannot be told apart from "not looked at".'
      );
  }
}

function rowsClause(
  before: RecordedFinding,
  after: RecordedFinding,
  hashesComparable: boolean,
): string {
  const b = before.measuredRows;
  const a = after.measuredRows;
  if (b !== null && a !== null && b !== a) {
    return a > b ? `Worse: ${a} rows, was ${b}.` : `Better: ${a} rows, was ${b}.`;
  }
  if (before.severity !== after.severity) {
    const worse = severityRank(after.severity) > severityRank(before.severity);
    return `${worse ? 'Worse' : 'Better'}: severity ${after.severity}, was ${before.severity}.`;
  }
  // Not a flat "Unchanged." when the structure fingerprints could not be
  // compared. The numbers matching is all that was checked, and a claim that
  // nothing moved would be broader than the check behind it.
  return hashesComparable
    ? 'Unchanged.'
    : 'Unchanged in the numbers. The structure fingerprints could not be compared between these two runs — see above.';
}

/**
 * Compares two runs.
 *
 * Throws only for a comparison that cannot mean anything: two different
 * databases. Everything else that makes a comparison unreliable is returned
 * as a caution, because a diff the user can read with a warning on it is
 * worth more than a refusal they have to work around.
 */
export function diffRuns(before: RunSnapshot, after: RunSnapshot): RunDiff {
  if (before.run.fingerprint !== after.run.fingerprint) {
    throw new Error(
      `These two runs are against different databases (${before.run.label} and ` +
        `${after.run.label}). A diff between them would report every finding in ` +
        `one as fixed and every finding in the other as new, which is a very ` +
        `convincing way to say nothing.`,
    );
  }

  const cautions = buildCautions(before, after);
  const hashesComparable =
    before.source.comparableStructureHash && after.source.comparableStructureHash;

  const beforeByKey = byKey(before.findings);
  const afterByKey = byKey(after.findings);
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);

  const changes: FindingChange[] = [];
  for (const key of keys) {
    const b = beforeByKey.get(key) ?? null;
    const a = afterByKey.get(key) ?? null;
    const rule = (a ?? b)!.rule;
    const comparability = comparabilityOf(before, after, rule, b, a);
    const attribution = attributionClause(comparability, before, after, rule, b, a);

    if (b === null && a !== null) {
      changes.push({
        findingKey: key,
        rule,
        verdict: 'appeared',
        comparability,
        before: null,
        after: a,
        absence: null,
        says: `New. It was not in the earlier report.${attribution}`,
      });
      continue;
    }

    if (a === null && b !== null) {
      const absence = absenceOf(before, after, rule);
      changes.push({
        findingKey: key,
        rule,
        verdict: 'disappeared',
        comparability,
        before: b,
        after: null,
        absence,
        says: `${absenceClause(absence, before, after, rule)}${attribution}`,
      });
      continue;
    }

    // Both sides present.
    const bf = b!;
    const af = a!;
    if (hashesComparable && bf.structureHash !== af.structureHash) {
      changes.push({
        findingKey: key,
        rule,
        verdict: 'structure-changed',
        comparability,
        before: bf,
        after: af,
        absence: null,
        says:
          'The shape this is about changed — the table, the columns, or how ' +
          'strongly the claim is made is not what it was. It is the same ' +
          `finding by name and not the same finding in substance.${attribution}`,
      });
      continue;
    }

    const clause = rowsClause(bf, af, hashesComparable);
    const verdict: ChangeVerdict = clause.startsWith('Worse')
      ? 'worsened'
      : clause.startsWith('Better')
        ? 'improved'
        : 'unchanged';
    changes.push({
      findingKey: key,
      rule,
      verdict,
      comparability,
      before: bf,
      after: af,
      absence: null,
      says: `${clause}${verdict === 'unchanged' ? '' : attribution}`,
    });
  }

  changes.sort((x, y) => {
    const rank = VERDICT_ORDER.indexOf(x.verdict) - VERDICT_ORDER.indexOf(y.verdict);
    return rank !== 0 ? rank : x.findingKey.localeCompare(y.findingKey);
  });

  return {
    before,
    after,
    changes,
    ruleGaps: buildRuleGaps(before, after),
    cautions,
    identityLimits: IDENTITY_LIMITS,
  };
}

/** Worst news first; `unchanged` last, where it can be skipped. */
const VERDICT_ORDER: readonly ChangeVerdict[] = [
  'appeared',
  'worsened',
  'structure-changed',
  'disappeared',
  'improved',
  'unchanged',
];

function buildRuleGaps(before: RunSnapshot, after: RunSnapshot): RuleGap[] {
  const rules = new Set([
    ...before.rules.map((r) => r.rule),
    ...after.rules.map((r) => r.rule),
  ]);

  const gaps: RuleGap[] = [];
  for (const rule of [...rules].sort()) {
    const b = ruleIn(before, rule);
    const a = ruleIn(after, rule);
    const ranBefore = b?.ran ?? false;
    const ranAfter = a?.ran ?? false;
    const checkedBefore = b?.coverage?.checked ?? null;
    const checkedAfter = a?.coverage?.checked ?? null;
    if (ranBefore === ranAfter && checkedBefore === checkedAfter) continue;

    // "Not in the record" and "did not happen" are different claims, and the
    // difference is not academic here: N30 fixed a bug where layer-A rules ran
    // and were never written to history. Every run before that fix looks, to
    // this function, like a run where those rules did not execute. Saying so
    // in those words would blame the database for a gap in the bookkeeping.
    const missingBefore = b === undefined;
    const missingAfter = a === undefined;

    let says: string;
    if (!ranBefore && ranAfter) {
      says = missingBefore
        ? `${rule} is recorded as having run this time, and the earlier run does not mention it at all — which means it was not recorded, not that it did not run. Anything it reports is new to the report, not necessarily new in your database.`
        : `${rule} ran this time and is recorded as not having run last time. Anything it reports is new to the report, not necessarily new in your database.`;
    } else if (ranBefore && !ranAfter) {
      says = missingAfter
        ? `${rule} is not mentioned in this run at all. Nothing it would have found is in this report, and the report does not say why.`
        : `${rule} did not run this time. Nothing it would have found is in this report.`;
    } else {
      says = `${rule} checked ${checkedAfter ?? 'an undeclared number of'} targets this time and ${checkedBefore ?? 'an undeclared number'} last time.`;
    }
    gaps.push({ rule, ranBefore, ranAfter, checkedBefore, checkedAfter, says });
  }
  return gaps;
}

function buildCautions(before: RunSnapshot, after: RunSnapshot): string[] {
  const out: string[] = [];

  if (before.run.startedAt > after.run.startedAt) {
    out.push(
      `The run being compared against started LATER (${after.run.startedAt}) than ` +
        `the one it is compared to (${before.run.startedAt}). Everything below ` +
        `reads backwards: "new" means removed, "gone" means added.`,
    );
  }

  for (const [side, snap] of [['earlier', before], ['later', after]] as const) {
    if (snap.run.outcome !== 'completed') {
      out.push(
        `The ${side} run ended as "${snap.run.outcome}"${
          snap.run.outcomeNote === null ? '' : ` (${snap.run.outcomeNote})`
        }. It is a record of how far a scan got, not of what the database holds, ` +
          `and comparing against it will report things it never reached as though ` +
          `they had changed.`,
      );
    }
    if (snap.run.costTruncated) {
      out.push(
        `The ${side} run stopped short of finishing every check` +
          `${snap.run.truncationNote === null ? '' : `: ${snap.run.truncationNote}`}. ` +
          `Anything missing from it may simply be past where it stopped.`,
      );
    }
  }

  if (!before.source.recordsEngineVersion || !after.source.recordsEngineVersion) {
    const which = !before.source.recordsEngineVersion ? 'earlier' : 'later';
    const snap = !before.source.recordsEngineVersion ? before : after;
    out.push(
      `The ${which} run comes from a schema-${snap.source.schemaVersion} history ` +
        `(${snap.source.path}), written before this system recorded which version ` +
        `of a rule produced a claim. Nothing below can separate "your database ` +
        `changed" from "we changed the scanner".`,
    );
  }

  if (!before.source.comparableStructureHash || !after.source.comparableStructureHash) {
    out.push(
      `Structure comparison is off for this diff. One side is a schema-1 history, ` +
        `whose structure fingerprints were built from a shorter list of fields than ` +
        `today's. Every carried-over finding would read as "the structure changed" ` +
        `even on a database that holds no rows, so that check is not run here.`,
    );
  }

  if (before.source.schemaVersion !== after.source.schemaVersion) {
    out.push(
      `The two runs come from different history files: schema ` +
        `${before.source.schemaVersion} (${before.source.path}) and schema ` +
        `${after.source.schemaVersion} (${after.source.path}).`,
    );
  }

  const bs = before.run.scope;
  const as = after.run.scope;
  if (bs.visibleTables !== as.visibleTables || bs.totalTables !== as.totalTables) {
    out.push(
      `The two runs did not see the same amount of the database: ` +
        `${bs.visibleTables} of ${bs.totalTables ?? 'an unknown number of'} tables ` +
        `then, ${as.visibleTables} of ${as.totalTables ?? 'an unknown number of'} now.`,
    );
  }
  if (bs.role !== as.role) {
    out.push(
      `The two runs connected as different roles (${bs.role}, then ${as.role}). ` +
        `A role that can see less finds less, and that is not a change in the data.`,
    );
  }
  if (bs.schemas.join(',') !== as.schemas.join(',')) {
    out.push(
      `The two runs covered different schemas (${bs.schemas.join(', ')}, then ` +
        `${as.schemas.join(', ')}).`,
    );
  }

  return out;
}
