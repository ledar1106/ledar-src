/**
 * Columns that behave like a foreign key without anyone having declared one.
 *
 * This is the rule the whole product is named after. `orders.user_id` holds
 * values that all look like `users.id`, nothing enforces it, and forty-seven
 * of them point at a user who is gone. Nobody types that query, because
 * nobody knows to ask.
 *
 * The discipline that makes this safe: the orphan count is a fact, and the
 * claim "there should be a foreign key here" is not. A schema without a
 * declared reference may be a mistake, or it may be a decision — archived
 * rows kept on purpose, a polymorphic column, a staging table nobody joins.
 * Only the person who owns the system can say which, so this rule produces
 * a question with evidence attached, never a verdict.
 */

import type { Client } from 'pg';
import { qualified, quoteIdent, tableSampleClause } from '@ledar/connector-postgres';
import type { ColumnInfo, QueryBudget, SchemaGraph } from '@ledar/connector-postgres';
import {
  redactCell,
  sealFindings,
  type EgressClass,
  type Evidence,
  type Finding,
  type FindingDraft,
  type RuleCoverage,
  type SealedFinding,
} from '@ledar/contracts';

/**
 * Which release of Layer B's detection rule produced a claim.
 *
 * Every finding this pack publishes carries it. **Bump it whenever the rule
 * changes what it would decide** — `MIN_MATCH_RATE`, the naming conventions
 * `parentNameGuesses` reads, which types `typesCompatible` pairs, the size
 * gate, the counting ceiling. Rewording the question is not a bump; neither
 * is a refactor that cannot change which columns get raised.
 *
 * This one earns its keep more than Layer A's does. When `parentNameGuesses`
 * learned the bare naming convention, every MusicBrainz table went from
 * invisible to eligible in one release — findings appearing out of nowhere
 * that had been there all along. Without a version on the claim the store
 * reads that as the database having changed overnight, and there is nothing
 * in the data to say otherwise.
 *
 * 1.0.0 → 2.0.0 is the largest change this rule has had, and it changes the
 * answer in every direction at once: which rows are read (block sampling
 * instead of the first ten thousand), which tables are read at all (size picks
 * the method now, not whether), which columns are even proposed
 * (`parentNameGuesses` strips more than one leading word), and what counts as
 * unmatched (a dominant repeated value is set aside). A history spanning the
 * bump will show findings appear, disappear, and change their numbers on a
 * database nobody touched. This string is the only thing that can tell a
 * later diff that it was the rule that moved.
 *
 * 2.0.0 → 2.1.0 un-suppresses a case 2.0.0 was wrong to suppress: a column
 * with exactly one unmatched row was being ruled out as a repeated value,
 * because one row is trivially 100% of one row. Nothing else about the
 * decision changed, so a diff across this bump should show findings APPEAR
 * and none disappear — which is itself a check on the bump.
 */
export const LAYER_B_RULE_VERSION = 'layer-b@2.1.0';

/**
 * How far a Layer B claim is allowed to travel.
 *
 * The same class as Layer A's, for the same reason: the sentence names a
 * child table, a column, and the parent it appears to point at. Sample values
 * are reduced by `redactCell` before they get anywhere near a finding, but a
 * reference between two named tables is still a piece of the customer's
 * system map, and it is declared as such rather than judged harmless because
 * nothing in it looks like PII.
 */
const EGRESS: EgressClass = 'customer-system-metadata';

/**
 * How closely values must line up before the relationship is worth raising.
 *
 * Below this, a matching name is more likely to be a coincidence than a
 * reference — `session_id` in a logs table pointing at nothing in
 * `sessions` is a different story from a broken link.
 */
const MIN_MATCH_RATE = 0.5;

/**
 * The rule id this pack publishes under.
 *
 * Exported because the scan has to record that this rule ran even when it
 * produced no finding — and with no finding there is no id to read off one.
 * The alternative was a copy of the string in the CLI, which is how renaming
 * a rule quietly grows a second rule in the history that never ran.
 */
export const IMPLICIT_FK_RULE = 'layer-b/undeclared-reference-with-unmatched-values';

/**
 * At or below this many rows, every non-null value is read and the count is
 * exact. Above it, the column is sampled.
 *
 * This number decides *how* a column is checked. It used to decide *whether*,
 * and that was the more expensive mistake of the two. `ALWAYS_CHECK_BELOW_ROWS
 * = 500_000` meant a scan of RubyGems declined four of its five candidates —
 * including both tables that actually had unmatched values — and the same
 * column in the same schema was raised on devops.stackexchange (49k rows) and
 * passed over in silence on dba.stackexchange (948k rows). A rule whose answer
 * depends on how popular the site got is not measuring the schema.
 *
 * Lowered from 500,000 rather than raised, which reads backwards until you see
 * what the old number was buying. It bought nothing: everything above it was
 * refused, and everything below it was read with `LIMIT 10000` anyway, so a
 * 49,148-row table was already being sampled — badly, and while saying
 * otherwise. Fifty thousand is the size this is willing to read in full, which
 * is what "exact" has to mean.
 */
const EXACT_BELOW_ROWS = 50_000;

/**
 * How many rows a sampled check aims to look at.
 *
 * Aims. `TABLESAMPLE SYSTEM` draws blocks, not rows, so what comes back varies
 * around this number — and varies a great deal when the row estimate feeding
 * the percentage is stale. Nothing downstream assumes the target was hit:
 * every sentence is built from `present`, which is what actually arrived.
 */
