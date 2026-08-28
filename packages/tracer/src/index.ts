/**
 * G3's runner: walks the routes a lookup chose and reports what it found.
 *
 * `_doc/29` G3 draws the line this file sits on:
 *
 * > *"model KHÔNG viết câu, KHÔNG viết SQL. Nó CHỌN … sản phẩm chạy truy vấn,
 * > sản phẩm viết câu."*
 *
 * Everything a model may decide has already been decided and checked by
 * `sealLookup` before anything here runs. What arrives is a `SealedLookup` and
 * the menu it was checked against; what leaves is a `Timeline`. No prose is
 * generated here and no identifier reaches SQL except through `quoteIdent`.
 *
 * ## The three things it refuses to do
 *
 * **① It never invents a join.** A route whose edges do not all record their
 * columns is reported as unwalkable — `rows: null` — rather than joined on a
 * guess. `guessed` edges are exactly this case by construction: the map
 * matched a table NAME and never looked for a column. Filling in the primary
 * key would produce a query that runs, returns rows, and answers a question
 * about a relationship nobody established.
 *
 * **② It never reads a row's values.** Every query here is `count(*)` and
 * `min(<time column>)`. A timeline says what happened and when; it does not
 * need anybody's data to say it, and not fetching the data is cheaper than
 * redacting it afterwards.
 *
 * **③ It never counts past a limit.** `COUNT_LIMIT` caps every count, exactly
 * as the rule packs do, so a question asked about a large table cannot become
 * an outage on somebody else's database.
 *
 * ## What it costs the database
 *
 * One catalog query for the time columns, then one query per route, plus one
 * more for the similar-case count when a route broke. A route is a join of at
 * most `hops` tables filtered to a single subject row.
 */

import type { Client } from 'pg';

import { QueryBudget, qualified, quoteIdent } from '@ledar/connector-postgres';
import type { BudgetLimits } from '@ledar/connector-postgres';
import { refOf, resolveLookup, timelineFrom } from '@ledar/contracts';
import type {
  EntityEdge,
  HopResult,
  LookupOffer,
  OfferedPath,
  SealedLookup,
  Timeline,
} from '@ledar/contracts';

/**
 * The ceiling on every count in this file.
 *
 * Same value and same reasoning as the rule packs: a person asking why one
 * order is missing does not need to know whether the answer is 9,999 or
 * 90,000, and the difference between those two numbers can be minutes of
 * somebody's production database.
 */
const COUNT_LIMIT = 10000;

/** How many other subjects to look at when counting similar cases. */
const SIMILAR_LIMIT = 1000;

/**
 * What answering ONE question is allowed to cost somebody else's database.
 *
 * ## 🟥 Why this exists at all
 *
 * ㉜c measured a question containing the words *"follow every route"* turning
 * two route walks into nine, four times out of four, in both languages. Every
 * route it named was real, so `sealLookup` passed it — correctly: the seal
 * answers *"does this route exist"*, and nobody had ever asked *"how many is
 * too many"*. Nothing else in the product asked either.
 *
 * ## Why it is a BUDGET and not a cap on routes
 *
 * The obvious fix is `follow.length <= N`. The measurement says that is the
 * wrong instrument. Costing every statement `runTrace` issues on Pagila:
 *
 * ```text
 * route walks, one question:  24 · 2679 · 820 · 27 · 42 · 3749 · 230 · 173
 *                             \____ a 156x spread between two "routes" ____/
 * countSimilar, ONE query:    4566          ← 30% of the whole question
 * ```
 *
 * A count treats the 24-block walk and the 3749-block walk as the same thing.
 * Two routes can cost more than eight. So the ceiling is on what was SPENT,
 * measured after each query, which is the rule `QueryBudget` already
 * enforces everywhere else in this product — reusing it rather than writing a
 * second one is the whole content of debt N57.
 *
 * ## Where the numbers come from
 *
 * Routes offered per subject, measured on all three benches:
 *
 * ```text
 * chinook       11 subjects ·     50 routes · max   8 per subject
 * pagila        37 subjects ·    144 routes · max  12 per subject
 * musicbrainz  368 subjects · 24,174 routes · max 161 · median 47
 * ```
 *
 * With `statement_timeout` at 60s, following all 161 is 2.7 hours of one
 * person's question sitting on somebody's production database.
 */
