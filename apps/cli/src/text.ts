/**
 * Line breaking, in one place.
 *
 * This lived privately inside `diff.ts` until `scan.ts` needed it too. Copying
 * it across would have been three lines of work and the third time this repo
 * paid for that shortcut: debt N25 closed a duplicated `runningAsCommand`
 * whose second copy had silently lost the comment explaining why it existed,
 * and the same session found a second set of secret patterns living beside the
 * first. A duplicate does not announce itself when one side is fixed.
 */

/**
 * Break `text` at word boundaries so no line exceeds `width`, prefixing each
 * with `indent`.
 *
 * `width` counts the text only, not the indent — callers pass the column
 * budget they have left after their own prefix.
 *
 * A single word longer than `width` is emitted on its own over-long line
 * rather than being split. The alternative is hyphenating identifiers, and a
 * table name broken across two lines is a table name the reader cannot paste
 * into a query.
 */
export function wrap(text: string, width: number, indent = ''): string[] {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines;
}