const SAMPLE_TARGET_ROWS = 10_000;

/**
 * When one value covers this much of the unmatched set, it is read as a
 * convention rather than as that many broken links.
 *
 * RubyGems is the case this exists for. `gem_downloads.version_id` has 232,818
 * values that match no `versions` row — and 232,573 of them are the single
 * value `0`, which that schema uses to mean "all versions of this gem". The
 * match rate was 89.4%, comfortably over `MIN_MATCH_RATE`, so the rule would
 * have raised a question about a quarter of a million rows of which 99.9% were
 * a deliberate design decision.
 *
 * Nothing about the shape of the value gives this away: it is the number zero.
 * That is the same lesson as the redaction gate — the dangerous case has no
 * shape to detect — so what is measured here is not the value but its
 * *concentration*. Scattered leftovers are scattered. A convention is one
 * value, over and over.
 *
 * 0.8 rather than 0.99: the interesting case is the mixed one, where a
 * convention hides a handful of genuine orphans behind it. Set high enough
 * that ordinary skew does not trip it, low enough that the residual still gets
 * looked at.
 */
const SENTINEL_SHARE = 0.8;

/**
 * How many times the dominant value has to actually appear before "one value,
 * repeated" is a description of anything.
 *
 * Two, and it is not a tuned number — it is the literal content of the
 * sentence this rule already used to justify itself. A value that appears
 * ONCE is not repeated. There is nothing to be a convention.
 *
 * Without it the share is degenerate at the bottom: one unmatched row makes
 * `topUnmatched / orphans` exactly 1.0, clears 0.8 comfortably, and the column
 * is set aside as a schema convention on the strength of a single row.
 *
 * Measured, not imagined. Debt N38 asked whether 0.8 was a line through the
 * data or a number that fit one anecdote, so every Layer B candidate on six
 * benches was counted. `se_dba.posts.owner_user_id` came back at 100.0%
 * dominance — 242,133 rows, exactly one of them unmatched. Under the rule as
 * first written that finding disappeared into `ruledOut` with a reason that
 * was not true of it.
 *
 * The suppression was disclosed rather than silent, which is why this is a
 * defect and not a disaster. It was still the rule saying something false
 * about what it had seen.
 */
const SENTINEL_MIN_REPEATS = 2;

const SAMPLE_LIMIT = 5;

export type ImplicitFkCandidate = {
  childSchema: string;
  childTable: string;
  childColumn: string;
  parentSchema: string;
  parentTable: string;
  parentColumn: string;
  /** `null` when nothing has ever analysed the table. Not a size of zero. */
  childRowsEstimated: number | null;
};

/** int4 and int8 reference each other happily; uuid only matches uuid. */
function typesCompatible(a: string, b: string): boolean {
  const numeric = new Set(['int2', 'int4', 'int8']);
  if (numeric.has(a) && numeric.has(b)) return true;
  return a === b;
}

/**
 * Which table a column might be pointing at, judged only by its name.
 *
 * Two conventions, because assuming one is how this rule went blind.
 *
 *   user_id → users        the suffix convention, what Rails and most
 *                          recent code produces
 *   artist  → artist       the bare convention, where the column is simply
 *                          named after the table it references
 *
 * The second was invisible here until this ran against MusicBrainz, whose
 * schema has used it since 2000: `artist_credit_name.artist` references
 * `artist.id` and carries no suffix at all. Every one of its foreign keys
 * was unreadable to this function, and the rule reported "nothing stood
 * out" across 374 tables with total confidence.
 *
 * Deliberately crude either way. A wrong guess costs one bounded query and
 * dies at the match rate; clever inference here would produce confident
 * nonsense instead.
 */
function parentNameGuesses(column: string, tableNames: ReadonlySet<string>): string[] {
  const suffixed = /^(.*)_(?:id|uuid|fk)$/i.exec(column);
  if (suffixed?.[1] && suffixed[1].length >= 2) {
    // Every stem from the longest to the shortest, dropping one leading word
    // at a time: `owner_user` then `user`, `last_editor_user` then
    // `editor_user` then `user`.
    //
    // A single strip is what a column has to be named for this to work at all,
    // and plenty are not. `owner_user_id` produced `owner_user`, `owner_users`,
    // `owner_useres` — and never `users`, which is the table it points at.
    // Same for `last_editor_user_id`, `related_post_id`,
    // `accepted_answer_id`, `excerpt_post_id`, `wiki_post_id`: every
    // qualified reference on devops.stackexchange, invisible.
    //
    // What made that worth fixing is not the columns it missed. It is that
    // the rule could not tell it had missed them, so they were never counted
    // as unchecked either — the scope strip reported full coverage of a set
    // these columns had silently dropped out of. A gap the denominator cannot
    // see is the one kind the disclosure cannot disclose.
    //
    // Longest first, because `break` in the caller takes the first stem with a
    // real table behind it. A schema with both `owner_user` and `user` means
    // the more specific name, and guessing the shorter one there would be
    // choosing the vaguer answer for no reason.
    const parts = suffixed[1].split('_').filter((p) => p.length > 0);
    const guesses: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const stem = parts.slice(i).join('_');
      if (stem.length < 2) continue;
      guesses.push(stem, `${stem}s`, `${stem}es`, stem.replace(/y$/, 'ies'));
    }
    return guesses;
  }

  // No suffix. The column may still be named after its parent outright.
  // Only worth guessing when a table of exactly that name exists — otherwise
  // every column in the database becomes a candidate.
  if (column.length >= 3 && tableNames.has(column)) return [column];

  return [];
}

