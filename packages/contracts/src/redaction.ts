/**
 * Turning a value into its shape, in one place.
 *
 * There were three of these. Layer A had `redact()`, Layer B had
 * `redactValue()`, and the store had a regex that decided whether it liked
 * what they produced. All three agreed on the interesting cases and disagreed
 * on the empty one: Layer A emitted a real `null` for a null cell, Layer B
 * emitted the string `'null'`, and the store's guard accepted only strings —
 * so the same empty cell was fine coming out of one pack and refused coming
 * out of the other.
 *
 * Nothing had gone wrong yet. Layer A's sample query selects only the foreign
 * key's own columns and requires every one of them to be NOT NULL, so its null
 * branch is unreachable today. That is the whole problem with three copies of
 * a safety rule: they drift where nobody is looking, and the branch that goes
 * live first is the branch nobody tested.
 *
 * One producer now, and everything it makes is a string.
 */

/**
 * The one shape a redacted cell may have.
 *
 * `packages/store/src/identity.ts` holds a copy of this pattern on purpose.
 * The store keeps no runtime dependency on this package — a scan history has
 * to be readable on a machine that is not connected to anything — so the rule
 * cannot be imported there. `packages/store/test/identity.test.ts` asserts the
 * two are identical, which turns a duplicate into a duplicate with a tripwire.
 */
export const REDACTED_CELL = /^(?:<[^<>]*>|null)$/;

/**
 * One value, reduced to what can be said about it without saying it.
 *
 * The length of a string survives, and the fact that it looked like a uuid.
 * Nothing else does. A number becomes `<number>` rather than a rounded or
 * bucketed number, because a bucket is still a measurement of somebody's data
 * and the shape is all a reader needs to recognise the column.
 */
export function redactCell(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return '<number>';
  if (typeof value === 'string') {
    return /^[0-9a-f-]{32,36}$/i.test(value) ? '<uuid>' : `<text:${value.length}>`;
  }
  return `<${typeof value}>`;
}

/** Every cell of one sample row, reduced. */
export function redactRow(row: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, value] of Object.entries(row)) out[column] = redactCell(value);
  return out;
}

/**
 * Whether a cell holds a shape rather than a value.
 *
 * A string, and nothing else. `redactCell` is the only sanctioned producer and
 * it always returns one, so a bare JS `null` sitting in a sample means
 * something built that sample without going through the redactor — which is
 * the drift these gates exist to notice, not a case to wave through.
 *
 * This used to return `true` for a JS `null`, reasoning that a null carries no
 * value and refusing it would reject something provably safe. The reasoning
 * was sound and the result was not: the store's guard already required a
 * string, so the contract and the store gave different answers about the same
 * cell. A finding could be exported into an Evidence Pack and then refused by
 * the history file — two gates enforcing one rule, disagreeing about what the
 * rule is. Measured, not guessed: see `packages/store/test/identity.test.ts`.
 *
 * ⚠️ Call this rather than testing `REDACTED_CELL` directly.
 * `REDACTED_CELL.test(null)` returns `true`, because `RegExp#test` coerces its
 * argument to the string `"null"` before matching. That is an accident of the
 * language, not a decision, and it is the reason the string check comes first
 * here instead of being left to the pattern.
 */
export function isRedactedCell(value: unknown): boolean {
  return typeof value === 'string' && REDACTED_CELL.test(value);
}
