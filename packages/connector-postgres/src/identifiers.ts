/**
 * The only place identifiers are allowed to become SQL text.
 *
 * Postgres binds values, never identifiers. A table name cannot arrive as
 * $1, so "never build SQL by concatenation" is not a rule anybody can keep —
 * the rule that can be kept is that every identifier passes through here,
 * and every name reaching here came from the catalog.
 *
 * There was a second copy of this logic inside probeEmptyTables, hand-rolled
 * and slightly different. Two implementations of a safety boundary means one
 * of them is wrong and nobody knows which, so there is now one.
 */

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function quoteIdent(name: string): string {
  if (!PLAIN_IDENT.test(name)) {
    throw new Error(
      `Refusing to build SQL for the identifier ${JSON.stringify(name)}: it is ` +
        `not a plain identifier. Names reach SQL from pg_catalog or a fixed ` +
        `allowlist, never from user input.`,
    );
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/** For the rare literal that cannot be bound, such as inside a DO block. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A number on its way into a clause that cannot take a parameter.
 *
 * `TABLESAMPLE SYSTEM (…)` and `REPEATABLE (…)` are the reason this exists.
 * Postgres parses both at plan time and will not bind either, so a sampling
 * percentage computed from a row estimate has to reach the statement as text.
 *
 * The guard is not decoration. `NaN`, `Infinity` and `-0` all stringify into
 * something that either breaks the parse or, worse, parses into a sample
 * nobody asked for — and a division by a row estimate is exactly the
 * arithmetic that produces them. Refusing here means a bad number becomes an
 * error naming the number, rather than a query that silently looks at the
 * wrong amount of somebody's table.
 *
 * Exponent notation is refused for the same reason it looks harmless:
 * `1e-7` is a valid float in both languages, and a percentage written that
 * way in published evidence is one a reader cannot check at a glance.
 */
/**
 * The only place a `TABLESAMPLE` clause becomes SQL text.
 *
 * It lives here rather than beside its caller for the reason everything else
 * in this file does: `check-sql.py` can prove that a fragment came from one of
 * these functions, and cannot prove anything about a fragment assembled
 * somewhere else out of pieces that happen to be safe. Two numbers go in, both
 * through `numericLiteral`, and no identifier is involved at all.
 *
 * `pct` of `null` means no sampling — an empty string, so the caller can
 * interpolate it unconditionally and the exact and sampled queries stay one
 * template instead of two that drift.
 */
export function tableSampleClause(pct: number | null, seed: number): string {
  if (pct === null) return '';
  return ` TABLESAMPLE SYSTEM (${numericLiteral(pct)}) REPEATABLE (${numericLiteral(seed, 0)})`;
}

export function numericLiteral(value: number, decimals = 6): string {
  if (!Number.isFinite(value)) {
    throw new Error(
      `Refusing to build SQL for the number ${String(value)}: only finite ` +
        `numbers may reach a clause that cannot be parameterised.`,
    );
  }
  const text = value.toFixed(decimals);
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(`Refusing to build SQL for the number ${text}.`);
  }
  return text;
}

/**
 * Same as qualified(), but returns null instead of throwing.
 *
 * For loops over the catalog, where one unusual name should skip that table
 * rather than abandon the scan. Returning null also keeps the assignment a
 * single `const`, which is what makes the provenance of the string obvious
 * to a reader — and to check-sql.py.
 */
export function tryQualified(schema: string, table: string): string | null {
  try {
    return qualified(schema, table);
  } catch {
    return null;
  }
}
