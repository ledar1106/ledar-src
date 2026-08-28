/**
 * Reads the catalog. Never touches data.
 *
 * Everything here comes from pg_catalog, so it describes what the database
 * was *told* to enforce. Whether it actually holds is a separate question,
 * answered by running the counter-query — which is what makes a Layer A
 * finding verifiable without a human.
 */

import type { Client } from 'pg';

import { tryQualified } from './identifiers.js';

export type TableRef = {
  schema: string;
  table: string;
  /**
   * True for a partition of another table.
   *
   * A partition is a real table and belongs in the scope manifest, but a
   * rule that already ran against the parent has covered it — Postgres
   * scans every partition when you query the parent. Checking each one
   * again spends the user's database on the same answer.
   */
  isPartition: boolean;
  /**
   * The table this is a partition of, or null when it is not one.
   *
   * 🟥 Here because the entity graph is unbuildable without it. Postgres puts
   * a partitioned table's foreign keys on each PARTITION, and on Pagila the
   * parent `payment` carries none of its own. A graph that skipped partitions
   * to avoid a neighbour-per-month lost the relationship, and re-derived it
   * from the column NAME: something the database enforces, demoted to
   * something nobody checked. Worse than the noise it was avoiding.
   *
   * ⚠️ This comment used to say "54 partitions carrying three constraints
   * each". It is the THIRD copy of a number that was wrong — there are 55, and
   * 6 of them declare a FOREIGN KEY — and the two corrected earlier did not
   * reach it. §4.27 is exactly this: a fence around two copies while a third
   * sat somewhere nobody was looking. Counted: `field-results` ㉙d.
   *
   * One level up, not the whole chain — see the note in `TABLES_SQL`.
   */
  partitionOf: { schema: string; table: string } | null;
};

export type ConstraintKind = 'foreign_key' | 'check' | 'unique' | 'primary_key';

export type Constraint = {
  name: string;
  kind: ConstraintKind;
  schema: string;
  table: string;
  columns: string[];
  /**
   * False when the constraint was added with NOT VALID and never validated.
   * Postgres enforces it for new rows and leaves existing rows unexamined,
   * so the guarantee the name implies does not cover the data already there.
   */
  validated: boolean;
  definition: string;
  /**
   * The check expression alone, decompiled by Postgres itself.
   *
   * Pulling it out of pg_get_constraintdef with a regex was fragile:
   * a greedy capture mangles nested parentheses. Postgres already
   * knows how to render this correctly.
   */
  checkExpression: string | null;
  /** Foreign keys only. */
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumns: string[];
};

export type IndexInfo = {
  name: string;
  schema: string;
  table: string;
  isUnique: boolean;
  /** A false here means the index is not enforcing anything right now. */
  isValid: boolean;
  isReady: boolean;
};

const TABLES_SQL = `
  SELECT
    n.nspname            AS schema,
    c.relname            AS "table",
    c.relispartition     AS is_partition,
    -- Which table this is a partition OF, when it is one.
    --
    -- 🟥 Added 2026-08-28 because the entity graph could not be built without
    -- it. On Pagila the foreign keys of the partitioned \`payment\` table live on
    -- PARTITIONS and the parent carries none of its own, so a graph that
    -- skipped partitions lost the relationship entirely and re-derived it as a
    -- NAME GUESS — demoting something Postgres enforces to something nobody
    -- checked, which is worse than the noise that skipping was meant to fix.
    --
    -- ⚠️ An earlier version of this comment said "54 partitions, each carrying
    -- three constraints". Counted properly: **55 partitions, of which 6
    -- declare a FOREIGN KEY** — \`payment_p2022_01\` through \`_06\`, 18 keys
    -- between them. The other 49 declare no foreign key. The
    -- mechanism the comment described was right and the magnitude was wrong by
    -- 9x, which is §4.1b in one line: a number stated more confidently than it
    -- was measured. What that 6-of-55 split MEANS is handled in
    -- \`declaredEdges\`, and it is not a footnote.
    --
    -- One level, not the whole chain: \`pg_inherits\` gives the immediate
    -- parent, and a partition of a partition would resolve to the middle
    -- table. Said out loud rather than left to be discovered — the fix is a
    -- recursive walk, and nothing here needs one yet.
    pn.nspname           AS parent_schema,
    p.relname            AS parent_table
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid AND c.relispartition
  LEFT JOIN pg_class p       ON p.oid = inh.inhparent
  LEFT JOIN pg_namespace pn  ON pn.oid = p.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname = ANY($1::text[])
    AND has_table_privilege(c.oid, 'SELECT')
  ORDER BY n.nspname, c.relname
`;