export const ANSWER_LIMITS: BudgetLimits = {
  /**
   * Twice the largest menu any bench offers for one subject (Pagila's 12), so
   * it cannot bind on a schema this product has actually been run against —
   * and binds hard on MusicBrainz's 161. A backstop, not the operative limit:
   * the 156x spread above is exactly why a count is a poor proxy for cost.
   */
  maxQueries: 24,
  /**
   * 🟥 A judgement, not a measurement, and it should be read as one. Nothing
   * measured here says what a stranger's patience is worth. What IS measured
   * is the shape of being wrong: a scan is a batch job and gets 120s, while
   * this is a person who typed a question and is watching a cursor. 20s is
   * already a long time to watch one. The disclosure is what makes a
   * judgement survivable — a cut that announces itself can be argued with.
   */
  maxTotalMs: 20_000,
  /**
   * ⚠️ The weakest of the three, and worth saying so rather than letting it
   * look like protection. The runner can only record rows it was RETURNED,
   * and every walk is already `LIMIT COUNT_LIMIT`, so a route that seq-scans
   * ten million rows to return four records four. It binds on many small
   * results and never on one enormous scan; `statement_timeout` on the
   * connection is what actually bounds that case.
   *
   * Set just above `maxQueries * COUNT_LIMIT` so it CAN bind rather than
   * sitting at a value no run could ever reach, which would be a limit that
   * looks like a limit and is not one.
   */
  maxRowsScanned: 250_000,
};

/** Which row of the subject table the question is about. */
export type SubjectRow = {
  /** A column of the subject table. Must come from the catalog. */
  readonly column: string;
  /** Bound as a parameter, never interpolated. */
  readonly value: string | number;
};

export type TraceRequest = {
  readonly lookup: SealedLookup;
  readonly offer: LookupOffer;
  readonly subject: SubjectRow;
  /**
   * What this question may spend. A fresh `ANSWER_LIMITS` budget when absent.
   *
   * Optional so that the protection is on by DEFAULT and a caller has to work
   * to remove it. The opposite arrangement — a required parameter — reads as
   * more rigorous and is not: it means every call site decides, and one that
   * passes a budget with no ceiling looks exactly like one that thought about
   * it. Pass your own to share a ceiling across several questions.
   */
  readonly budget?: QueryBudget;
};

/** `schema.table` into halves. Both are needed to quote it. */
function split(name: string): { schema: string; table: string } {
  const at = name.indexOf('.');
  return { schema: name.slice(0, at), table: name.slice(at + 1) };
}

/**
 * The columns to join on for one step, in the direction the walk is going.
 *
 * An edge records `from`, `to` and the two column lists that pair them, but
 * `pathsFrom` follows edges in BOTH directions — almost every real question
 * travels the way the foreign key does not. So each step has to work out
 * which end it is standing on before it can say which list belongs to which
 * side, and getting that backwards produces a query that runs and joins the
 * wrong columns to each other.
 *
 * Returns null when the edge records no columns at all. That is a `guessed`
 * edge, always, and it is where a route stops being walkable.
 */
function stepOf(
  edge: EntityEdge,
  standingOn: string,
): { next: string; here: readonly string[]; there: readonly string[] } | null {
  if (edge.join === null) return null;
  const from = refOf(edge.from);
  const to = refOf(edge.to);
  if (from === standingOn) return { next: to, here: edge.join.from, there: edge.join.to };
  if (to === standingOn) return { next: from, here: edge.join.to, there: edge.join.from };
  return null;
}

