/**
 * What the scan was allowed to see, stated before anything it found.
 *
 * The letter D in the product's name is this file. A finding list without a
 * scope is a claim about a whole system built from a look at part of it, and
 * the person reading has no way to tell which part.
 *
 * Two denominators throughout. What the granted role can read, and what
 * exists. They are rarely the same number, and reporting only the first is
 * how "47 of 47 tables" comes to mean nothing at all.
 *
 * Both denominators are measured here, by two different queries against two
 * different populations. An earlier version of this file measured only the
 * first and named it `tablesInGrantedSchemas`, which was correct as far as it
 * went; the danger was in what a caller would do with it. Handing that number
 * to a report as "how many tables exist" turns a scan of one schema into a
 * clean bill of health for a database with fifteen — the same substitution as
 * `GREATEST(reltuples, 0)` turning "nobody ever ran ANALYZE" into "0 rows".
 */

import type { Client } from 'pg';

export type ScopeReport = {
  database: string;
  role: string;

  /** The schemas the caller asked for, verbatim, duplicates removed. */
  schemasRequested: string[];

  /**
   * Asked for, and the database confirms this role may enter them.
   *
   * Not the same list as `schemasRequested`, and the difference is the whole
   * point: asking for a schema is not being given it.
   */
  schemasGranted: string[];

  /**
   * Asked for, exists here, and this role has no USAGE on it.
   *
   * Kept apart from `schemasMissing` because the fix is different — one is a
   * GRANT, the other is a typo — and named at all because a scan of a schema
   * it cannot enter returns nothing, which on a screen is indistinguishable
   * from a schema with nothing wrong in it.
   */
  schemasRefused: string[];

  /** Asked for, and there is no such schema in this database. */
  schemasMissing: string[];

  /**
   * Schemas that exist here and were never asked for.
   *
   * Listed whatever their privileges say. An earlier version listed only the
   * schemas this role could not enter, which quietly left out the ones it
   * could have read and simply was not pointed at — the larger of the two
   * omissions, and the one the reader is more likely to care about.
   */
  schemasNotLookedAt: string[];

  /** Tables inside the requested schemas that this role can SELECT. */
  tablesReadable: number;

  /** Tables that exist inside the requested schemas, readable or not. */
  tablesInRequestedSchemas: number;

  /**
   * Every table in this database outside Postgres's own catalogs.
   *
   * The honest denominator, and a separate query on purpose. pg_class answers
   * this even for schemas this role cannot enter — catalog rows are not
   * filtered by schema privileges — which is a claim worth checking rather
   * than believing, so `test/scope.test.ts` checks it.
   */
  tablesInDatabase: number;

  /**
   * Of the tables in this database, how many this role could read.
   *
   * How many it *could*, not how many were read. The gap between this and
   * `tablesReadable` is tables that were within reach and outside the scan,
   * and nothing else in a report would ever show them.
   */
  tablesReadableInDatabase: number;

  /** Columns hidden by column-level grants, which row counts never reveal. */
  columnsUnreadable: number;

  /** Postgres does not record when a role was created. Saying so beats guessing. */
  grantedAt: null;

  /** Exact SQL to take this access away again. */
  revokeSql: string;
};

/**
 * Every schema that exists here, minus Postgres's own bookkeeping.
 *
 * Used for one thing: naming what was never looked at. Privileges are not
 * asked for, because "you did not look here" is true whether or not the
 * account could have.
 */
const SCHEMAS_SQL = `
  SELECT n.nspname AS schema
  FROM pg_namespace n
  WHERE n.nspname NOT LIKE 'pg\\_%'
    AND n.nspname <> 'information_schema'
  ORDER BY n.nspname
`;

/**
 * For each schema the caller asked for: is it here, and may this role enter it.
 *
 * The LEFT JOIN is load-bearing. `has_schema_privilege(current_user, 'nope',
 * 'USAGE')` raises "schema does not exist" and takes the whole scan down; the
 * oid form given a NULL returns NULL, so a schema name that is simply wrong
 * comes back as a row saying so instead of as an exception.
 *
 * WITH ORDINALITY keeps the answers in the order they were asked, so a report
 * lists the caller's schemas the way the caller wrote them.
 */