const CONSTRAINTS_SQL = `
  SELECT
    con.conname                        AS name,
    con.contype                        AS contype,
    n.nspname                          AS schema,
    c.relname                          AS "table",
    con.convalidated                   AS validated,
    pg_get_constraintdef(con.oid)      AS definition,
    pg_get_expr(con.conbin, con.conrelid) AS check_expr,
    COALESCE(
      (SELECT array_agg(a.attname::text ORDER BY k.ord)
       FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum),
      '{}'::text[]
    )                                  AS columns,
    fn.nspname                         AS ref_schema,
    fc.relname                         AS ref_table,
    COALESCE(
      (SELECT array_agg(a.attname::text ORDER BY k.ord)
       FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum),
      '{}'::text[]
    )                                  AS ref_columns
  FROM pg_constraint con
  JOIN pg_class c      ON c.oid = con.conrelid
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  LEFT JOIN pg_class fc     ON fc.oid = con.confrelid
  LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
  WHERE n.nspname = ANY($1::text[])
    AND con.contype IN ('f', 'c', 'u', 'p')
    AND has_table_privilege(c.oid, 'SELECT')
  ORDER BY n.nspname, c.relname, con.conname
`;

const INDEXES_SQL = `
  SELECT
    ic.relname   AS name,
    n.nspname    AS schema,
    c.relname    AS "table",
    i.indisunique AS is_unique,
    i.indisvalid  AS is_valid,
    i.indisready  AS is_ready
  FROM pg_index i
  JOIN pg_class ic     ON ic.oid = i.indexrelid
  JOIN pg_class c      ON c.oid = i.indrelid
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[])
    AND has_table_privilege(c.oid, 'SELECT')
  ORDER BY n.nspname, c.relname, ic.relname
`;

/** How many tables exist in these schemas, including ones we cannot read. */
const TOTAL_TABLES_SQL = `
  SELECT count(*)::int AS total
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p')
    AND n.nspname = ANY($1::text[])
`;

const COLUMNS_SQL = `
  SELECT
    n.nspname   AS schema,
    c.relname   AS "table",
    a.attname   AS name,
    t.typname   AS type,
    a.attnotnull AS not_null,
    a.attnum    AS position
  FROM pg_attribute a
  JOIN pg_class c      ON c.oid = a.attrelid
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  JOIN pg_type t       ON t.oid = a.atttypid
  WHERE n.nspname = ANY($1::text[])
    AND c.relkind IN ('r', 'p')
    AND a.attnum > 0
    AND NOT a.attisdropped
    AND has_table_privilege(c.oid, 'SELECT')
    AND has_column_privilege(c.oid, a.attnum, 'SELECT')
  ORDER BY n.nspname, c.relname, a.attnum
`;

const SIZES_SQL = `
  SELECT
    n.nspname AS schema,
    c.relname AS "table",
    c.reltuples::bigint AS estimated_rows
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = ANY($1::text[])
    AND c.relkind IN ('r', 'p')
    AND has_table_privilege(c.oid, 'SELECT')
`;

/**
 * Refuses to turn a broken value into an empty one.
 *
 * The first version of this returned [] for anything that was not an array.
 * That looked defensive and was the opposite. array_agg(attname) yields
 * name[], which node-postgres has no parser for, so it arrived as the string
 * "{a,b}" — and every constraint in the database silently reported having no
 * columns. Nothing failed. Layer B just found nothing, everywhere, and said
 * so confidently.
 *
 * The cast to text[] in the queries above is the fix. This throws rather than
 * papering over the next version of the same mistake: a scanner that reports
 * "nothing found" because it is broken is worse than one that crashes.
 */
function asStringArray(value: unknown, context: string): string[] {
  if (Array.isArray(value)) return value.map(String);
  throw new Error(
    `Expected a text[] for ${context} but the driver returned ` +
      `${typeof value} (${JSON.stringify(value)}). Reporting this as an empty ` +
      `list would make every constraint look like it has no columns.`,
  );
}

const CONTYPE: Record<string, ConstraintKind> = {
  f: 'foreign_key',
  c: 'check',
  u: 'unique',
  p: 'primary_key',
};

export type ColumnInfo = {
  schema: string;
  table: string;
  name: string;
  /** The underlying type name: int4, uuid, text, timestamptz, … */
  type: string;
  notNull: boolean;
  position: number;
};