/** The tables a route touches, in order, or null when it cannot be walked. */
function walk(route: OfferedPath): { entity: string; here: readonly string[]; there: readonly string[] }[] | null {
  const steps: { entity: string; here: readonly string[]; there: readonly string[] }[] = [];
  let standingOn = route.from;
  for (const edge of route.path) {
    const step = stepOf(edge, standingOn);
    if (step === null) return null;
    steps.push({ entity: step.next, here: step.here, there: step.there });
    standingOn = step.next;
  }
  return steps;
}

/**
 * A time column for each table, or nothing when the table records none.
 *
 * One query for every table at once. The preference order is explicit and
 * narrow on purpose: when several columns could be the clock, which one is
 * picked changes the answer, so the choice is made by a written rule and the
 * column that won is carried out in `HopResult.timeColumn` for a reader to
 * see. Nothing here reads a value.
 *
 * ⚠️ This is a NAMING rung, the same kind of evidence `guessedEdges` produces,
 * and it is worth saying so: `created_at` beating `updated_at` is a
 * convention, not a fact about the data. What keeps it honest is that the
 * column name travels with the answer.
 */
const TIME_PREFERENCE = ['created_at', 'created', 'inserted_at', 'occurred_at', 'happened_at'];

const TIME_COLUMNS_SQL = `
  SELECT c.table_schema AS schema, c.table_name AS name, c.column_name AS column
  FROM information_schema.columns c
  WHERE (c.table_schema || '.' || c.table_name) = ANY($1)
    AND c.data_type IN (
      'timestamp with time zone', 'timestamp without time zone', 'date'
    )
  ORDER BY c.table_schema, c.table_name, c.ordinal_position
`;

export async function timeColumns(
  client: Client,
  tables: readonly string[],
): Promise<Map<string, string>> {
  if (tables.length === 0) return new Map();
  const res = await client.query(TIME_COLUMNS_SQL, [[...tables]]);

  const candidates = new Map<string, string[]>();
  for (const row of res.rows as { schema: string; name: string; column: string }[]) {
    const key = `${row.schema}.${row.name}`;
    const list = candidates.get(key) ?? [];
    list.push(row.column);
    candidates.set(key, list);
  }

  const chosen = new Map<string, string>();
  for (const [table, columns] of candidates) {
    const preferred = TIME_PREFERENCE.find((p) => columns.includes(p));
    // Falls back to the first time column in ordinal order, which is stable
    // for a given schema and is what `ORDER BY ordinal_position` is for. An
    // arbitrary-but-stable choice is still a choice, and it is reported.
    const pick = preferred ?? columns[0];
    if (pick !== undefined) chosen.set(table, pick);
  }
  return chosen;
}

/** `t0`, `t1`… quoted. Aliases go through the same gate every identifier does. */
function alias(i: number): string {
  return quoteIdent(`t${i}`);
}

/**
 * How many rows the subject reaches along one route, and when the earliest of
 * them happened.
 *
 * The join is built here and nowhere else. Every identifier passes through
 * `qualified` or `quoteIdent`; the only value in the statement is the
 * subject's, and it is bound.
 */
