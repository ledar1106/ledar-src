/**
 * Runs a rule the USER described — VS-6, the half that touches a database.
 *
 * ## Why this is not a fourth rule pack
 *
 * `packs-layer-a` and `packs-layer-b` hold rules this product decided to look
 * for. Everything here runs a rule somebody typed. The whole design of
 * `bounded-rule` exists so those two never get confused, and putting this
 * inside a pack would undo that on the first day.
 *
 * The distinction is not curatorial. It changes what the claim is entitled to
 * say, and the contract already enforces the difference without a line of new
 * code:
 *
 * ```text
 * origin          user_declared    the rule came from the person, not the catalog
 * confidenceBasis user_statement   forced by BASIS_FOR_ORIGIN, not chosen here
 * confidence      probable         the CEILING for that basis. Not choosable.
 * ```
 *
 * And the consequence that matters most falls out of `assertClaimDiscipline`
 * on its own: anything below `certain` whose owner has not ruled on it goes
 * through `assertNoDefectWords`. So a finding from a user's rule **cannot call
 * anything an error** until that same user confirms it.
 *
 * > You told me to look for this. I counted twelve. I will not call them
 * > errors until you say they are.
 *
 * ## The count is exact and the claim is still only probable
 *
 * These are not in tension, and they live in different fields on purpose.
 * `evidence.rowCount` with `sampleSize: null` records that every row was
 * counted — that part is as exact as anything Layer A produces. `confidence`
 * is about the RULE, and the rule came from a sentence that a model mapped
 * onto a table. ㉔ and ㉕ measured how that mapping fails: not by miscounting,
 * but by counting the wrong column. No count can detect that, which is exactly
 * why the count is not allowed to vouch for it.
 *
 * ## 🟥 What this cannot run, and it will decline rather than guess
 *
 * `quoteIdent` refuses any identifier that is not plain — and that includes
 * legal, real Postgres names like `"user id"`. A rule pointed at such a column
 * is refused here, loudly, instead of being mangled into SQL. That is the
 * right call and it is a genuine limit of VS-6, written down rather than left
 * for a customer to discover.
 *
 * ⚠️ It is also HALF a defence and must not be counted as a whole one.
 * `field-results` ㉕ measured both layers against the same six hostile
 * identifiers: the model ignored every instruction-shaped name, and
 * `quoteIdent` refuses every instruction-shaped name. Both filter on SHAPE,
 * and the one identifier that beat the model — a plain, plausible column name
 * — sails through here too. Two layers that fail on the same input are one
 * layer. The control for that case is the read-back, `renderRule`, and there
 * is no second one.
 */

import type { Client } from 'pg';

import { qualified, quoteIdent } from '@ledar/connector-postgres';
import type { QueryBudget } from '@ledar/connector-postgres';
import { coverageOf, sealFindings, translator } from '@ledar/contracts';
import type {
  Coverage,
  FindingDraft,
  Lang,
  SealedFinding,
  SealedRule,
  Translate,
} from '@ledar/contracts';

/**
 * Which version of THIS runner produced a finding.
 *
 * Separate from `LAYER_A_RULE_VERSION` for the reason `diffRuns` cares about:
 * a change here must be attributable here. A shared version string would make
 * a user-rule change look like a Layer A release.
 */
export const USER_RULE_VERSION = 'user-rules@1.1.0';
// 1.0.0 -> 1.1.0 on 2026-08-27: `is-never-missing` now counts a blank string
// and a whitespace-only string as missing, where it counted only NULL before.
// The bump is not bookkeeping. `diffRuns` refuses to attribute change across
// a version boundary, and without it the next scan of a table like
// `public.address` would show a count leaping 4 -> 1003 and report it as
// something that happened to the DATA. Nothing happened to the data; the
// question changed.

/**
 * The ceiling on any count.
 *
 * Same device as Layer A's: count up to here and say "at least" past it. A
 * rule somebody typed can match every row of a large table, and the number
 * that matters to them is "a lot", not the exact total at the cost of a full
 * scan of somebody's production database.
 */
const COUNT_LIMIT = 100_000;

/** `customer-system-metadata` — identifiers and counts, never row values. */
const EGRESS = 'customer-system-metadata' as const;

/**
 * One query, timed, and dated when it was SENT.
 *
 * The same helper Layer A keeps for the same reason: a count is true of the
 * database at the moment it was asked, and stamping it with the moment the
 * answer arrived puts a slow query's result minutes after the state it
 * describes.
 */
async function timedQuery(
  client: Client,
  sql: string,
): Promise<{ rows: Record<string, unknown>[]; durationMs: number; observedAt: string }> {
  const observedAt = new Date().toISOString();
  const t0 = performance.now();
  const res = await client.query(sql);
  return { rows: res.rows, durationMs: performance.now() - t0, observedAt };
}

/** `public.users` -> `['public', 'users']`, on the rightmost dot. */
function splitQualified(name: string): [string, string] {
  const at = name.lastIndexOf('.');
  if (at <= 0) throw new Error(`Expected schema.table, got ${JSON.stringify(name)}.`);
  return [name.slice(0, at), name.slice(at + 1)];
}