export type TableSize = {
  schema: string;
  table: string;
  /**
   * The planner's estimate, not a count. `null` when there is no estimate.
   *
   * Deliberately an estimate: counting every row of every table to decide
   * what to look at would cost the user more than the answer is worth.
   *
   * Postgres writes -1 here for a table nobody has ever analysed, and that
   * is a sentinel, not a size. It used to be passed through as a number, so
   * a caller comparing it against a threshold was deciding from a value it
   * could not read, and the one code path that printed it would have said
   * "estimated at -1 rows". This is the third time this project has had to
   * take that sentinel apart: `GREATEST(reltuples, 0)` in the database
   * qualifier reported "never analysed" as "0 rows", and `Coverage.eligible`
   * had the same shape. Null here so the question "do we know?" has to be
   * answered before the number can be used.
   */
  estimatedRows: number | null;
};

export type SchemaGraph = {
  schemas: string[];
  tables: TableRef[];
  /** Includes tables the role cannot read — the second denominator. */
  totalTablesInSchemas: number;
  constraints: Constraint[];
  indexes: IndexInfo[];
  columns: ColumnInfo[];
  sizes: TableSize[];
};

export async function readSchemaGraph(
  client: Client,
  schemas: string[],
): Promise<SchemaGraph> {
  // Sequential, not Promise.all. A pg Client multiplexes nothing — issuing
  // four queries at once queues them anyway and trips a deprecation warning
  // on the way. Parallelism here would need a pool, and a pool would mean
  // four sessions to constrain instead of one.
  const tables = await client.query(TABLES_SQL, [schemas]);
  const constraints = await client.query(CONSTRAINTS_SQL, [schemas]);
  const indexes = await client.query(INDEXES_SQL, [schemas]);
  const total = await client.query(TOTAL_TABLES_SQL, [schemas]);
  const columns = await client.query(COLUMNS_SQL, [schemas]);
  const sizes = await client.query(SIZES_SQL, [schemas]);

  return {
    schemas,
    tables: tables.rows.map((r) => ({
      schema: r.schema,
      table: r.table,
      isPartition: r.is_partition === true,
      partitionOf:
        r.parent_table === null || r.parent_table === undefined
          ? null
          : { schema: r.parent_schema, table: r.parent_table },
    })),
    totalTablesInSchemas: total.rows[0]?.total ?? 0,
    constraints: constraints.rows.map((r) => ({
      name: r.name,
      kind: CONTYPE[r.contype] ?? 'check',
      schema: r.schema,
      table: r.table,
      columns: asStringArray(r.columns, `${r.schema}.${r.table}.${r.name} columns`),
      validated: r.validated === true,
      definition: r.definition,
      checkExpression: r.check_expr ?? null,
      referencedSchema: r.ref_schema ?? null,
      referencedTable: r.ref_table ?? null,
      referencedColumns: asStringArray(r.ref_columns, `${r.schema}.${r.table}.${r.name} referenced columns`),
    })),
    indexes: indexes.rows.map((r) => ({
      name: r.name,
      schema: r.schema,
      table: r.table,
      isUnique: r.is_unique === true,
      isValid: r.is_valid === true,
      isReady: r.is_ready === true,
    })),
    columns: columns.rows.map((r) => ({
      schema: r.schema,
      table: r.table,
      name: r.name,
      type: r.type,
      notNull: r.not_null === true,
      position: r.position,
    })),
    sizes: sizes.rows.map((r) => {
      // The sentinel is turned into "unknown" here, at the one place that
      // reads it, rather than left for every caller to remember.
      const estimated = Number(r.estimated_rows);
      return {
        schema: r.schema,
        table: r.table,
        estimatedRows: estimated < 0 ? null : estimated,
      };
    }),
  };
}

/**
 * Which tables hold no rows at all.
 *
 * Cheap on purpose: EXISTS stops at the first row, so this costs the same on
 * a table of ten rows and a table of ten million. A count would not.
 *
 * This matters more than it looks. Every data-level rule run against an
 * empty table returns nothing, and a report that turns that into "nothing
 * found" is telling the user their data was examined and came back clean
 * when nothing was examined at all. An empty table is not a passing table.
 */
export async function probeEmptyTables(
  client: Client,
  tables: TableRef[],
): Promise<Set<string>> {
  const empty = new Set<string>();

  for (const t of tables) {
    const ref = tryQualified(t.schema, t.table);
    if (ref === null) continue; // not a plain identifier; quoteIdent refused it
    try {
      const res = await client.query(
        `SELECT EXISTS(SELECT 1 FROM ${ref}) AS has_rows`,
      );
      if (res.rows[0]?.has_rows !== true) empty.add(`${t.schema}.${t.table}`);
    } catch {
      // Unreadable for some other reason. Not empty, just unknown — and
      // claiming either way would be worse than leaving it out.
    }
  }

  return empty;
}