const REQUESTED_SCHEMAS_SQL = `
  SELECT
    r.name                                                AS schema,
    n.oid IS NOT NULL                                     AS present,
    COALESCE(has_schema_privilege(n.oid, 'USAGE'), false) AS granted
  FROM unnest($1::text[]) WITH ORDINALITY AS r(name, ord)
  LEFT JOIN pg_namespace n ON n.nspname = r.name
  ORDER BY r.ord
`;

const TABLES_SQL = `
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE has_table_privilege(c.oid, 'SELECT'))::int AS readable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname = ANY($1::text[])
`;

/**
 * The same two counts over the whole database instead of over the scan.
 *
 * The schemas the caller asked for are added back in with OR rather than
 * assumed to be inside the first condition. Point this at `pg_catalog` and
 * without that clause the total would come back smaller than the number of
 * tables just read — a manifest that fails its own consistency check, from a
 * scan that did nothing wrong.
 */
const DATABASE_TABLES_SQL = `
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE has_table_privilege(c.oid, 'SELECT'))::int AS readable
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND (
      (n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema')
      OR n.nspname = ANY($1::text[])
    )
`;

/**
 * Columns inside readable tables that this role still cannot select.
 *
 * Worth counting separately: a table can be readable while a column is not,
 * and nothing about the table count would ever hint at it.
 */
const COLUMNS_SQL = `
  SELECT count(*)::int AS hidden
  FROM pg_attribute a
  JOIN pg_class c     ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[])
    AND c.relkind IN ('r', 'p')
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND has_table_privilege(c.oid, 'SELECT')
    AND NOT has_column_privilege(c.oid, a.attnum, 'SELECT')
`;

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** One row of `REQUESTED_SCHEMAS_SQL`, as the sorting rule sees it. */
export type RequestedSchema = {
  name: string;
  present: boolean;
  granted: boolean;
};

export type SchemaAccess = {
  /** Asked for and confirmed. */
  granted: string[];
  /** Asked for, here, and refused. */
  refused: string[];
  /** Asked for and not here at all. */
  missing: string[];
};

/**
 * Sorts the schemas that were asked for into what the database said about them.
 *
 * Pulled out of `readScope` and exported so it can be tested without a
 * database, because the bug it replaces was not in any SQL. The previous
 * version reported the *requested* list as granted and the *catalog's* list of
 * ungranted schemas as not granted — two answers from two sources — so a
 * schema that was asked for and refused appeared in both lists at once, and
 * the report said it had been read.
 *
 * Duplicates are dropped, first mention winning. `LEDAR_SCHEMAS=public,public`
 * is not two schemas.
 */
export function classifySchemas(rows: readonly RequestedSchema[]): SchemaAccess {
  const access: SchemaAccess = { granted: [], refused: [], missing: [] };
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);

    if (!row.present) access.missing.push(row.name);
    else if (row.granted) access.granted.push(row.name);
    else access.refused.push(row.name);
  }

  return access;
}

/**
 * Handed to the user unprompted.
 *
 * Someone deciding whether to grant access is really deciding whether they
 * can undo it. Showing the undo before they need it costs nothing and is the
 * difference between borrowing and taking.
 */
export function buildRevokeSql(
  role: string,
  database: string,
  schemas: string[],
): string {
  const r = quoteIdent(role);
  const lines = [
    `-- Takes back everything granted to ${role}. Safe to run at any time;`,
    `-- a scan in progress will simply start failing.`,
    '',
  ];
  for (const s of schemas) {
    const sq = quoteIdent(s);
    lines.push(`REVOKE ALL ON ALL TABLES IN SCHEMA ${sq} FROM ${r};`);
    lines.push(`REVOKE ALL ON SCHEMA ${sq} FROM ${r};`);
  }
  lines.push(`REVOKE ALL ON DATABASE ${quoteIdent(database)} FROM ${r};`);
  lines.push('');
  lines.push(`-- And to remove the account itself:`);
  lines.push(`DROP ROLE ${r};`);
  return lines.join('\n');
}