async function walkRoute(
  client: Client,
  route: OfferedPath,
  subject: SubjectRow,
  clocks: ReadonlyMap<string, string>,
): Promise<HopResult> {
  const steps = walk(route);
  const timeColumn = clocks.get(route.to) ?? null;

  if (steps === null) {
    // ① Not zero. Nobody could ask.
    return {
      entity: route.to,
      via: '(no columns recorded)',
      path: route.path,
      rows: null,
      at: null,
      timeColumn,
      unasked: 'no-columns-to-join-on',
    };
  }

  const root = split(route.from);
  const rootTable = qualified(root.schema, root.table);
  // Written as a direct `quoteIdent` call rather than through `alias()`, and
  // that is not style. `check-sql.py` proves a fragment safe by finding the
  // sanitiser in the expression that built it, and a value laundered through
  // a helper is one it cannot follow — the same reason the rule packs quote
  // inside each template instead of once into a shared variable.
  const rootAlias = quoteIdent('t0');
  const keyColumn = quoteIdent(subject.column);

  const joins = steps
    .map((step, i) => {
      const t = split(step.entity);
      const on = step.here
        .map((col, k) => `${alias(i)}.${quoteIdent(col)} = ${alias(i + 1)}.${quoteIdent(step.there[k]!)}`)
        .join(' AND ');
      return `JOIN ${qualified(t.schema, t.table)} ${alias(i + 1)} ON ${on}`;
    })
    .join('\n      ');

  // One row's clock reading, or the absence of one. The aggregate is applied
  // OUTSIDE the subquery against a fixed alias, so this is the only place an
  // identifier has to reach the statement.
  const tsExpr =
    timeColumn === null
      ? 'NULL'
      : `${quoteIdent('t' + String(steps.length))}.${quoteIdent(timeColumn)}`;

  // Not `::text`. Postgres renders a timestamp according to the session's
  // DateStyle, so casting here would make the string in a timeline depend on
  // a setting nobody in this product chose. The driver hands back a Date and
  // `isoOf` turns it into one format, always.
  const sql = `
    SELECT count(*)::int AS n, min(s.ts) AS at
    FROM (
      SELECT ${tsExpr} AS ts
      FROM ${rootTable} ${rootAlias}
      ${joins}
      WHERE ${rootAlias}.${keyColumn} = $1
      LIMIT ${COUNT_LIMIT}
    ) s
  `;
  const res = await client.query(sql, [subject.value]);
  const row = res.rows[0] as { n: number; at: unknown } | undefined;

  return {
    entity: route.to,
    via: steps[steps.length - 1]?.here.join(', ') ?? '',
    path: route.path,
    rows: row?.n ?? 0,
    at: isoOf(row?.at),
    timeColumn,
    unasked: null,
  };
}

/**
 * One instant, in one format, or nothing.
 *
 * `timelineFrom` orders timed steps by comparing these strings, so two hops
 * rendered in two formats would order by their punctuation. Anything that is
 * not a date the driver recognised becomes null rather than a string nobody
 * can compare — the same choice `readColumnList` makes in the store.
 */
