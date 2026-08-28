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
import {
  DOMAIN_FOLLOW_LIMIT,
  admitMissing,
  coverageOf,
  followDomains,
  sealFindings,
  translator,
} from '@ledar/contracts';
import type {
  Coverage,
  FindingDraft,
  Lang,
  MissingAdmission,
  PgTypeLink,
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
export const USER_RULE_VERSION = 'user-rules@1.3.0';
// 1.0.0 -> 1.1.0 on 2026-08-27: `is-never-missing` now counts a blank string
// and a whitespace-only string as missing, where it counted only NULL before.
// The bump is not bookkeeping. `diffRuns` refuses to attribute change across
// a version boundary, and without it the next scan of a table like
// `public.address` would show a count leaping 4 -> 1003 and report it as
// something that happened to the DATA. Nothing happened to the data; the
// question changed.
//
// 1.1.0 -> 1.2.0 on 2026-08-27: `is-never-missing` reads the column's type
// and admits on it. The bump was NOT taken for granted — it was measured,
// because a version bumped by reflex is a version that stops meaning
// anything, and this string is the one thing standing between `diffRuns` and
// a false attribution.
//
// What 1.2.0 counts, against what 1.1.0 counted, on the fixture:
//
//   text        `NULL OR btrim(col::text) = ''`  ->  same clause.  1003 = 1003
//   scalar      an integer never renders as the empty string, so 1.1.0's
//               btrim clause could not fire on one          ->   1000 = 1000
//   structured  `{}`, `{}`::json and an empty bytea all render with visible
//               characters, so that clause could not fire there either
//
// So for every column that still gets an answer, the NUMBER is unchanged.
// The bump is earned by the columns that no longer get one. Measured, not
// argued: `public.film.fulltext` is a `tsvector`, and under 1.1.0
//
//   SELECT count(*) FROM film WHERE fulltext IS NULL OR btrim(fulltext::text) = ''
//   -> 0
//
// which the runner published as a `negative` finding — *all 1000 rows match
// your rule*. 1.2.0 declines instead, so that finding is simply absent from
// the next run. Held at 1.1.0, `diffRuns` would match the two runs and report
// a finding that disappeared, which reads as *somebody fixed it*. Nobody
// fixed anything; the product stopped answering a question it had never
// decided. §4.1b — a true observation with a cause no measurement supports.
//
// Minor rather than major: no finding changed shape, and no count moved.
//
// 1.2.0 -> 1.3.0 on 2026-08-27: the admission is decided on `pg_type.typtype`
// instead of on the `information_schema` label. An enum runs as `scalar`; a
// range and a multirange run as `structured`; a domain follows its base type;
// a composite, a pseudo-type and an extension type nobody decided still
// refuse. Same measurement discipline as the bump above, run the same way —
// every column of every base table in `public` on the fixture, old input
// beside new:
//
//   data_type       resolves to                1.2.0        1.3.0        cols
//   ARRAY           text[]        (array)      structured   structured      1
//   text/integer/…  same spelling (pg_catalog) unchanged    unchanged     512
//   tsvector        tsvector      (base)       unsupported  unsupported     1
//   USER-DEFINED    mpaa_rating   (enum)       UNSUPPORTED  SCALAR          1
//
// One column moved, and it moved the direction 1.2.0 moved `film.fulltext`
// in reverse: `public.film.rating` refused under 1.2.0 and now answers, 0 of
// 1000. No count moved for any column that already had one — `integer` above
// includes `film.release_year`, a domain over `int4`, which was `scalar` by
// way of the label and is now `scalar` by way of its base type.
//
// So the bump is earned by exactly the columns that begin getting an answer.
// Held at 1.2.0, `diffRuns` would match the two runs and report a `film.rating`
// finding that APPEARED, which reads as *something went wrong in the data*.
// Nothing went wrong; the product started answering a question it had finally
// decided.
//
// Minor rather than major: no finding changed shape, no count moved, and no
// column that answered stopped answering.

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
 * A column whose type this product has not decided about.
 *
 * ## 🟥 Why this is a throw and not a field on the outcome
 *
 * The brief put the choice plainly — a thrown refusal, or an outcome the
 * caller renders — and both are defensible. This one is the throw, for three
 * reasons that are about this repository rather than about taste.
 *
 * **1. There is no caller.** `apps/cli/src/scan.ts` says so at the site:
 * *"VS-6 has no screens and nothing here calls `runRule`"*. An outcome field
 * is a promise that some future caller will print it, and AGENTS.md §4.3 has
 * a name for that shape — *cổng không ai gọi thì không phải cổng* — and §4.23
 * says the same thing again: a label is not a gate, only a runtime that
 * refuses is. Choosing the outcome today would be choosing the silent option
 * and writing a comment asking whoever builds the screen to be careful. That
 * is the exact move the audit rejected.
 *
 * **2. This file already has one shape for "must not run", and a second one
 * would be the same mistake in miniature.** `!rule.expressible` throws.
 * `quoteIdent` throws on a name it cannot make safe. A rule pointed at a type
 * with no decided meaning belongs in that set, and every caller already has
 * to handle it, so nothing new is asked of anybody.
 *
 * **3. `budget_ceiling` is a different category and the difference is load
 * bearing.** A budget skip means *I could have answered and chose not to
 * spend*: same question, deferred, retryable. This means *nobody has decided
 * what the question means for this column*. Filing them under one mechanism
 * would let a reader take "not examined" for a deferral, and this project has
 * spent a lot of comments keeping BROKEN from rendering as EMPTY.
 *
 * ## What it costs, said out loud
 *
 * One refused rule aborts a batch that does not catch. That is the price, and
 * it is paid deliberately: a batch runner catches PER RULE — it already must,
 * for the two throws above — and this class exists so it can catch exactly
 * this and turn it into whatever its surface renders, matching on a TYPE
 * rather than on the words in a message. §4.1b: a cause is labelled where it
 * happens, never recovered by matching prose.
 */
export class UnsupportedColumnType extends Error {
  /**
   * The column, as the refusing layer knew it: `schema.table.column` from
   * `runRule`, the quoted identifier from `missingPredicate`. Either way it
   * names the THING that was refused rather than the rule that named it,
   * which is what somebody reading the refusal needs.
   */
  readonly column: string;
  /**
   * What `information_schema` said, verbatim — or `null` when the column's
   * type could not be read at all, which is a refusal for the same reason.
   */
  readonly dataType: string | null;
  /**
   * What the type actually is, once the domains have been walked off:
   * `format_type` on the resolved type, or `null` when nothing resolved.
   *
   * 🟥 Carried separately because the two can differ, and the difference is
   * the entire subject of this revision. `information_schema` files every
   * enum, composite, range and extension type under `USER-DEFINED`; refusing
   * a column and reporting only that label would be the product hiding what
   * it had already read. A refusal that names `USER-DEFINED (public.some_row)`
   * tells somebody what to go and decide about.
   */
  readonly typeName: string | null;

  constructor(column: string, dataType: string | null, typeName: string | null = null) {
    const named =
      typeName === null || typeName === dataType ? dataType : `${dataType} (${typeName})`;
    super(
      dataType === null
        ? `Refusing to check ${column}: this connection cannot read its type, ` +
            `so there is no way to know what an empty value would be. A check ` +
            `that cannot say what it is counting does not get to return a number.`
        : `Refusing to check ${column}: nothing has been decided about what ` +
            `counts as empty for a column of type ${named}. Casting it to ` +
            `text in order to guess is how a check comes to report a confident ` +
            `number about a question nobody asked.`,
    );
    this.name = 'UnsupportedColumnType';
    this.column = column;
    this.dataType = dataType;
    this.typeName = typeName;
  }
}

/**
 * The WHERE clause that decides what counts as nothing recorded.
 *
 * Takes an ALREADY-QUOTED identifier, and that is not an oversight. The only
 * claim `infra/check-sql.py` can follow is a `quoteIdent` call visible in the
 * expression that built the fragment; a raw name laundered in here and quoted
 * out of sight would be a fragment the tool has to take on trust. So the call
 * site does the quoting where the tool can see it, and this function never
 * meets an unquoted name at all.
 *
 * Exhaustive on `MissingAdmission` on purpose. Adding a member breaks this
 * switch and the one in `missingMeaningKey` at the same time, which is the
 * property a shared string could never have — and the reason the meaning is a
 * closed value rather than a sentence repeated in two packages.
 */
export function missingPredicate(quotedColumn: string, admission: MissingAdmission): string {
  switch (admission) {
    case 'text':
      // `btrim` because a column holding only spaces is empty to the person
      // who asked whether every member has an email on file, and that person
      // is the one the read-back sentence is written for.
      return `${quotedColumn} IS NULL OR btrim(${quotedColumn}::text) = ''`;
    case 'scalar':
      // NULL and nothing else. A number, a timestamp, a boolean or an ENUM
      // has no empty form the database would hand back — `''` is not a member
      // of any enum — so a text clause here would be one that can never fire,
      // and a clause that cannot fire still has to be explained to whoever
      // reads the sentence.
      return `${quotedColumn} IS NULL`;
    case 'structured':
      // Also NULL and nothing else, and for a different reason worth not
      // collapsing into the one above: an empty array is a VALUE, and so is
      // an empty range. Somebody wrote `{}` or `empty` there, and counting it
      // as missing would be this product disagreeing with the database about
      // what was recorded. Measured on the fixture: `'empty'::int4range IS
      // NULL` is false, so this predicate keeps it, which is what the
      // structured sentence promises.
      return `${quotedColumn} IS NULL`;
    case 'unsupported':
      // No predicate exists, so none is returned. The caller has already been
      // given the column name; this path is reached only by code that skipped
      // the check that decides whether a query exists at all.
      throw new UnsupportedColumnType(quotedColumn, null);
  }
}

/**
 * What the column's type IS, read on the live connection.
 *
 * Two questions in one statement, and they are deliberately answered by two
 * different parts of the database:
 *
 * **Is this column visible to me?** — `information_schema.columns`. That view
 * shows a role only the columns it holds some privilege on, so an absent row
 * means *not visible from here*. Reading `pg_attribute` alone would lose that
 * filter and classify a column this connection cannot select, turning a clean
 * refusal into a permission error halfway through a count.
 *
 * **What is the type?** — `pg_type`, walked. `information_schema.data_type`
 * is not asked and could not answer: it files every enum, composite, range
 * and extension type under the single label `USER-DEFINED`, and for a domain
 * it unwraps exactly ONE level and only when the base lands in `pg_catalog`.
 * `data_type` is carried out of here as a LABEL for the refusal message and
 * reaches no decision.
 *
 * The two sides are matched on the same three bound parameters rather than by
 * joining the view's output back to the catalog — the statement then says
 * what it is doing, which is asking two authorities the same question.
 *
 * The recursive arm is the domain walk: a domain's `typbasetype` is its base,
 * a base can be another domain, and the walk stops at `DOMAIN_FOLLOW_LIMIT`.
 * Rows come back ordered from the column's own type outward, which is the
 * ordering `followDomains` reads.
 *
 * Hard rule ⑤ — values bind, identifiers never concatenate. The schema, table
 * and column names are being COMPARED here, not spliced: they are values.
 * The one interpolation is a module constant integer.
 */
const COLUMN_TYPE_SQL = `
  WITH RECURSIVE visible AS (
    SELECT a.atttypid AS type_oid, i.data_type AS data_type
    FROM information_schema.columns i
    JOIN pg_catalog.pg_class c ON c.relname = $2
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = c.oid AND a.attname = $3
     AND a.attnum > 0 AND NOT a.attisdropped
    WHERE i.table_schema = $1 AND i.table_name = $2 AND i.column_name = $3
  ),
  chain AS (
    SELECT t.oid AS oid, t.typtype AS typtype, t.typbasetype AS typbasetype, 0 AS depth
    FROM visible v
    JOIN pg_catalog.pg_type t ON t.oid = v.type_oid
    UNION ALL
    SELECT b.oid, b.typtype, b.typbasetype, ch.depth + 1
    FROM chain ch
    JOIN pg_catalog.pg_type b ON b.oid = ch.typbasetype
    WHERE ch.typtype = 'd' AND ch.depth < ${DOMAIN_FOLLOW_LIMIT}
  )
  SELECT
    (SELECT data_type FROM visible) AS data_type,
    ch.depth AS depth,
    t.typtype AS typtype,
    t.typname AS type_name,
    tn.nspname AS type_schema,
    pg_catalog.format_type(t.oid, NULL) AS spelling,
    (t.typelem <> 0 AND t.typlen = -1) AS is_array,
    (SELECT e.extname
       FROM pg_catalog.pg_depend d
       JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
      WHERE d.classid = 'pg_type'::regclass
        AND d.objid = t.oid
        AND d.refclassid = 'pg_extension'::regclass
        AND d.deptype = 'e'
      LIMIT 1) AS extension
  FROM chain ch
  JOIN pg_catalog.pg_type t ON t.oid = ch.oid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  ORDER BY ch.depth
`;

/** One row of `COLUMN_TYPE_SQL`, before it becomes a `PgTypeLink`. */
type TypeChainRow = {
  data_type: string | null;
  depth: number;
  typtype: string;
  type_name: string;
  type_schema: string;
  spelling: string;
  is_array: boolean;
  extension: string | null;
};

/**
 * What this column's type IS, according to the database it is about to be
 * counted in. Facts only — no admission is decided here.
 *
 * Read here rather than off a catalogue captured earlier in the run, and the
 * reason is not tidiness: a snapshot can be older than the column. Somebody
 * altering a column between discovery and the count would have the check
 * answer a question about the type it USED to be, and answer it confidently.
 *
 * Queried with bound parameters. Hard rule ⑤ — values bind, identifiers never
 * concatenate — and here they are values: the schema, table and column names
 * are being COMPARED, not spliced into a statement. Nothing in this query is
 * built from a string.
 *
 * Exported for one reason worth stating, because "exported for the tests" is
 * usually a smell: the suite has to measure the DOMAIN WALK, and a walk it
 * re-implemented to look at would be a second copy of the thing under test —
 * §4.3, the two redactors that agreed on every branch anybody ran. Calling
 * this is the only way for a test to see the query production actually sends.
 */
export async function readColumnType(
  client: Client,
  schema: string,
  table: string,
  column: string,
): Promise<{ dataType: string | null; chain: PgTypeLink[]; durationMs: number }> {
  const t0 = performance.now();
  const res = await client.query(COLUMN_TYPE_SQL, [schema, table, column]);
  const durationMs = performance.now() - t0;

  if (res.rows.length === 0) {
    // `information_schema.columns` shows a role only the columns it holds some
    // privilege on, so an absent row is "not visible from here", not "does not
    // exist". Either way the type is unknown, and unknown is refused rather
    // than defaulted — the whole point of `admitMissing` failing closed.
    return { dataType: null, chain: [], durationMs };
  }

  const rows = res.rows as TypeChainRow[];
  // Facts across the boundary, judgement on the other side. Nothing is
  // decided here — the mapping is field-for-field, and `@ledar/contracts` owns
  // what any of it means.
  const chain: PgTypeLink[] = rows.map((r) => ({
    typtype: String(r.typtype),
    name: String(r.type_name),
    schema: String(r.type_schema),
    spelling: String(r.spelling),
    isArray: r.is_array === true,
    extension: r.extension === null ? null : String(r.extension),
  }));

  const head = rows[0]!;
  return { dataType: head.data_type === null ? null : String(head.data_type), chain, durationMs };
}

async function readAdmission(
  client: Client,
  schema: string,
  table: string,
  column: string,
): Promise<{
  admission: MissingAdmission;
  dataType: string | null;
  typeName: string | null;
  durationMs: number;
}> {
  const { dataType, chain, durationMs } = await readColumnType(client, schema, table, column);

  if (chain.length === 0) {
    return { admission: 'unsupported', dataType, typeName: null, durationMs };
  }

  // The type the policy actually judged, for the refusal message. When the
  // domain walk did not finish, the deepest link reached is the honest thing
  // to name — it says where the product stopped rather than what it decided.
  const named = followDomains(chain) ?? chain[chain.length - 1]!;

  return { admission: admitMissing(chain), dataType, typeName: named.spelling, durationMs };
}

/**
 * The SQL for one rule.
 *
 * Exported because it is the part worth reading on its own, and because a test
 * can assert on the text without a database. Every identifier in it went
 * through `quoteIdent`, which is the only claim `check-sql.py` can prove.
 *
 * `admission` is what the column's type admits as missing, read from the live
 * connection by `readAdmission`. It is `null` for the two checks that have no
 * use for it, and `null` on an `is-never-missing` rule is refused rather than
 * defaulted: a missing check built with no type information is precisely the
 * bug this parameter exists to end, so it must not be a reachable state.
 */
export function buildRuleQuery(rule: SealedRule, admission: MissingAdmission | null): string {
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
    if (admission === null) {
      throw new Error(
        `Refusing to build a missing check for ${rule.table}.${rule.columns[0]} ` +
          `without knowing the column's type. What counts as empty depends on ` +
          `it — a blank string is nothing recorded in a text column and cannot ` +
          `exist in a numeric one — and a check that guesses is the exact fault ` +
          `this argument was added to close.`,
      );
    }
    // The quoting happens HERE, in the expression `check-sql.py` reads, so the
    // tool can follow the identifier into the fragment. `missingPredicate`
    // never sees an unquoted name.
    const missing = missingPredicate(quoteIdent(rule.columns[0]!), admission);
    // 🟥 Settled 2026-08-27. Before that the predicate decided what "empty"
    // meant and `rule.will-check.is-never-missing` said it in words, and the
    // two disagreed in shipped code: on stock Pagila `public.address.address2`
    // holds 4 nulls and 999 empty strings in 1003 rows, so the product
    // answered 4 to a sentence a reader would price at 1003.
    //
    // Both now come off `MissingAdmission`. The predicate above switches on
    // it; `missingMeaningKey` in `@ledar/contracts` picks the sentence from
    // the same value; and `missing-admission.pagila.test.ts` puts the two side
    // by side on real rows for every member of `MISSING_ADMISSIONS`. Adding a
    // member breaks both switches at compile time.
    //
    // ⚠️ The one thing the fixture cannot show, written down so nobody reads
    // the suite as covering more than it does: measured 2026-08-27, NO text
    // column in any base table of Pagila holds a whitespace-only value. The
    // `btrim` clause is therefore a no-op against live fixture rows, and it is
    // pinned by probe values instead (§4.24 — a mutation can be green because
    // it changed nothing).
    return `
      SELECT count(*)::int AS n
      FROM (
        SELECT 1 FROM ${target}
        WHERE ${missing}
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

  // What "empty" means is a property of the COLUMN, so it is read from the
  // connection the count is about to run on — not from a catalogue captured
  // earlier in the run, which can be older than the column it describes.
  //
  // Only for `is-never-missing`. The other two checks do not consult it, and
  // spending a query on somebody's database to answer a question nothing asks
  // is not free.
  //
  // 🟥 The refusal below is raised BEFORE the counting query and before the
  // eligible query, so nothing is counted for a column whose meaning of empty
  // nobody has decided. It is not raised before the type read, because the
  // type read is what DISCOVERS the refusal — saying that plainly is better
  // than implying no query ran at all.
  let admission: MissingAdmission | null = null;
  if (rule.check === 'is-never-missing') {
    const read = await readAdmission(client, schema, table, rule.columns[0]!);
    budget.record(read.durationMs, 1);
    if (read.admission === 'unsupported') {
      throw new UnsupportedColumnType(
        `${rule.table}.${rule.columns[0]}`,
        read.dataType,
        read.typeName,
      );
    }
    admission = read.admission;
  }

  const sql = buildRuleQuery(rule, admission);
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
    // One sentence for all three kinds, and it was always the right one for
    // all three: *I checked the rule exactly as it was read back to you; I did
    // not check whether that is the rule you meant.* That limits a rule which
    // found rows exactly as much as it limits one which found none.
    //
    // The old note here argued the opposite — that `boundary` belonged only to
    // the kinds asserting nothing is wrong, because *"an observation asserts
    // the opposite"*. The asserting is the point: an observation makes a claim
    // ABOUT somebody's data, and a claim with no stated limit is read as the
    // whole of the matter. Debt N50.
    //
    // ⚠️ It is on every finding as DATA. Whether it is PRINTED beside every
    // one is a different question with a measured answer: `buildUserRuleSection`
    // suppresses a boundary that every entry in the section shares, because
    // VS-7 found what per-finding repetition costs — one sentence printed
    // three times in sixty lines stops being read — and `scan.you-asked-preamble`
    // already carries this one once, above the list.
    boundary: T('user-rule.boundary'),
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
  // Not style: `Finding` is a discriminated union, and a single literal with
  // `kind` typed as a union of three narrows to nothing. The only ways past
  // that are a cast or this, and a cast here would be a cast on the one
  // object the whole product treats as evidence.
  //
  // ⚠️ The reason USED to be `boundary`, which existed on only two of the
  // three kinds. Since N50 every finding carries one, so the boundary now
  // sits in `common` with everything else — and it is the SAME sentence for
  // all three branches, which was always true and only looked like a
  // coincidence while two kinds had the field and one did not. "I checked the
  // rule as it was read back to you; I did not check whether that is the rule
  // you meant" limits a rule that found rows exactly as much as it limits one
  // that found none. The narrowing problem is real and the branch stays; the
  // duplicated sentence is gone.
  const draft: FindingDraft =
    n > 0
      ? { ...common, kind: 'observation' }
      : total > 0
        ? { ...common, kind: 'negative' }
        : { ...common, kind: 'abstained' };

  const findings = sealFindings([draft], 'rule-runner');
  return { findings, coverage: reached };
}