export async function readScope(
  client: Client,
  schemasRequested: string[],
): Promise<ScopeReport> {
  const who = await client.query(
    'SELECT current_user AS role, current_database() AS db',
  );
  const role = who.rows[0]?.role as string;
  const database = who.rows[0]?.db as string;

  const asked = await client.query(REQUESTED_SCHEMAS_SQL, [schemasRequested]);
  const access = classifySchemas(
    asked.rows.map((r) => ({
      name: r.schema as string,
      present: r.present === true,
      granted: r.granted === true,
    })),
  );
  const requested = [...access.granted, ...access.refused, ...access.missing];

  const existing = await client.query(SCHEMAS_SQL);
  const wasAsked = new Set(requested);
  const schemasNotLookedAt = existing.rows
    .map((r) => r.schema as string)
    .filter((s) => !wasAsked.has(s));

  // Sequential, not Promise.all. One pg Client runs one statement at a time;
  // asking it for four at once queues them anyway and warns about it.
  const tables = await client.query(TABLES_SQL, [schemasRequested]);
  const columns = await client.query(COLUMNS_SQL, [schemasRequested]);
  const whole = await client.query(DATABASE_TABLES_SQL, [schemasRequested]);

  return {
    database,
    role,
    schemasRequested: requested,
    schemasGranted: access.granted,
    schemasRefused: access.refused,
    schemasMissing: access.missing,
    schemasNotLookedAt,
    tablesReadable: tables.rows[0]?.readable ?? 0,
    tablesInRequestedSchemas: tables.rows[0]?.total ?? 0,
    tablesInDatabase: whole.rows[0]?.total ?? 0,
    tablesReadableInDatabase: whole.rows[0]?.readable ?? 0,
    columnsUnreadable: columns.rows[0]?.hidden ?? 0,
    grantedAt: null,
    // Only schemas that are actually here. REVOKE on a schema that does not
    // exist aborts the script, and the point of printing it is that it runs.
    revokeSql: buildRevokeSql(role, database, [
      ...access.granted,
      ...access.refused,
    ]),
  };
}

function list(names: readonly string[]): string {
  return names.join(', ');
}

/**
 * The message keys this file needs, and nothing else.
 *
 * Declared here rather than imported because this package deliberately does
 * not depend on `@ledar/contracts`. NOTICE calls it *"the part that touches
 * your database"*, and widening the dependency surface of the one package that
 * has to stay auditable is a real cost for a convenience.
 *
 * The CLI's translator is typed over the whole `MessageKey` union, so it is
 * assignable to this narrower one. If a key here is ever dropped from that
 * union, the assignment at the call site stops compiling — so the two
 * declarations cannot drift apart in silence.
 */
export type ScopeMessageKey =
  | 'scope.nothing-asked'
  | 'scope.granted-when-unknown'
  | 'scope.tables-in'
  | 'scope.refused'
  | 'scope.missing'
  | 'scope.not-looked-at'
  | 'scope.unreadable-tables'
  | 'scope.unreadable-columns'
  | 'scope.outside'
  | 'scope.outside-within-reach';

export type ScopeTranslate = (
  key: ScopeMessageKey,
  params?: Record<string, string | number>,
) => string;

/**
 * The English wording, used when no translator is handed in.
 *
 * A default rather than a required argument because this function has six
 * callers and only one of them renders a report for a person. Tests and
 * internal callers keep working unchanged, and the one that matters passes
 * the reader's language.
 */