function isoOf(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

/**
 * How many OTHER subjects show the same break.
 *
 * §33's last line — *"there are 3 more like this today"* — and the number that
 * turns one person's complaint into a thing worth fixing. Counted across
 * subject rows that reach the last table the walk got to and do not reach the
 * one it stopped at.
 *
 * Capped at `SIMILAR_LIMIT`, and the cap is why the answer is "at least this
 * many" rather than a total. That distinction belongs in the sentence a
 * renderer writes, and the number here is honest about being bounded.
 */
async function countSimilar(
  client: Client,
  route: OfferedPath,
  subject: SubjectRow,
): Promise<number | null> {
  const steps = walk(route);
  if (steps === null || steps.length === 0) return null;

  const root = split(route.from);
  const rootTable = qualified(root.schema, root.table);
  const rootAlias = quoteIdent('t0');
  const keyColumn = quoteIdent(subject.column);

  const joins = steps
    .map((step, i) => {
      const t = split(step.entity);
      const on = step.here
        .map((col, k) => `${alias(i)}.${quoteIdent(col)} = ${alias(i + 1)}.${quoteIdent(step.there[k]!)}`)
        .join(' AND ');
      return `LEFT JOIN ${qualified(t.schema, t.table)} ${alias(i + 1)} ON ${on}`;
    })
    .join('\n      ');

  const lastAlias = quoteIdent('t' + String(steps.length));
  const lastKey = quoteIdent(steps[steps.length - 1]!.there[0]!);

  const sql = `
    SELECT count(*)::int AS n
    FROM (
      SELECT ${rootAlias}.${keyColumn} AS who
      FROM ${rootTable} ${rootAlias}
      ${joins}
      WHERE ${rootAlias}.${keyColumn} <> $1
      GROUP BY ${rootAlias}.${keyColumn}
      HAVING count(${lastAlias}.${lastKey}) = 0
      LIMIT ${SIMILAR_LIMIT}
    ) s
  `;
  const res = await client.query(sql, [subject.value]);
  return (res.rows[0] as { n: number } | undefined)?.n ?? null;
}

/**
 * Runs one lookup and returns the timeline it earned.
 *
 * A lookup that decided the database cannot answer produces a timeline with
 * no steps and its admissions intact — which is an answer, not a failure, and
 * `timelineSaysNothing` is how a renderer tells the two apart.
 */
export async function runTrace(client: Client, req: TraceRequest): Promise<Timeline> {
  const resolved = resolveLookup(req.lookup, req.offer);
  if (resolved === null) {
    return timelineFrom('', [], req.lookup.outside);
  }

  const subjectName = refOf(resolved.subject.entity);
  const tables = new Set<string>([subjectName]);
  for (const route of resolved.routes) tables.add(route.to);

  const clocks = await timeColumns(client, [...tables]);

  const budget = req.budget ?? new QueryBudget(ANSWER_LIMITS);

  const hops: HopResult[] = [];
  for (const route of resolved.routes) {
    // Asked BEFORE the query, not after. `canAfford` records the refusal, so
    // the reason survives into `disclosure()` whether or not anyone reads the
    // hop — the same arrangement every other budgeted path in this product
    // uses, and the reason the sentence can be written at all.
    if (!budget.canAfford(`follow ${route.from} to ${route.to}`)) {
      hops.push({
        entity: route.to,
        via: '(not asked)',
        path: route.path,
        rows: null,
        at: null,
        timeColumn: clocks.get(route.to) ?? null,
        unasked: 'budget-spent',
      });
      // No `break`. The remaining routes are each refused in turn, on
      // purpose: `unaffordable` then names every table a reader did not get
      // an answer about, and stopping at the first would leave the rest
      // absent from the account with nothing saying they exist.
      continue;
    }
    const started = Date.now();
    const hop = await walkRoute(client, route, req.subject, clocks);
    // A hop with no columns to join on cost the database nothing — no query
    // was built. Recording it would spend budget on a query nobody ran.
    if (hop.unasked === null) budget.record(Date.now() - started, hop.rows ?? 0);
    hops.push(hop);
  }

  // The similar-case count belongs to the break, so it is only asked for when
  // there is one — and only for the route that broke. Counting it otherwise
  // would be a query nobody's answer depends on, run against a database this
  // product is a guest in.
  let similar: number | null = null;
  const brokeIndex = hops.findIndex((h) => h.rows === 0);
  if (brokeIndex !== -1) {
    const route = resolved.routes[brokeIndex];
    // 🟥 Budgeted like a route walk, and it is the statement that most needed
    // it: costed on Pagila it was 4566 blocks against a mean route walk of
    // ~1000, so ONE break question is worth several route walks. It is also
    // the only statement here whose aggregate has no row limit in front of
    // it — `LIMIT` applies after `GROUP BY … HAVING`, so the whole subject
    // table is grouped before anything is discarded.
    //
    // ③ stays intact when it cannot be afforded: `similar` remains null,
    // which already means "nobody counted", and null is the honest answer for
    // a count that was never run.
    if (route !== undefined && budget.canAfford(`count others breaking at ${route.to}`)) {
      const started = Date.now();
      similar = await countSimilar(client, route, req.subject);
      budget.record(Date.now() - started, similar ?? 0);
    }
  }

  return timelineFrom(subjectName, hops, req.lookup.outside, similar, budget.disclosure('answer'));
}
