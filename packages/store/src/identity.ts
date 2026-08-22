/**
 * What makes two things from two different scans "the same thing".
 *
 * This is the only interesting decision in the package, and it is a decision
 * that cannot be made correctly — only made explicitly. A diff is a claim
 * about continuity, and nothing in a database records continuity: a table
 * that was renamed and a table that was dropped and recreated look identical
 * from the outside. So the rule here is stated in one place, with its failure
 * modes written next to it, rather than spread across a dozen comparisons
 * where nobody can see what it assumes.
 */

import { createHash } from 'node:crypto';

import type { Finding } from '@ledar/contracts';

import type { DatabaseIdentity } from './types.js';

/**
 * Separators that cannot occur inside a Postgres identifier or a rule name.
 *
 * Joining on a character that can appear in the parts is how two different
 * things come to share one hash: with a comma between them, the column lists
 * ["a,b"] and ["a", "b"] produce the same string. Written as escapes rather
 * than as literal control bytes so they survive an editor that trims them.
 */
const FIELD = '\u0000';
const LIST = '\u001f';

function sha256(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join(FIELD), 'utf8').digest('hex');
}

/**
 * Anything that looks like it carries a password, refused at the door.
 *
 * The store takes a host and a database name from callers who are one
 * copy-paste away from handing it a whole DSN instead. A connection string in
 * a local SQLite file is a credential at rest in a file people attach to bug
 * reports, so this rejects rather than sanitises: silently stripping the
 * password would leave the caller believing they had stored one.
 */
const LOOKS_LIKE_DSN = /:\/\/|(?:^|[?&;\s])(?:password|pwd)\s*=/i;

export function assertNoCredentials(value: string, field: string): void {
  if (LOOKS_LIKE_DSN.test(value)) {
    throw new Error(
      `${field} looks like a connection string, not a ${field}. This store ` +
        `never holds credentials: a scan history is a file people attach to ` +
        `bug reports. Pass the host and database name separately.`,
    );
  }
}

/**
 * The stable id of a database, holding nothing that identifies it in the open.
 *
 * Hashed, not stored plainly, for one reason: the history file should be
 * shareable. A user who hits a bug and sends their `.db` should be sending a
 * record of what the scanner concluded, not a map of their internal network.
 * The hash is one-way and the user keeps the inputs, so their own UI can
 * still label the row.
 *
 * The cost is honest and worth stating: move the database to a new host and
 * the fingerprint changes, so its history starts over. Restoring a dump onto
 * a new server is a real thing people do, and this will read it as a new
 * database. Better than the alternative — merging two unrelated databases
 * that happen to share a name would produce a diff that is confidently wrong.
 */
export function databaseFingerprint(id: DatabaseIdentity): string {
  assertNoCredentials(id.host, 'host');
  assertNoCredentials(id.database, 'database name');
  if (!Number.isInteger(id.port) || id.port <= 0) {
    throw new Error(`port must be a positive integer, got ${String(id.port)}.`);
  }
  return sha256([id.host.trim().toLowerCase(), String(id.port), id.database.trim()]);
}

/**
 * The key that says two findings from two runs are the same finding.
 *
 * It is `Finding.id`, verbatim. That is a choice, not a shortcut, and the
 * alternative was considered: rebuild the key here from rule + schema + table
 * + columns. That alternative is broken today — `layer-a/index-not-enforcing`
 * emits an empty `columns` array and distinguishes two invalid indexes on the
 * same table only by the index name, which lives nowhere but the id. Two
 * findings would collapse into one and the diff would report a fix that never
 * happened.
 *
 * So the store depends on rule authors keeping their id format stable. That
 * dependency is real and it is the main weakness of this design; see
 * `IDENTITY_LIMITS` for the full list of ways it goes wrong.
 */
export function findingKey(finding: Finding): string {
  const key = finding.id.trim();
  if (key === '') {
    throw new Error(
      `A finding arrived with an empty id. The id is what lets a second scan ` +
        `recognise this finding as the same one, so a finding without it ` +
        `cannot be part of a history.`,
    );
  }
  return key;
}

/**
 * A hash of WHAT THE CLAIM SAYS — not who said it, not how much of it there is.
 *
 * This is the seam that lets a later diff answer the question the plan asks
 * for — schema changed, or data changed?
 *
 *   same key, same structure, different row count  → the data moved
 *   same key, different structure                  → the verdict moved
 *                                                    (severity, confidence,
 *                                                    the columns involved,
 *                                                    or what the claim rests on)
 *
 * Neither of those is proof on its own. A constraint being validated changes
 * the structure; so does someone editing a rule's severity between releases.
 * The store records which one happened; deciding what it means is the diff's
 * job and, past a point, the user's.
 *
 * ## `origin` and `confidenceBasis` are in, and that is a decision
 *
 * A claim that moved from `name_pattern` to `counted` is a different claim
 * even when every other field held still: "two column names look alike"
 * became "I counted the rows and they do not match". That is the whole arc
 * this product sells — a Layer B guess turning into a Layer A measurement —
 * and left out of the hash it would read as *nothing changed*.
 *
 * The cost, plainly: a rule that corrects its own declared origin makes every
 * finding it ever emitted read as a verdict change on the next scan, with no
 * hint that the database stood still. `engineRuleVersion`, stored beside the
 * hash, is what a reader has to consult to tell that case apart.
 *
 * ## `engineRuleVersion` is OUT, and that is the harder decision
 *
 * Folding it in would be simpler and it is the wrong simple. A version bump
 * touches every rule at once, so every finding in the file would change hash
 * on the first scan after an upgrade — a wall of "changed" with nothing in it,
 * arriving on exactly the run a user is most likely to be looking closely.
 * That is failure mode four in `IDENTITY_LIMITS` re-created deliberately.
 *
 * Leaving it out has its own price and it is real: a rewritten rule that
 * changes a severity produces a hash change the diff has no reason not to
 * blame on the customer's database. It is not silent, though, which is the
 * whole difference — `engine_rule_version` is its own column and
 * `historyOf` hands it back next to the hash, so the three cases separate:
 *
 *   hash same,  version same  → nothing moved but the numbers
 *   hash moved, version same  → the verdict moved and the rule did not
 *   hash moved, version moved → we rewrote the rule; the database is not
 *                               accused of anything
 *
 * The store cannot make the diff read that column. Nothing here can. What it
 * can do is refuse to destroy the information, which folding the version into
 * the hash would.
 *
 * `observedAt` is out for the same reason a row count is: it moves on every
 * single scan and would make every finding permanently "changed".
 * `userStatus` is out because a person answering a question is not the
 * scanner changing its mind, and the two must not arrive as the same event.
 * `egressClass` is out because it describes handling, not the finding; when it
 * does move, it moves because a rule was rewritten, and that is what
 * `engineRuleVersion` is for.
 */