const EN_FALLBACK: ScopeTranslate = (key, p = {}) => {
  const v = (k: string): string => String(p[k] ?? '');
  const many = (k: string, one: string, more: string): string =>
    Number(p[k] ?? 0) === 1 ? one : more;
  switch (key) {
    case 'scope.nothing-asked':
      return (
        `No schema was asked for, so nothing here was read at all. ${v('tables')} ` +
        `tables exist in this database` +
        (Number(p['readable'] ?? 0) > 0
          ? `, ${v('readable')} of them readable by this account`
          : '') +
        `, and none of them were looked at`
      );
    case 'scope.granted-when-unknown':
      return 'I do not know when this access was granted — Postgres does not record it';
    case 'scope.tables-in':
      return `${v('readable')} of ${v('total')} tables in ${v('schemas')}`;
    case 'scope.refused':
      return (
        `${v('schemas')} — asked for, and this account has no access to ` +
        `${many('count', 'it', 'them')}. Nothing here was read, which is not ` +
        `the same as nothing being there`
      );
    case 'scope.missing':
      return `${v('schemas')} — asked for, and this database has no schema by that name`;
    case 'scope.not-looked-at':
      return `Not looked at at all: ${v('schemas')}${v('more')}`;
    case 'scope.unreadable-tables':
      return (
        `${v('count')} tables here exist that this account cannot read — ` +
        `nothing below says anything about them`
      );
    case 'scope.unreadable-columns':
      return (
        `${v('count')} columns are hidden from this account inside tables it ` +
        `can otherwise read`
      );
    case 'scope.outside':
      return (
        `${v('count')} more tables exist in this database, outside ` +
        `${v('schemas')}. Nothing below is about ${many('count', 'it', 'them')}`
      );
    case 'scope.outside-within-reach':
      return (
        `  of those, ${v('count')} ${many('count', 'is', 'are')} readable by ` +
        `this account — not out of reach, just not in the schemas I was ` +
        `pointed at`
      );
  }
};

/** The scope, said the way a person would say it. */
export function describeScope(
  s: ScopeReport,
  T: ScopeTranslate = EN_FALLBACK,
): string[] {
  const lines: string[] = [];
  const asked = s.schemasRequested;

  if (asked.length === 0) {
    // A scan with no schema in it is a scan of nothing, and a report of
    // nothing is indistinguishable from a report of nothing wrong unless
    // somebody says this sentence.
    lines.push(
      T('scope.nothing-asked', {
        tables: s.tablesInDatabase,
        readable: s.tablesReadableInDatabase,
      }),
    );
    lines.push(T('scope.granted-when-unknown'));
    return lines;
  }

  lines.push(
    T('scope.tables-in', {
      readable: s.tablesReadable,
      total: s.tablesInRequestedSchemas,
      schemas: list(asked),
    }),
  );

  // Said before the counts are explained, because it changes what they mean.
  // A schema that was asked for and refused contributes nothing to every
  // number below, and a report of nothing reads exactly like a report of
  // nothing wrong.
  if (s.schemasRefused.length > 0) {
    lines.push(
      T('scope.refused', {
        schemas: list(s.schemasRefused),
        count: s.schemasRefused.length,
      }),
    );
  }

  if (s.schemasMissing.length > 0) {
    lines.push(T('scope.missing', { schemas: list(s.schemasMissing) }));
  }

  const unreadable = s.tablesInRequestedSchemas - s.tablesReadable;
  if (unreadable > 0) {
    lines.push(T('scope.unreadable-tables', { count: unreadable }));
  }

  if (s.columnsUnreadable > 0) {
    lines.push(T('scope.unreadable-columns', { count: s.columnsUnreadable }));
  }

  const outside = s.tablesInDatabase - s.tablesInRequestedSchemas;
  if (outside > 0) {
    lines.push(
      T('scope.outside', { count: outside, schemas: list(asked) }),
    );

    // The correction that keeps the sentence above from being read as "and
    // this account could not have read them either". Some of them it could,
    // and the difference between out of reach and out of scope is measured
    // here rather than left to the reader's assumption.
    const withinReach = s.tablesReadableInDatabase - s.tablesReadable;
    if (withinReach > 0) {
      lines.push(T('scope.outside-within-reach', { count: withinReach }));
    }
  }

  if (s.schemasNotLookedAt.length > 0) {
    const shown = s.schemasNotLookedAt.slice(0, 6).join(', ');
    const more =
      s.schemasNotLookedAt.length > 6
        ? ` and ${s.schemasNotLookedAt.length - 6} more`
        : '';
    lines.push(T('scope.not-looked-at', { schemas: shown, more }));
  }

  lines.push(T('scope.granted-when-unknown'));

  return lines;
}
