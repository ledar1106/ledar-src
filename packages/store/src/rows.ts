/**
 * Reading a SQLite row back without pretending about types.
 *
 * SQLite hands back `null | number | bigint | string | Uint8Array`. Casting
 * that to the shape we want and hoping is how a column that quietly became
 * text keeps working until it reaches a user. These throw instead.
 *
 * These lived in `store.ts` until a second reader needed them. That reader
 * (`legacy.ts`) opens files this build refuses to write to, and it has to
 * read them by exactly the same rules — a retired file read with a laxer
 * hand than the live one would produce a diff whose two sides were checked
 * differently, which is the one thing a diff must never do.
 */

export type Row = Record<string, unknown>;

export function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`Column ${column} should be text, got ${typeof value}.`);
  }
  return value;
}

export function textOrNull(row: Row, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return text(row, column);
}

export function int(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') {
    throw new Error(`Column ${column} should be a number, got ${typeof value}.`);
  }
  return value;
}

export function intOrNull(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return int(row, column);
}

/** For REAL columns, where a whole number is a coincidence and not a rule. */
export function real(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== 'number') {
    throw new Error(`Column ${column} should be a number, got ${typeof value}.`);
  }
  return value;
}

export function bool(row: Row, column: string): boolean {
  return int(row, column) === 1;
}

export function json<T>(raw: string, column: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Column ${column} does not hold valid JSON.`);
  }
}

/**
 * A column that may not exist in this file at all.
 *
 * The distinction this draws is the reason the whole module is shared. A
 * schema-1 history has no `engine_rule_version` column; a schema-2 one has
 * the column and could in principle hold a NULL in it. Both come back as
 * `null` here — and that is correct, because both mean *this row cannot tell
 * you which rule version ran*. What would not be correct is reading the
 * absent column as an empty string, which compares equal to another empty
 * string and turns "neither side says" into "both sides agree".
 */
export function absentOrText(row: Row, column: string): string | null {
  if (!(column in row)) return null;
  return textOrNull(row, column);
}
