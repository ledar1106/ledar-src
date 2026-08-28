/**
 * The third thing a report can hold — VS-6, and the reason it is CONDITIONAL.
 *
 * Two sections exist today, and the split between them is the product's whole
 * claim about itself:
 *
 * ```text
 * WHAT THE DATABASE ITSELF CONFIRMS   Postgres declared it. `certain`.
 * PATTERNS WORTH ASKING ABOUT         nobody declared it. `unconfirmed`.
 * ```
 *
 * A rule somebody typed at onboarding is neither. The database did not declare
 * it, and the product did not notice it — the user asked for it. Printing it
 * under either heading would tell a reader something false about where the
 * claim came from, in a report whose entire purpose is to be exact about that.
 *
 * ## Why a new section costs nothing, which was not obvious
 *
 * VS-7 put this report in front of five people and four read it correctly.
 * There is no second round — the Licensor ended it on 2026-08-24, and the
 * reason was the cost to five people who owe this project nothing. So a change
 * to the measured layout is a change that can never be re-measured, and that
 * was a real price to weigh.
 *
 * It turns out not to be payable here. **Nothing produces a user rule yet.**
 * VS-6 has no onboarding screens and `scan.ts` never calls `runRule`, so a
 * section that appears only when user findings exist is invisible on every
 * report anyone has read or will read before VS-6 ships. The layout VS-7
 * measured stays byte-identical.
 *
 * And when it does appear, it appears for somebody who typed the rule
 * themselves. They are not meeting a surprise section; they are being shown
 * the answer to a question they asked.
 *
 * `null` rather than an empty array is the shape that makes that a fact the
 * compiler holds rather than a habit a caller has: there is no "empty user
 * rule section", and a caller cannot accidentally print a heading with nothing
 * under it.
 *
 * ## Where it goes, and why that order
 *
 * After the database, before the patterns. Two orderings agree, which is how
 * you know it is not taste:
 *
 * ```text
 * by authority   the database declared it > you declared it > I guessed it
 * by confidence  certain                  > probable        > unconfirmed
 * ```
 *
 * ## The preamble is printed ONCE
 *
 * It carries what ㉔ and ㉕ measured — that a model can map a sentence onto
 * the wrong table while counting perfectly — and that caveat is true of every
 * rule in the section at once. VS-7 already found what per-finding repetition
 * costs: "an empty table is not a clean one" appeared three times in sixty
 * lines and stopped being read.
 */

import { t } from './i18n.js';
import type { Lang } from './i18n.js';
import type { SealedFinding } from './seal.js';

/**
 * Whether this claim exists because somebody asked for it.
 *
 * Keyed on `origin` rather than on the rule id. Rule ids are strings a future
 * pack could collide with; `user_declared` is a closed vocabulary value the
 * seal already checks, and `BASIS_FOR_ORIGIN` ties it to `user_statement`.
 */
export function isUserRule(finding: SealedFinding): boolean {
  return finding.origin === 'user_declared';
}

/** One rule's line, already split into what a reader reads and what they act on. */
export type UserRuleEntry = {
  /** The sentence, in the reader's language. */
  plain: string;
  /** `schema.table`, for the line below it. */
  where: string;
  /** The identifiers and the counts. */
  why: string;
  /**
   * The boundary — or null when the section has already said it.
   *
   * ⚠️ Null no longer means "this claim has no limits". Since N50 every
   * finding carries a boundary, so null here is a RENDERING decision made
   * below, not a fact about the claim. Read the reason there before removing
   * this field or filling it in unconditionally.
   */
  boundary: string | null;
};

export type UserRuleSection = {
  heading: string;
  /** Printed once, above every entry. Never per finding. */
  preamble: string;
  entries: UserRuleEntry[];
};

/**
 * The section, or `null` when this scan ran no rules of the user's.
 *
 * Returns parts rather than finished lines: wrapping and indentation belong to
 * whoever is drawing the report, and a second copy of `wrap` living in
 * `contracts` would be a second answer to a question that already has one.
 */
export function buildUserRuleSection(
  findings: readonly SealedFinding[],
  lang: Lang = 'en',
): UserRuleSection | null {
  const mine = findings.filter(isUserRule);
  if (mine.length === 0) return null;

  return {
    heading: t(lang, 'head.you-asked'),
    preamble: t(lang, 'scan.you-asked-preamble'),
    entries: entriesOf(mine),
  };
}

/**
 * The entries, with a boundary every entry shares reduced to none of them.
 *
 * Debt N50 gave every finding a boundary, and applied naively here that would
 * print ONE sentence once per rule in a section where every rule's boundary is
 * the same sentence — "I checked the rule as it was read back to you; I did
 * not check whether that is the rule you meant". It is true of all of them at
 * once, which is why `scan.you-asked-preamble` already carries it above the
 * list.
 *
 * VS-7 measured what per-finding repetition costs and the finding was not
 * subtle: a sentence printed three times in sixty lines stops being read. So
 * the rule here is about REPETITION, not about claim kind — suppress a
 * boundary only when every entry in the section has the identical one, and
 * show it the moment two rules differ. A rule with something of its own to
 * disclose is exactly the case the old shape would have hidden.
 *
 * ⚠️ Nothing is lost by this. The boundary is on the finding, in the store,
 * and in the evidence pack whatever this returns; this decides what is
 * PRINTED, and only in this one section.
 */
function entriesOf(mine: readonly SealedFinding[]): UserRuleEntry[] {
  const boundaries = mine.map((f) =>
    'boundary' in f && typeof f.boundary === 'string' ? f.boundary : null,
  );
  const allSame =
    boundaries.length > 1 && new Set(boundaries).size === 1 && boundaries[0] !== null;

  return mine.map((f, i) => ({
    plain: f.plainText,
    where: `${f.schema}.${f.table}`,
    why: f.technical,
    boundary: allSame ? null : (boundaries[i] ?? null),
  }));
}
