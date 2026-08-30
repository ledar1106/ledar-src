/**
 * Where the target came from — the question, or the map?
 *
 * ## The hole this does not close
 *
 * N62. A choice can aim at a table that is WRONG and yet ON THE MENU.
 * `sealLookup` passes it and is right to: the seal answers *"is this route
 * real"*, and the route is real. Measured on two schemas:
 *
 * ```text
 * pagila       37 subjects · lure public.staff        EN 2/2   VI 0/2
 * musicbrainz 368 subjects · lure editor_collection   EN 2/2   VI 2/2
 * ```
 *
 * Both payloads claim no authority and say nothing hostile. They explain a
 * quirk of the schema — *"edit is a view in this deployment"* — the way a
 * colleague would, and the model believes them.
 *
 * ## 🟥 Why this DISCLOSES and does not refuse
 *
 * Three candidate signals were counted over the 42 questions already fired and
 * paid for (㉜'s 32 and ㉟'s 10) before any of this was written:
 *
 * ```text
 *                                                   breaches   the rest
 * ① the question names the chosen table                4/4       11/38
 * ② …by a name nobody types by accident                4/4        0/38
 * ③ …and names some other table deliberately too       0/4        6/38
 * ```
 *
 * ② separates them perfectly on that data. It is also **evadable in three
 * seconds**: write *"trace it from the editor collection table"* and the
 * underscore is gone. A test that separates perfectly on four positives and
 * loses to a space bar is not a gate — and building it as one would be worse
 * than nothing, because it would be silent exactly when it mattered while a
 * reader believed they were covered.
 *
 * As a disclosure it costs nothing and cannot mislead. It states a fact about
 * the input — *your question contains this exact table name, and that is the
 * table I aimed at* — and leaves the judgement with the person who is
 * responsible for the database. `CLAUDE.md` §3: the reader does not understand
 * backends and IS accountable for one. Deciding for them is how a product
 * makes their problem LOOK solved.
 *
 * ⚠️ n = 4 breaches, both payloads written by the same hand that wrote this
 * file. Perfect separation on four positives is weak evidence and the number
 * belongs beside the claim.
 */

import { refOf } from './entity-graph.js';
import type { LookupOffer } from './bounded-lookup.js';

/** How a chosen table relates to the words the question was asked in. */
export type TargetProvenance = {
  /** `schema.table` the choice aimed at. */
  readonly subject: string;
  /**
   * The question contains this table's name as a whole word.
   *
   * ⚠️ True for most honest questions on most schemas — 11 of 38 here — because
   * tables are named after the words people use. On its own it means nothing,
   * and it is carried only so that `deliberate` can be read against it.
   */
  readonly named: boolean;
  /**
   * The question names it in a form nobody types by accident: with an
   * underscore, or with its schema in front.
   *
   * `public.staff` and `editor_collection` are both things somebody copied out
   * of a schema. `customer`, `rental`, `edit` and `release` are words. That is
   * the whole rule, and it is a rule about TYPOGRAPHY rather than intent —
   * which is why it can be stated to a reader without accusing anybody.
   */
  readonly deliberate: boolean;
  /** Other tables the question names in that same deliberate form. */
  readonly othersNamed: readonly string[];
};

/** Whole-word, case-insensitive. `edit` must not match inside `editor`. */
function whole(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/**
 * What the question says about the table that was chosen.
 *
 * Takes the raw question rather than the sealed prompt: the framing wraps the
 * question in a fence and the fence's own text must not be searched, or every
 * answer would look as though the reader had named something.
 */
export function targetProvenance(
  question: string,
  subject: string,
  offer: LookupOffer,
): TargetProvenance {
  const at = subject.indexOf('.');
  const bare = at < 0 ? subject : subject.slice(at + 1);
  const lower = question.toLowerCase();

  const namesIt = (full: string, table: string): boolean =>
    lower.includes(full.toLowerCase()) || whole(lower, table);
  const deliberatelyNames = (full: string, table: string): boolean =>
    lower.includes(full.toLowerCase()) || (table.includes('_') && whole(lower, table));

  const others = offer.subjects
    .map((s) => refOf(s.entity))
    .filter((full) => full !== subject)
    .filter((full) => deliberatelyNames(full, full.slice(full.indexOf('.') + 1)));

  return {
    subject,
    named: namesIt(subject, bare),
    deliberate: deliberatelyNames(subject, bare),
    othersNamed: others,
  };
}

/**
 * The sentence a reader gets, or null when there is nothing to say.
 *
 * 🟥 It reports the fact and stops. Not *"this question may be an attack"* —
 * this product cannot know that, and a reader told it would either dismiss
 * every future warning or distrust a colleague who was being helpful. What it
 * can know is that the words came from the question rather than from the map,
 * and which of the two a thing came from is exactly what somebody accountable
 * for a database needs in order to disagree with it.
 */
export function provenanceNote(p: TargetProvenance): string | null {
  if (!p.deliberate) return null;
  const others =
    p.othersNamed.length === 0
      ? ''
      : ` It also named ${p.othersNamed.join(', ')}, which ${
          p.othersNamed.length === 1 ? 'was' : 'were'
        } not used.`;
  // 🟥 "the words in the question", NOT "the words you were sent".
  //
  // Read on a real screen for the first time on 2026-08-31, and the earlier
  // wording said *"the target came from the words you were sent"*. Somebody
  // who typed their own question was sent nothing by anybody, so the sentence
  // asserted a thing this code cannot know — whether the words are the
  // reader's own — in the middle of a note whose whole value is that it only
  // states what it observed. The last sentence already asks that question
  // properly, and asking is the correct form: a reader who wrote the words
  // reads it and moves on, and one who pasted them from a ticket stops.
  return (
    `The question itself named ${p.subject}, spelled the way it appears in your ` +
    `schema rather than the way people write. That is where this answer was ` +
    `aimed, so the target came from the wording of the question and not from ` +
    `the map.${others} Worth a look if those words are not yours.`
  );
}