export function structureHash(finding: Finding): string {
  return sha256([
    finding.rule,
    finding.kind,
    finding.confidence,
    finding.severity,
    finding.origin,
    finding.confidenceBasis,
    finding.schema,
    finding.table,
    // Not sorted. Column order carries meaning in a composite key, and two
    // different orders are two different constraints.
    finding.columns.join(LIST),
  ]);
}

/**
 * When this identity scheme is wrong. Kept in code so it is read.
 *
 * Exported so the diff slice can print it rather than reimplement the
 * caveats, and so a test can assert it did not quietly get shorter.
 */
export const IDENTITY_LIMITS: readonly string[] = [
  'A renamed table produces a new key. The old finding reads as fixed and ' +
    'the new one reads as newly appeared, when nothing changed but a name.',
  'A renamed column does the same, for the same reason.',
  'A constraint dropped and recreated under a different name is a fix plus a ' +
    'regression, not a rename — the store cannot see that they are the same ' +
    'rule about the same rows.',
  'A rule that changes its own id format between releases breaks every ' +
    'history it ever wrote. Nothing here detects that; the diff simply shows ' +
    'every old finding as fixed on the first run after the upgrade.',
  'Two databases that share a name on different hosts are correctly kept ' +
    'apart, but the same database restored onto a new host is wrongly kept ' +
    'apart too, and starts its history over.',
  'A finding that a rule stopped emitting because the rule did not run is ' +
    'indistinguishable from one that was fixed, unless the run also recorded ' +
    'that the rule ran. That is what the run_rule table is for.',
  'A rule rewritten between releases can change a severity or a basis without ' +
    'the database changing at all, and the structure hash moves either way. ' +
    'engineRuleVersion is stored beside the hash so the two cases can be told ' +
    'apart — but a diff that compares only hashes will not tell them apart, ' +
    'and will blame the database.',
];

/**
 * The one shape a sample value is allowed to have.
 *
 * A **string**, being one of `<number>`, `<uuid>`, `<text:14>`, or `'null'` —
 * what `redactCell` in `@ledar/contracts` produces. Anything else is a real
 * value from someone's database.
 *
 * `'null'` there is the four-character string, not a JS `null`. This docstring
 * used to write it bare, which read as though both were covered; they are not,
 * and the guard below has always required a string. `isRedactedCell` in
 * `@ledar/contracts` now agrees, having briefly disagreed.
 *
 * ⚠️ `REDACTED_CELL_PATTERN.test(null)` returns `true` — `RegExp#test` coerces
 * its argument to the string `"null"` first. Never hand this pattern a value
 * without checking `typeof` yourself, the way the guard below does.
 *
 * This is a copy of `REDACTED_CELL` in that package, and it stays a copy on
 * purpose: this store keeps no runtime dependency on anything, because a scan
 * history has to be readable on a machine where nothing else is installed.
 * Exported so `test/identity.test.ts` can assert the two are still identical —
 * a copied safety rule with nothing watching it is precisely how the three
 * redactors that preceded this one drifted apart.
 */
export const REDACTED_CELL_PATTERN = /^(?:<[^<>]*>|null)$/;

/**
 * Refuses to write a sample cell that still holds a real value.
 *
 * The packs redact before they hand anything over, so in normal operation
 * this never fires. It exists because the store is the last place a value can
 * be stopped before it lands in a file that outlives the scan and gets
 * emailed around, and because `_doc/16` puts sample values on the list of
 * things that never leave the machine — not merely encrypted, not collected.
 *
 * It throws rather than dropping the value. A silent drop would leave the
 * caller thinking redaction worked.
 */
export function assertSampleIsRedacted(
  sample: readonly Record<string, unknown>[],
  findingId: string,
): void {
  for (const row of sample) {
    for (const [column, value] of Object.entries(row)) {
      if (typeof value === 'string' && REDACTED_CELL_PATTERN.test(value)) continue;

      // `typeof null` is 'object', so a bare null used to be announced as an
      // unredacted *value* of type object — which is the one thing a null is
      // not. It is named for what it is, because the person reading this is
      // deciding whether their rule or this guard is wrong.
      const what = value === null ? 'a bare null' : `a value of type ${typeof value}`;
      throw new Error(
        `Finding ${findingId} carries ${what} in sample column "${column}", ` +
          `which did not come from redactCell(). The store will not write ` +
          `real column values to disk — redact to a shape like <text:12>, ` +
          `<number> or the string 'null' before recording, or record the ` +
          `finding with samples turned off.`,
      );
    }
  }
}
