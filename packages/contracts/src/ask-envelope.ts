/**
 * One question, two calls, and the single decision a person is asked to make.
 *
 * ## The problem two rounds created
 *
 * N60 split the lookup into two calls, because a 368-table menu is 511,631
 * tokens in one and no model takes it. That is settled. What it left behind is
 * a consent problem nobody had before:
 *
 * ```text
 * round 1   the question + every subject          bytes known before asking
 * round 2   the question + ONE subject's routes   bytes do not exist yet
 * ```
 *
 * `grantEgress` hashes the body, so round two needs its own permit over its
 * own bytes. That part is mechanical. The question this file answers is the
 * human one: **is the person asked twice, or once?**
 *
 * Twice is the honest-looking answer and it is the worse one. A person asked
 * to approve the same question twice learns, in about four questions, to press
 * the button without reading — and this product's entire value is that its
 * disclosures are worth reading. A consent screen that trains people past
 * itself has made the problem LOOK solved.
 *
 * ## 🟥 Once, and only because of a property that can be CHECKED
 *
 * Asking once would be indefensible if round two could send anything new. It
 * cannot, and that is not a hope about the prompt builder — it is a fact about
 * the menu, computed here:
 *
 * > **Every route's two endpoints are subjects.** `lookupOffer` builds paths
 * > by walking from each subject, so a route names `schema.table` on both ends
 * > and both ends are already on the list round one carries.
 *
 * So round two's identifiers are a SUBSET of round one's. The person is shown
 * every table name that can leave, across both calls, before either happens —
 * and `stayedInside` is false when that ever stops being true, which turns a
 * paragraph of reasoning into a value a screen can refuse to send on.
 *
 * ⚠️ What this does NOT claim: that round two is small, cheap, or harmless. It
 * claims one thing — no NAME leaves that was not on the screen. Bytes, cost
 * and count are separate disclosures and are carried separately.
 */

import { describeEgress } from './egress-permit.js';
import type { EgressDisclosure } from './egress-permit.js';
import type { EgressClass } from './findings.js';
import { lookupPromptParts, narrowOffer, subjectPromptParts } from './bounded-lookup.js';
import type { LookupOffer } from './bounded-lookup.js';
import { refOf } from './entity-graph.js';

/** Everything a person agrees to when they send one question. */
export type AskEnvelope = {
  /** The exact URL that will be called. Both rounds go to the same one. */
  readonly destination: string;
  /** The strictest class across the whole exchange. */
  readonly dataClass: EgressClass;
  /**
   * Every table name that may leave, across BOTH calls.
   *
   * Round one carries all of them; round two carries a subset. Listing the
   * union is the same list, and saying so is what makes one decision cover
   * two calls.
   */
  readonly identifiers: readonly string[];
  /** Bytes of the person's own content in the first call. */
  readonly firstBytes: number;
  /**
   * The largest the second call's content can be, over every subject it could
   * choose. The worst case rather than a typical one — a person deciding
   * whether to send something is owed the ceiling, not the average.
   */
  readonly secondBytesAtWorst: number;
  /** Bytes of the question itself, which is the part they wrote. */
  readonly questionBytes: number;
  /**
   * 🟥 False when round two could name something round one did not.
   *
   * The whole justification for asking once. A screen that finds this false
   * must not send: it would be collecting agreement for a list of names and
   * then sending a different list.
   */
  readonly stayedInside: boolean;
};

/**
 * What the person is agreeing to, computed from the menu they would send.
 *
 * `destination` is passed in rather than derived: only the model client knows
 * the URL, and a disclosure that guessed it would be describing a call that
 * might not be the one made.
 */
export function askEnvelope(
  question: string,
  offer: LookupOffer,
  destination: string,
): AskEnvelope {
  const subjects = offer.subjects.map((s) => refOf(s.entity));
  const known = new Set(subjects);

  // 🟥 Checked over every route, not asserted. `lookupOffer` builds paths from
  // subjects today; a later change that let a path arrive at something not on
  // the subject list would make one consent cover two different disclosures,
  // and nothing else in the product would notice.
  const stayedInside = offer.paths.every((p) => known.has(p.from) && known.has(p.to));

  const first = describeEgress(subjectPromptParts(question, offer), destination, subjects);

  // The worst case over every subject, because the person is deciding before
  // anybody knows which one will be chosen. Computed from the same functions
  // the second call uses, so it cannot describe a prompt nobody builds.
  let worst = 0;
  for (const s of offer.subjects) {
    const parts = lookupPromptParts(question, narrowOffer(offer, s.id));
    const bytes = parts.untrusted.reduce(
      (a, b) => a + Buffer.byteLength(b.content, 'utf8'),
      0,
    );
    if (bytes > worst) worst = bytes;
  }

  return {
    destination,
    dataClass: first.dataClass,
    // 🟥 The union across both rounds, which is round one's list — but written
    // as a union rather than as `first.identifiers` so that a future round
    // three cannot be added without this line becoming visibly wrong.
    identifiers: [...new Set([...first.identifiers])],
    firstBytes: first.bytes,
    secondBytesAtWorst: worst,
    questionBytes: Buffer.byteLength(question, 'utf8'),
    stayedInside,
  };
}

/**
 * The disclosure for the first call alone, for the record rather than the
 * screen.
 *
 * The screen shows the envelope; the permit is still granted per round over
 * exact bytes. Both exist and they are not the same object — collapsing them
 * would either weaken the permit to cover bytes nobody hashed, or make the
 * screen ask twice.
 */
export function firstRoundDisclosure(
  question: string,
  offer: LookupOffer,
  destination: string,
): EgressDisclosure {
  return describeEgress(
    subjectPromptParts(question, offer),
    destination,
    offer.subjects.map((s) => refOf(s.entity)),
  );
}

/**
 * The sentence a person reads before deciding.
 *
 * Written as plain counting rather than reassurance. `CLAUDE.md` §3: the
 * reader does not understand backends and IS accountable for one, so what they
 * need is what leaves and where it goes, in units they can check against the
 * screen — not a promise that it is safe.
 */
export function envelopeNote(e: AskEnvelope): string {
  if (!e.stayedInside) {
    return (
      `This question cannot be sent as one decision: the second call could ` +
      `name a table that is not on this list, so agreeing once would be ` +
      `agreeing to something you were not shown.`
    );
  }
  const names = e.identifiers.length;
  return (
    `Two calls go to ${e.destination}. The first carries your question ` +
    `(${e.questionBytes} bytes) and the names of ${names} ` +
    `${names === 1 ? 'table' : 'tables'} — ${e.firstBytes} bytes of your ` +
    `content. The second carries your question again and the connections ` +
    `between whichever of those tables is chosen and its neighbours, at most ` +
    `${e.secondBytesAtWorst} bytes. No table name leaves that is not in this ` +
    `list, and no rows from any of them leave at all.`
  );
}

/** Whether `unsent` still holds after the envelope is built. */
export function envelopeRefuses(e: AskEnvelope): boolean {
  return !e.stayedInside;
}