function splitColumnRef(ref: string): [string, string, string] {
  const at = ref.lastIndexOf('.');
  const [schema, table] = splitQualified(ref.slice(0, at));
  return [schema, table, ref.slice(at + 1)];
}

/**
 * The SQL for one rule.
 *
 * Exported because it is the part worth reading on its own, and because a test
 * can assert on the text without a database. Every identifier in it went
 * through `quoteIdent`, which is the only claim `check-sql.py` can prove.
 */
export function buildRuleQuery(rule: SealedRule): string {
  if (!rule.expressible) {
    throw new Error(
      `This rule was not expressible, so there is nothing to run. A caller ` +
        `reaching here has skipped the check that decides whether a query ` +
        `exists at all.`,
    );
  }

  const [schema, table] = splitQualified(rule.table!);
  const target = qualified(schema, table);

  if (rule.check === 'is-never-missing') {
    const col = quoteIdent(rule.columns[0]!);
    // 🟥 `IS NULL` alone until 2026-08-27, and the read-back above it has
    // always promised "empty". Those are not the same set, and Pagila shows
    // the gap at full size: `public.address.address2` holds 4 nulls and 999
    // empty strings, so the old query answered 4 to a sentence a reader
    // would price at 1003 (Sol audit, blocker 5).
    //
    // `::text` rather than a column-type branch, and the reason is a
    // measurement rather than taste: an integer cast to text is never the
    // empty string, so on `film.original_language_id` this predicate returns
    // 1000 — exactly what `IS NULL` returned. One predicate is already right
    // for every type, and a classifier would be machinery that changes no
    // answer while adding a second place for the meaning to live.
    //
    // `btrim` because a column holding only spaces is empty to the person
    // who asked, and this sentence is read by someone deciding whether to
    // let a query run against their database.
    return `
      SELECT count(*)::int AS n
      FROM (
        SELECT 1 FROM ${target}
        WHERE ${col} IS NULL OR btrim(${col}::text) = ''
        LIMIT ${COUNT_LIMIT}
      ) s
    `;
  }

  if (rule.check === 'is-never-repeated') {
    // `quoteIdent` is called INSIDE each template rather than once into a
    // variable that is then reused. Not repetition for its own sake:
    // `check-sql.py` proves a fragment is safe by finding the call in the
    // expression that built it, and a value laundered through an intermediate
    // array is one it cannot follow. A safety rule a tool cannot check is a
    // safety rule that decays quietly, so the shape here matches Layer A's.
    const grouped = rule.columns.map((c) => quoteIdent(c)).join(', ');
    const notNull = rule.columns.map((c) => `${quoteIdent(c)} IS NOT NULL`).join(' AND ');
    // NULLs are excluded, and that follows Postgres rather than taste: a
    // UNIQUE index permits any number of NULLs, because two unknowns are not
    // known to be equal. Counting them as duplicates would report a violation
    // the database itself would not, on the one rule shape where a user is
    // most likely to compare our answer against a real unique index.
    return `
      SELECT count(*)::int AS n
      FROM (
        SELECT 1 FROM ${target}
        WHERE ${notNull}
        GROUP BY ${grouped}
        HAVING count(*) > 1
        LIMIT ${COUNT_LIMIT}
      ) s
    `;
  }

  // points-at-an-existing-row. Same shape as Layer A's orphan query, and
  // deliberately so: a user asking "does every X point at a real Y" is asking
  // the question a foreign key asks, about a place nobody declared one.
  const [pSchema, pTable, pColumn] = splitColumnRef(rule.references!);
  const parent = qualified(pSchema, pTable);
  const child = quoteIdent(rule.columns[0]!);
  const pk = quoteIdent(pColumn);
  return `
    SELECT count(*)::int AS n
    FROM (
      SELECT 1
      FROM ${target} c
      LEFT JOIN ${parent} p ON c.${child} = p.${pk}
      WHERE c.${child} IS NOT NULL AND p.${pk} IS NULL
      LIMIT ${COUNT_LIMIT}
    ) s
  `;
}

/** How many rows the rule could have applied to at all. */
function buildEligibleQuery(rule: SealedRule): string {
  const [schema, table] = splitQualified(rule.table!);
  return `
    SELECT count(*)::int AS n
    FROM (SELECT 1 FROM ${qualified(schema, table)} LIMIT ${COUNT_LIMIT}) s
  `;
}

export type RuleOutcome = {
  /**
   * `SealedFinding`, never `Finding`. Nothing in this file can construct that
   * type — only `sealFindings` can — so every way out of here has been through
   * the gate, including one a later change adds.
   */
  findings: SealedFinding[];
  /** What the rule was able to reach, whether or not it found anything. */
  coverage: Coverage;
};

/**
 * Runs one user-described rule and says what it reached.
 *
 * Takes `SealedRule` and nothing else, so a rule that has not been checked
 * against the catalogue it will run on cannot reach a database — the branded
 * type is the enforcement, not a comment asking callers to remember.
 */