export function findCandidates(graph: SchemaGraph): ImplicitFkCandidate[] {
  const declared = new Set(
    graph.constraints
      .filter((c) => c.kind === 'foreign_key')
      .flatMap((c) => c.columns.map((col) => `${c.schema}.${c.table}.${col}`)),
  );

  const byTable = new Map<string, ColumnInfo[]>();
  for (const col of graph.columns) {
    const key = `${col.schema}.${col.table}`;
    const list = byTable.get(key);
    if (list) list.push(col);
    else byTable.set(key, [col]);
  }

  const primaryKeyOf = new Map<string, { column: string; type: string }>();
  for (const c of graph.constraints) {
    if (c.kind !== 'primary_key' || c.columns.length !== 1) continue;
    const pkCol = c.columns[0]!;
    const info = byTable.get(`${c.schema}.${c.table}`)?.find((x) => x.name === pkCol);
    if (info) primaryKeyOf.set(`${c.schema}.${c.table}`, { column: pkCol, type: info.type });
  }

  const sizeOf = new Map(graph.sizes.map((s) => [`${s.schema}.${s.table}`, s.estimatedRows]));

  // Querying a partitioned parent scans every partition, so a rule that ran
  // against the parent has already seen these rows. Twenty-four monthly
  // partitions of one payments table would otherwise consume the entire
  // query budget answering the same question two dozen times.
  const partitions = new Set(
    graph.tables.filter((t) => t.isPartition).map((t) => `${t.schema}.${t.table}`),
  );

  const tableNames = new Set(graph.tables.map((t) => t.table));
  const candidates: ImplicitFkCandidate[] = [];

  for (const col of graph.columns) {
    if (partitions.has(`${col.schema}.${col.table}`)) continue;
    if (declared.has(`${col.schema}.${col.table}.${col.name}`)) continue;

    for (const guess of parentNameGuesses(col.name, tableNames)) {
      if (guess === col.table) continue; // self-reference guess, needs care
      const parentKey = `${col.schema}.${guess}`;
      const pk = primaryKeyOf.get(parentKey);
      if (!pk) continue;
      if (!typesCompatible(col.type, pk.type)) continue;

      candidates.push({
        childSchema: col.schema,
        childTable: col.table,
        childColumn: col.name,
        parentSchema: col.schema,
        parentTable: guess,
        parentColumn: pk.column,
        childRowsEstimated: sizeOf.get(`${col.schema}.${col.table}`) ?? null,
      });
      break; // first plausible parent wins; the match rate decides the rest
    }
  }

  return candidates;
}

/**
 * How one column is going to be looked at, decided before anything is read.
 *
 * `exact` reads every non-null value. `sample` reads blocks drawn from across
 * the whole table. Which one was used travels with the answer all the way to
 * the sentence the user reads, because "13% of this column" and "13% of ten
 * thousand rows I drew from this column" are not the same statement and only
 * one of them is true.
 */
type ReadPlan =
  | { kind: 'exact'; pct: null; seed: number }
  | { kind: 'sample'; pct: number; seed: number };

/**
 * Picks the plan from what the catalog claims the table's size is.
 *
 * An unknown size takes the exact path. It is not a large size and not a small
 * one — but a sampling percentage has to be divided by *something*, and there
 * is no honest number to divide by. The exact path needs no estimate, and the
 * cost is already bounded twice over: `statement_timeout` on the connection,
 * and the query budget above this loop.
 */
function planFor(c: ImplicitFkCandidate, seed: number): ReadPlan {
  const rows = c.childRowsEstimated;
  if (rows === null || rows <= EXACT_BELOW_ROWS) return { kind: 'exact', pct: null, seed };

  // Blocks are drawn with this probability, and a block holds many rows, so
  // the fraction of *rows* returned tracks the fraction of blocks regardless
  // of how many rows fit in one. Capped at 100 because a stale estimate can
  // otherwise ask for more of a table than exists.
  const pct = Math.min(100, (SAMPLE_TARGET_ROWS / rows) * 100);
  return { kind: 'sample', pct, seed };
}

/**
 * The clause that decides which rows Postgres even looks at.
 *
 * This one line is the whole of debt N34. What was here before was `LIMIT
 * 10000` with no `ORDER BY`, which does not mean "ten thousand rows" — it
 * means "whatever ten thousand rows come out of the heap first", and on an
 * append-mostly table that is the ten thousand *oldest*.
 *
 * The measurement, on devops.stackexchange: the scan reported `votes.post_id`
 * as 200 unmatched out of 10,000, and printed "98.0% match". Counting the
 * whole column gives 6,459 of 49,148 — 13.1%. Off by a factor of 6.5.
 *
 * Off in a direction, which is the part that matters. Orphans accumulate:
 * 4.4% of 2017's rows, 35.1% of 2024's. A sample that reads oldest-first reads
 * the cleanest part of the table and reports it as the whole. The dangerous
 * case is not this one — it is a fault that *starts* today, where the ten
 * thousand oldest rows are spotless and the finding never appears at all.
 *
 * `TABLESAMPLE SYSTEM` and not `ORDER BY random()`: random ordering sorts the
 * entire table, which is precisely the cost the size gate existed to avoid, so
 * paying it would have fixed this debt by deepening N32. Block sampling reads
 * a percentage of blocks and nothing else, which is why the size gate could
 * then be spent rather than widened.
 *
 * What that trades away, stated rather than buried: rows inside one block are
 * neighbours, so they are correlated, and this is a weaker sample than a
 * row-level one. It removes the *direction* of the bias, not every last bit of
 * its variance. `REPEATABLE` fixes the draw so the SQL published in the
 * evidence returns the same rows when the user runs it — the seed changes from
 * run to run, so a value missed today is not missed forever.
 */
// Deliberately not wrapped in a local helper. `check-sql.py` proves a SQL
// fragment came from a sanitiser by reading the call at the interpolation
// site, so a wrapper here would hide the very provenance it exists to check —
// and a wrapper that hides it is how the next unchecked fragment gets in
// wearing a safe-looking name.

/**
 * Counts how many values line up, and how concentrated the ones that do not
 * are.
 *
 * `top_unmatched` is debt N33. It reports the size of the largest single group
 * among the unmatched values and deliberately does not report the value — the
 * count is what the decision needs, and a value that never enters this process
 * is a value that cannot leak out of it.
 *
 * `distinct_unmatched` is here to keep the two apart. One value repeated
 * 232,573 times and 232,573 distinct broken links produce the same `orphans`,
 * and they are not remotely the same news.
 */
function buildMatchQuery(c: ImplicitFkCandidate, plan: ReadPlan): string {
  const child = qualified(c.childSchema, c.childTable);
  const parent = qualified(c.parentSchema, c.parentTable);
  const col = quoteIdent(c.childColumn);
  const pk = quoteIdent(c.parentColumn);

  return `
    WITH sampled AS (
      SELECT c.${col} AS v
      FROM ${child} c${tableSampleClause(plan.pct, plan.seed)}
      WHERE c.${col} IS NOT NULL
    ),
    joined AS (
      SELECT s.v AS v, (p.${pk} IS NULL) AS unmatched
      FROM sampled s
      LEFT JOIN ${parent} p ON p.${pk} = s.v
    ),
    top_unmatched AS (
      SELECT count(*)::int AS n
      FROM joined
      WHERE unmatched
      GROUP BY v
      ORDER BY count(*) DESC
      LIMIT 1
    )
    SELECT
      (SELECT count(*) FROM joined)::int                          AS present,
      (SELECT count(*) FROM joined WHERE unmatched)::int          AS orphans,
      (SELECT count(DISTINCT v) FROM joined)::int                 AS distinct_values,
      (SELECT count(DISTINCT v) FROM joined WHERE unmatched)::int AS distinct_unmatched,
      COALESCE((SELECT n FROM top_unmatched), 0)::int             AS top_unmatched
  `;
}

/**
 * A few unmatched values to show, redacted on the way out.
 *
 * `skipMostCommon` exists so the examples cannot contradict the sentence above
 * them. When a finding has set a dominant value aside as a convention and
 * reports only what is left, five copies of that same set-aside value would be
 * the worst possible illustration of it — so the same grouping that made the
 * decision picks the examples too, rather than a second rule that could
 * disagree with the first.
 *
 * The value it excludes is chosen inside Postgres and never comes back. It is
 * not read into this process, held in a variable, or sent back down as a
 * parameter: there is no step at which the raw value exists on this side.
 */
function buildOrphanSample(
  c: ImplicitFkCandidate,
  plan: ReadPlan,
  skipMostCommon: boolean,
): string {
  const child = qualified(c.childSchema, c.childTable);
  const parent = qualified(c.parentSchema, c.parentTable);
  const col = quoteIdent(c.childColumn);
  const pk = quoteIdent(c.parentColumn);

  if (!skipMostCommon) {
    // The cheap shape, and the only one Postgres can stop early on: no
    // grouping to finish, so `LIMIT 5` really does read five rows.
    return `
      SELECT c.${col} AS orphan_value
      FROM ${child} c${tableSampleClause(plan.pct, plan.seed)}
      LEFT JOIN ${parent} p ON p.${pk} = c.${col}
      WHERE c.${col} IS NOT NULL AND p.${pk} IS NULL
      LIMIT ${SAMPLE_LIMIT}
    `;
  }

  // Written out in full rather than assembled from the shape above with a
  // condition spliced in. A `WHERE` clause that arrives through an
  // interpolation is indistinguishable, to any checker and to most readers,
  // from one that arrived from somewhere less trustworthy.
  return `
    WITH unmatched AS (
      SELECT c.${col} AS v
      FROM ${child} c${tableSampleClause(plan.pct, plan.seed)}
      LEFT JOIN ${parent} p ON p.${pk} = c.${col}
      WHERE c.${col} IS NOT NULL AND p.${pk} IS NULL
    ),
    most_common AS (
      SELECT v FROM unmatched GROUP BY v ORDER BY count(*) DESC LIMIT 1
    )
    SELECT v AS orphan_value
    FROM unmatched
    WHERE v IS DISTINCT FROM (SELECT v FROM most_common)
    LIMIT ${SAMPLE_LIMIT}
  `;
}

// `redactValue` lived here and a near-identical `redact` lived in Layer A.
// They are both `redactCell` from `@ledar/contracts` now: one producer, so
// the shape a store or an Evidence Pack is asked to accept has one definition
// rather than three that agreed until they did not.