export async function runRule(
  client: Client,
  rule: SealedRule,
  budget: QueryBudget,
  lang: Lang = 'en',
): Promise<RuleOutcome> {
  const T: Translate = translator(lang);

  if (!rule.expressible) {
    throw new Error(
      `runRule was handed a rule this product said it could not express. ` +
        `The caller decides what to do with that — show the reason, ask ` +
        `again — and running a query is not one of the options.`,
    );
  }

  const [schema, table] = splitQualified(rule.table!);
  const label = `user rule ${rule.check} on ${rule.table}`;
  const observedAt = new Date().toISOString();

  if (!budget.canAfford(label)) {
    // Not examined, and said so. The failure mode this project keeps meeting
    // is a defensive default turning BROKEN into EMPTY; a rule that never ran
    // must not leave the same trace as one that ran and found nothing.
    return {
      findings: [],
      coverage: coverageOf(0, 1, [{ target: rule.table!, reason: 'budget_ceiling' }]),
    };
  }

  const sql = buildRuleQuery(rule);
  const counted = await timedQuery(client, sql);
  budget.record(counted.durationMs, 1);
  const n = Number((counted.rows[0] as { n: number }).n);
  const capped = n >= COUNT_LIMIT;

  const eligible = await timedQuery(client, buildEligibleQuery(rule));
  budget.record(eligible.durationMs, 1);
  const total = Number((eligible.rows[0] as { n: number }).n);

  const readBack = rule.columns.join(', ');
  // One target, and it was either reached or the table was empty. `verified`
  // rather than `sampled`: every row was counted, and debt N1 added that
  // distinction precisely so a full count and a sample stop rendering as the
  // same record.
  const reached: Coverage = {
    ...coverageOf(total > 0 ? 1 : 0, 1),
    verified: total > 0 ? 1 : 0,
  };
  const common = {
    id: `user/${rule.check}/${rule.table}.${rule.columns.join('+')}`,
    rule: `user/${rule.check}`,
    // Every one of these three is forced, not chosen. `BASIS_FOR_ORIGIN` maps
    // the origin to the basis, and `CEILING` caps what that basis may assert.
    // Writing `certain` here does not produce a confident finding; it produces
    // a refusal from `sealFindings`, which is the point of putting the rule in
    // the contract rather than in a comment.
    confidence: 'probable' as const,
    origin: 'user_declared' as const,
    confidenceBasis: 'user_statement' as const,

    // `info`, and not a judgement dressed as one. Severity is how much this
    // ought to alarm somebody, and nothing here knows that: the user said the
    // rule matters, which is not the same as saying a match is serious. When
    // they confirm the finding, the severity is theirs to set.
    severity: 'info' as const,
    egressClass: EGRESS,
    observedAt,
    engineRuleVersion: USER_RULE_VERSION,
    schema,
    table,
    columns: [...rule.columns],
    plainText:
      n > 0
        ? T('user-rule.found', {
            count: capped ? `At least ${n}` : `${n}`,
            total,
            table: rule.table!,
          })
        : total > 0
          ? T('user-rule.none', { total, table: rule.table! })
          : T('user-rule.nothing-to-check', { table: rule.table! }),
    // Only on the kinds that carry one. The contract gives `boundary` to
    // `negative` and `abstained` and to nothing else, for a reason worth not
    // overriding: *anything asserting that something is not wrong must state
    // where it looked*. An observation asserts the opposite.
    //
    // The caveat an observation still needs — I checked the rule as it was
    // read back, not that it is the rule you meant — is deliberately NOT
    // repeated per finding. It is true of every user rule in the report at
    // once, and VS-7 already caught what per-finding repetition costs: one
    // sentence printed three times in sixty lines stops being read.
    technical: T('user-rule.technical', {
      rule: rule.check!,
      target: `${rule.table}.${readBack}`,
      rows: `${n}${capped ? '+' : ''}`,
      total,
    }),
    evidence:
      total > 0
        ? {
            sql,
            rowCount: n,
            // Counted, not sampled. The exactness lives here; the confidence
            // above is about the rule, not about this number.
            sampleSize: null,
            durationMs: counted.durationMs,
            sample: [],
          }
        : null,
    coverage: reached,
  };

  // Branch on the kind rather than computing it into one object literal.
  //
  // Not style: `Finding` is a discriminated union, and `boundary` exists only
  // on the two kinds that assert nothing is wrong. A single literal with
  // `kind` typed as a union of three narrows to nothing, and the only ways
  // past that are a cast or this. A cast here would be a cast on the one
  // object the whole product treats as evidence.
  const draft: FindingDraft =
    n > 0
      ? { ...common, kind: 'observation' }
      : total > 0
        ? { ...common, kind: 'negative', boundary: T('user-rule.boundary') }
        : { ...common, kind: 'abstained', boundary: T('user-rule.boundary') };

  const findings = sealFindings([draft], 'rule-runner');
  return { findings, coverage: reached };
}