/**
 * Why a candidate never produced an answer.
 *
 * All three mean one thing to the arithmetic — no query came back for this
 * target — and three different things to a reader. A ceiling is a resource
 * limit. A failed query is a table nobody could look inside, and that is the
 * one worth asking about.
 *
 * `sample_came_back_empty` is the third, and it is new because sampling is.
 * A sampled query that returns no rows produces `present = 0`, which is also
 * what a column of nothing but NULLs produces — and those two must never be
 * allowed to merge. *Nothing there* and *nothing seen* is the distinction this
 * whole product exists to make; losing it inside Layer B's own arithmetic
 * would be losing it everywhere. It happens when the catalog's row estimate is
 * far larger than the table really is, so the percentage derived from it draws
 * no blocks at all.
 *
 * `table_too_large` used to be here and is deliberately gone. A candidate is
 * no longer set aside for being big — size now picks the reading method
 * instead, so the refusal it named cannot happen. Leaving a cause nothing can
 * produce would leave a branch in every reader's model of this that the code
 * no longer has.
 *
 * The label is set where the skip happens. It is not recovered afterwards by
 * matching the reason text: prose gets rewritten, and a check that reads
 * prose to decide what happened breaks without saying so.
 */
export type NotExaminedCause = 'budget_ceiling' | 'query_failed' | 'sample_came_back_empty';

/**
 * Why a candidate was examined and then deliberately not raised.
 *
 * One member today, and a union anyway. A second reason to let a candidate go
 * has to be named here rather than folded into the first — otherwise the
 * report loses the ability to say which restraint it exercised, which is the
 * only part of this a reader can audit.
 *
 * The second member arrived, and it arrived for the reason the union was built
 * with room in it. `unmatched_is_one_repeated_value` is not "the values do not
 * line up" — the values line up fine, 89.4% of them on RubyGems. It is that
 * everything which did not line up is *the same value*, which reads as a
 * convention the schema has and this rule does not know about. Folding the two
 * together would let a reader believe the rule doubted the relationship, when
 * what it actually doubted was one number.
 */
export type RuledOutCause = 'match_rate_too_low' | 'unmatched_is_one_repeated_value';

/** A candidate no query was run against. */
export type NotExaminedTarget = {
  target: string;
  reason: string;
  cause: NotExaminedCause;
};

/** A candidate that was queried, and whose values did not back the guess. */
export type RuledOutTarget = {
  target: string;
  reason: string;
  cause: RuledOutCause;
};

export type LayerBOutcome = {
  /**
   * `SealedFinding`, not `Finding`. Nothing in this file can build that type
   * — only `sealFindings` can — so there is no way to return a question
   * that has not been through the gate.
   */
  findings: SealedFinding[];
  candidatesConsidered: number;
  candidatesVerified: number;
  /** Folded into their parent table rather than checked separately. */
  partitionsCovered: number;

  /**
   * Candidates that were never queried. This is the coverage hole.
   *
   * `candidatesVerified + notExamined.length` cannot exceed
   * `candidatesConsidered`, because every candidate takes exactly one of the
   * two paths. That is the fraction `sealFindings` insists on, so this list
   * is the only one of the two that may ever be handed to
   * `Coverage.skipped`.
   */
  notExamined: NotExaminedTarget[];

  /**
   * Candidates that were queried, and then let go on what came back.
   *
   * These were checked. They are already inside `candidatesVerified`, and
   * counting them as skipped as well would report `checked + skipped >
   * eligible` — a fraction nobody could have arrived at, and one the seal
   * gate refuses outright.
   *
   * Kept apart from the findings rather than dropped, because restraint that
   * leaves no trace is indistinguishable from not having looked. This is the
   * scanner declining to raise an alarm it could have raised, and the reader
   * is entitled to see it happen.
   */
  ruledOut: RuledOutTarget[];

  /**
   * The three numbers above, in the shape the scope strip adds up.
   *
   * Not a second measurement — `candidatesConsidered`, `candidatesVerified`
   * and `notExamined.length` restated under the names `buildScopeStrip`
   * reads. This pack has always known its own denominator; what it lacked
   * was a way to hand it over that Layer A could match, and a report
   * assembling one line out of two differently shaped answers is a report
   * with somewhere to make a mistake.
   *
   * One entry, because this pack publishes one rule. It is here whether or
   * not that rule raised anything: a rule that found nothing and a rule that
   * reached nothing leave the same empty finding list, and dropping the entry
   * would leave the strip summing a subset under the name of a total.
   */
  rules: RuleCoverage[];

  /**
   * What was read by sample rather than in full, and how small the smallest
   * draw was.
   *
   * This exists because block sampling introduced a THIRD kind of zero, and
   * the first two took this codebase long enough. *Nothing there* is a
   * counted answer. *Nothing seen* is `sample_came_back_empty`. This is
   * *nothing in what I looked at* — a column that was sampled, came back with
   * no unmatched values, and is now sitting inside "nothing stood out" as
   * though it had been counted.
   *
   * It is not a hypothetical, and the measurement is on RubyGems.
   * `gem_downloads.version_id` holds 245 genuinely unmatched rows among
   * 2,196,473 — 0.011%. A ten-thousand-row draw expects 1.1 of them, and will
   * often see none. The rule is right to have set the sentinel aside; it is
   * not entitled to let the silence that follows read as a clean bill.
   *
   * `smallestDraw` is the smallest sample any column got, so a disclosure
   * built from it describes the WEAKEST look taken rather than an average
   * that no individual column received.
   */
  sampling: {
    /** How many columns were read by sample instead of counted. */
    columns: number;
    /** Rows in the smallest draw, or `null` when nothing was sampled. */
    smallestDraw: number | null;
  };

  /**
   * Columns whose query ran and found no rows to compare at all.
   *
   * The fourth kind of zero, and it was found the way the other three were —
   * by pointing the scanner at a public database rather than by reasoning.
   *
   * MusicBrainz: 374 tables, 344 million rows, and every one of Layer B's
   * seven candidates sits on a table holding zero rows. They are derived
   * tables the public dump ships empty. The scan then reported "checked 7 of
   * them against real values", which is false — there were no values — while
   * the scope header three lines above said "164 of 374 tables hold no rows".
   * Two sentences in one report, disagreeing.
   *
   * These stay inside `candidatesVerified`. A query ran and came back with a
   * true answer about the column, so it is checked work and filing it as a
   * coverage hole would overstate what was missed. What was wrong was never
   * the arithmetic — it was the sentence built on top of it.
   */
  columnsWithNoRows: number;

  budgetExhausted: boolean;
};

export async function runImplicitForeignKeys(
  client: Client,
  graph: SchemaGraph,
  budget: QueryBudget,
): Promise<LayerBOutcome> {
  const candidates = findCandidates(graph);
  const drafts: FindingDraft[] = [];
  const notExamined: NotExaminedTarget[] = [];
  const ruledOut: RuledOutTarget[] = [];
  let verified = 0;

  // One seed for the whole run, so every sampled column in one report was
  // drawn under the same conditions and two of them can be compared. It
  // changes between runs on purpose: a seed fixed in the source would draw the
  // same blocks of the same tables forever, which is a quieter version of the
  // bug this replaced — a permanent blind spot instead of a systematic one.
  const seed = Date.now() % 1_000_000;

  // Tracked so the report can disclose the weakest look it took. See the
  // `sampling` field on LayerBOutcome for why a silence after a sample is not
  // the same statement as a silence after a count.
  let sampledColumns = 0;
  let smallestDraw = Number.POSITIVE_INFINITY;
  let emptyColumns = 0;

  for (const c of candidates) {
    const target = `${c.childSchema}.${c.childTable}.${c.childColumn}`;

    if (!budget.canAfford(target)) {
      notExamined.push({
        target,
        reason: 'the scan reached its ceiling on this database',
        cause: 'budget_ceiling',
      });
      continue;
    }

    // Size no longer decides whether this column gets looked at — only how.
    // A table above the exact threshold is sampled by blocks, which costs a
    // percentage of it rather than all of it, and that is what made it
    // possible to stop turning big tables away.
    const plan = planFor(c, seed);

    let present = 0;
    let orphans = 0;
    let distinct = 0;
    let distinctUnmatched = 0;
    let topUnmatched = 0;
    let durationMs = 0;

    // Stamped before the statement is sent, and stamped per candidate.
    //
    // Postgres takes a statement's snapshot as it begins, so this is the
    // moment the counts below were true of the database — not the moment the
    // answer arrived, and certainly not the moment the scan started. A scan
    // of a few hundred tables runs long enough for somebody to be writing to
    // it throughout, and a claim carrying the run's start time would be
    // dating itself by an event it has nothing to do with.
    const observedAt = new Date().toISOString();

    try {
      const t0 = performance.now();
      const res = await client.query(buildMatchQuery(c, plan));
      durationMs = performance.now() - t0;

      present = Number(res.rows[0]?.present ?? 0);
      orphans = Number(res.rows[0]?.orphans ?? 0);
      distinct = Number(res.rows[0]?.distinct_values ?? 0);
      distinctUnmatched = Number(res.rows[0]?.distinct_unmatched ?? 0);
      topUnmatched = Number(res.rows[0]?.top_unmatched ?? 0);
      budget.record(durationMs, present);
    } catch (err) {
      budget.record(0, 0);
      // `verified` is counted below, past every path that leaves without an
      // answer, so a query that threw has not been counted as checked. It
      // belongs here, unexamined: a column nobody could read is not a column
      // that came back clean.
      notExamined.push({
        target,
        reason: err instanceof Error ? err.message : String(err),
        cause: 'query_failed',
      });
      continue;
    }

    // Two different zeroes, and merging them would be the product's own
    // central mistake committed inside its own arithmetic.
    //
    // On the exact path, `present = 0` means the column really is entirely
    // null — a read that happened and found nothing. On the sampled path it
    // means the draw came back empty, which is a read that did not happen.
    // That second case is real: `damaged_bulk_link` carries a catalog estimate
    // of 900,000 rows and holds twelve, so the percentage derived from the
    // estimate asks for a thousandth of a table that is one block long.
    if (present === 0) {
      if (plan.kind === 'exact') {
        // Counted, and the answer is that there was nothing to compare —
        // either the column holds nothing but NULLs, or the table holds no
        // rows at all. That is a result about the column, so it is checked
        // work; it is counted separately so the report can stop describing it
        // as values that were examined.
        verified += 1;
        emptyColumns += 1;
        continue;
      }
      // A query ran and cost the database something — the budget was charged
      // above, and that stands. But nothing was learned about these values, so
      // this cannot be counted as a target that was checked. It is the
      // coverage hole, which is precisely what `notExamined` is for.
      notExamined.push({
        target,
        reason:
          `the catalog estimates ${(c.childRowsEstimated ?? 0).toLocaleString('en-US')} ` +
          `rows, so ${plan.pct.toFixed(4)}% of the table was drawn — and that ` +
          `came back with nothing in it. Either the estimate is far too high ` +
          `or the sample was unlucky; nothing here can tell you which, so ` +
          `nothing here is claiming this column is clean`,
        cause: 'sample_came_back_empty',
      });
      continue;
    }

    // Past every path that leaves without an answer, so this column really was
    // examined: values came back and were counted.
    verified += 1;

    if (plan.kind === 'sample') {
      sampledColumns += 1;
      smallestDraw = Math.min(smallestDraw, present);
    }

    if (orphans === 0) continue; // behaves like a reference and holds

    // How much of the unmatched set is one value repeated. Debt N33: a
    // convention and a mass of broken links produce the same `orphans`, and
    // this is the only number that separates them.
    const dominantShare = topUnmatched / orphans;
    const oneValueDominates =
      topUnmatched >= SENTINEL_MIN_REPEATS && dominantShare >= SENTINEL_SHARE;
    const setAside = oneValueDominates ? topUnmatched : 0;

    // What is left once a probable convention is set aside — and the number
    // every sentence below is built from. Subtracting rather than discarding
    // the whole column is the difference between suppressing a false positive
    // and suppressing the genuine orphans hiding behind it.
    const residual = orphans - setAside;

    if (oneValueDominates && residual === 0) {
      ruledOut.push({
        target,
        reason:
          `all ${orphans.toLocaleString('en-US')} values that match no ` +
          `${c.parentTable} record are the same single value, repeated. One ` +
          `value that many times reads as something this schema uses to mean ` +
          `"none" or "all", not as that many broken links — so this is not ` +
          `being raised as a question`,
        cause: 'unmatched_is_one_repeated_value',
      });
      continue;
    }

    const matchRate = (present - residual) / present;
    if (matchRate < MIN_MATCH_RATE) {
      // Checked, and then let go. The query ran, the values were counted, and
      // the count is what says no — so this is a result, not a gap.
      ruledOut.push({
        target,
        reason: `only ${(matchRate * 100).toFixed(0)}% of values line up with ${c.parentTable} — the name matching is probably a coincidence, not a reference`,
        cause: 'match_rate_too_low',
      });
      continue;
    }

    let sample: Record<string, unknown>[] = [];
    if (budget.canAfford(`${target} sample`)) {
      try {
        const t1 = performance.now();
        const s = await client.query(buildOrphanSample(c, plan, oneValueDominates));
        budget.record(performance.now() - t1, s.rows.length);
        sample = s.rows.map((r) => ({ orphan_value: redactCell(r.orphan_value) }));
      } catch {
        // A sample is a nicety. Its absence does not weaken the count.
      }
    }

    const evidence: Evidence = {
      sql: buildMatchQuery(c, plan).trim(),
      rowCount: residual,

      // How many rows were looked at to arrive at `rowCount` — on both paths,
      // and that is a deliberate reversal of a first attempt at this.
      //
      // Nulling it on the exact path looked principled: `sampleSize` is
      // documented as null "when rowCount is a straight count rather than an
      // estimate off a sample", and an exact read is a straight count. But the
      // field's other sentence is the one that governs — it is the denominator
      // the published sentence is built from, and "5 of the 25 rows" has a
      // denominator whether or not those 25 were a sample. Nulling it deleted
      // a number the report goes on to print, and took a tripwire down with
      // it: the check that Layer B never reads an empty cell works by
      // comparing this against the table's real row count.
      //
      // Which path ran is not carried by omitting a number. It is carried in
      // the sentences, which say "I looked at N rows drawn from across" in so
      // many words, and in `evidence.sql`, which either contains a TABLESAMPLE
      // clause or does not. Both of those are readable; an absent field is
      // only ambiguous.
      sampleSize: present,
      durationMs,
      sample,
    };

    const pct = ((residual / present) * 100).toFixed(1);

    // One unmatched row is the ordinary result once a sentinel has been set
    // aside, and "those 1 are leftovers" is how a report starts sounding like
    // a machine that has not read itself.
    const carry = residual === 1 ? 'carries' : 'carry';

    const finding: FindingDraft = {
      id: `layer-b/implicit-fk/${target}`,
      rule: IMPLICIT_FK_RULE,
      kind: 'inference',
      confidence: 'unconfirmed',
      severity: 'medium',

      // `name_pattern`, although values were sampled and counted — and that
      // is the whole of it, so it is worth writing down.
      //
      // This finding asserts two things. That some values do not line up: a
      // measurement, bounded and reproducible from `evidence.sql`. And that
      // this column *is* a reference at all: a guess, made from two names
      // looking alike, before a single value was compared. The second is
      // where every bit of the uncertainty lives, and `origin` has to name
      // the weaker half or it stops describing the claim.
      //
      // Calling it `sampled` would be an upgrade in the wrong direction.
      // `CEILING` lets `sample_extrapolation` reach `probable`, so this rule
      // would become entitled to say the thing it is here to *not* say — a
      // pattern spoken of with more confidence than the person who owns the
      // system has given it. `name_similarity` caps it at `unconfirmed`,
      // which is what the finding already declares about itself: AGENTS.md
      // §3 ③ with a machine behind it instead of an author's memory.
      //
      // The sampling is not hidden by this: it is stated where it belongs,
      // in `evidence.sampleSize` and `coverage.truncatedAt`.
      origin: 'name_pattern',
      confidenceBasis: 'name_similarity',
      egressClass: EGRESS,
      observedAt,
      engineRuleVersion: LAYER_B_RULE_VERSION,

      schema: c.childSchema,
      table: c.childTable,
      columns: [c.childColumn],

      // Two sentences, because there are two different measurements and only
      // one of them may be described as the state of the column.
      //
      // The exact one counts every non-null value, so "X of the Y rows" is
      // literally what happened. The sampled one looked at part of the table
      // and has to say so in the same breath as the number — the version of
      // this sentence that did not is what let a scan print "98.0%" about a
      // column that was 86.9%, and print it in the confident voice reserved
      // for things that were counted.
      //
      // No arithmetic here multiplies the rate back up by the table size.
      // That number would be a claim about rows nobody looked at, dressed as
      // a total, and this rule is capped at `unconfirmed` precisely because it
      // is not entitled to make claims of that shape.
      plainText:
        (plan.kind === 'exact'
          ? `${residual.toLocaleString('en-US')} of the ${present.toLocaleString('en-US')} ` +
            `rows in ${c.childTable} ${carry} a ${c.childColumn} that no ` +
            `${c.parentTable} record matches. `
          : `I looked at ${present.toLocaleString('en-US')} rows drawn from across ` +
            `${c.childTable} — not the whole table — and ${residual.toLocaleString('en-US')} ` +
            `of them ${carry} a ${c.childColumn} that no ${c.parentTable} record ` +
            `matches, which is ${pct}% of what I looked at. I did not count the ` +
            `rest of the table, so I cannot tell you how many there are in total. `) +
        (setAside > 0
          ? `First, set aside: a further ${setAside.toLocaleString('en-US')} rows all ` +
            `carry one and the same value. One value repeating that many times ` +
            `reads like something this schema uses to mean "none" or "all", so I ` +
            `did not count those as unmatched. `
          : '') +
        `The other ${(matchRate * 100).toFixed(0)}% match, so the column does look ` +
        `like it points at ${c.parentTable}. Nothing in the database enforces ` +
        `that, so I cannot tell whether ` +
        (residual === 1
          ? `that one row is a leftover you would want to know about, or a row `
          : `those ${residual.toLocaleString('en-US')} are leftovers you would want ` +
            `to know about, or rows `) +
        `kept deliberately.`,

      technical:
        `${c.childSchema}.${c.childTable}.${c.childColumn} (${distinct} distinct ` +
        `values over ${present} non-null rows ` +
        (plan.kind === 'exact'
          ? `— every one of them, counted`
          : `sampled with TABLESAMPLE SYSTEM (${plan.pct.toFixed(4)}%) ` +
            `REPEATABLE (${plan.seed}) from an estimated ` +
            `${(c.childRowsEstimated ?? 0).toLocaleString('en-US')}`) +
        `) matches ${c.parentSchema}.${c.parentTable}.${c.parentColumn} at ` +
        `${(matchRate * 100).toFixed(1)}%, with ${residual} unmatched (${pct}%)` +
        (setAside > 0
          ? `, after setting aside ${setAside} rows sharing a single value ` +
            `(${(dominantShare * 100).toFixed(1)}% of the ${orphans} that did not match)`
          : '') +
        `. No foreign key is declared between them.`,

      evidence,
      coverage: {
        checked: 1,
        eligible: 1,
        skipped: [],
        // Nothing was truncated. A sample is not a count that stopped early —
        // it is a different measurement, and `evidence.sampleSize` is the
        // field that says so. Reusing `truncatedAt` for it would print
        // "counting stopped at 10,000 — there may be more" over a number that
        // never was a count.
        truncatedAt: null,
      },
    };

    drafts.push(finding);
  }

  return {
    // Refuses the batch if the wording ever drifts into calling one of these
    // a defect, or if a coverage number stops adding up.
    findings: sealFindings(drafts, 'layer-b'),
    candidatesConsidered: candidates.length,
    candidatesVerified: verified,
    partitionsCovered: graph.tables.filter((t) => t.isPartition).length,
    notExamined,
    ruledOut,
    rules: [
      {
        rule: IMPLICIT_FK_RULE,
        // True because this is built after the loop finished. A ceiling
        // reached part way through is not this rule failing to run — it is
        // this rule not reaching everything, which `notChecked` already says.
        // `budgetExhausted` still travels separately, where it can be read as
        // the cause it is rather than folded into a second word for the same
        // hole.
        ran: true,
        eligible: candidates.length,
        // Every candidate in `ruledOut` is inside this number. The query ran,
        // the values were counted, and the count is what said no — that is a
        // result, not a gap, and filing it as one would overstate the hole
        // and understate the work in a single move.
        checked: verified,
        notChecked: notExamined.length,
      },
    ],
    sampling: {
      columns: sampledColumns,
      smallestDraw: sampledColumns === 0 ? null : smallestDraw,
    },
    columnsWithNoRows: emptyColumns,
    budgetExhausted: budget.exhausted,
  };
}

/**
 * The question that has to be asked before any of this becomes a finding.
 *
 * Written for someone who does not read schemas, and deliberately offering
 * "that is on purpose" as a first-class answer rather than a way of
 * dismissing an alert.
 */
export function semanticQuestionFor(finding: Finding): string {
  const table = finding.table;
  const column = finding.columns[0] ?? 'this column';
  return (
    `In ${table}, is ${column} meant to always point at a record that still ` +
    `exists?\n` +
    `  • Yes — then the rows I found are leftovers, and worth cleaning up.\n` +
    `  • No, that is on purpose — then this is not a problem and I will stop ` +
    `raising it.\n` +
    `  • I don't know — then it is worth asking whoever built this.`
  );
}
