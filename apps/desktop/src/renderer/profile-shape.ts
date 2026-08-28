/**
 * How each rung of the knowledge ladder is allowed to look. No DOM here.
 *
 * Ideal §22 gives five rungs and ideal §12's audit gives the reason they may
 * never be drawn alike:
 *
 * > *"Scan trước (rẻ, tự động) → Trình bày cái tìm được → User chỉ bấm
 * > Đúng/Sai. Câu hỏi cũ đòi KIẾN THỨC; câu hỏi mới chỉ đòi XÁC NHẬN điều đã
 * > thấy."*
 *
 * A person is being asked to RECOGNISE something. That only works if the card
 * in front of them says truthfully how the product came to put it there — and
 * the difference between *"I saw this"* and *"I think I might have seen this"*
 * is the whole of what they are being asked to judge. Two rungs that look
 * alike collapse that judgement into a nod.
 *
 * The mapping lives apart from the renderer for the reason `verdict-shape.ts`
 * gives about its own: a rule that decides what somebody believes about their
 * own system is worth being able to test without a window in the room.
 *
 * ## What this file decides, and what it refuses to
 *
 * It decides SHAPE. It does not decide copy: the sentences are in the
 * catalogue, keyed by rung, and the evidence sentences are the backend's and
 * are quoted rather than rephrased.
 *
 * ## 🟥 Two rules here are safety rules, not taste
 *
 * ```text
 * confirmable   only the two rungs that were SHOWN something may offer the
 *               control that produces `verified`. `verified` means a human
 *               agreed with a measurement; a confirm button on a card with no
 *               evidence on it would make it sometimes mean "a human clicked
 *               next to a blank space", and no later screen could tell which.
 *               main/profile-flow.ts refuses those calls. This is the same
 *               rule stated on the surface the person actually presses, so the
 *               window does not offer a control the other side will decline.
 *
 * asksInstead   `suspected` is a QUESTION and never news. Hard rule ③ forbids
 *               calling an unconfirmed thing a fact, and `_doc/25` 3.3 ② makes
 *               the visual obey the same rule as the copy.
 * ```
 *
 * ## Why three rungs carry no icon
 *
 * The icon set is fixed at five by `index.html`, and `verdict-shape.ts` has
 * already spent them: `check` on the one thing that is settled, `dash` as the
 * absence mark, `alert` on what must interrupt a skim. `shield` reads as
 * protection and `arrow` as *carry on*, and neither is true of a rung. So the
 * three middle rungs are told apart by border style, border weight, rail and
 * label instead — `_doc/25` 3.3 ① asks for text plus shape plus colour, and
 * says nothing about every state owing a glyph. A wrong icon would be worse
 * than none: it is read before the label is.
 */

import type { AreaFacts, ProfileFacts } from '../shared/ipc.js';

/** The rung names, from the contract by way of the bridge. Never a copy. */
export type Rung = AreaFacts['state'];

/** Which way a disagreement points. Also from the contract, also not copied. */
export type ConflictDirection = ProfileFacts['conflicts'][number]['direction'];

/** The five icon templates `index.html` holds. */
type IconName = 'check' | 'dash' | 'shield' | 'arrow' | 'alert';

export type RungShape = {
  /** CSS modifier on the card. Named for the rung so the two cannot drift. */
  readonly tone: Rung;
  /** Icon, or null where none of the five would tell the truth. */
  readonly icon: IconName | null;
  /** Whether this card offers the control that produces `verified`. */
  readonly confirmable: boolean;
  /** Whether the card asks rather than tells. */
  readonly asksInstead: boolean;
  /** Whether this rung may look settled. Exactly one may. */
  readonly settled: boolean;
};

/**
 * Keyed by the ladder itself, so a sixth rung is a compile error here rather
 * than a card that renders as none of the five.
 */
const RUNGS = {
  /**
   * Nobody said, nothing seen. **Not a failure and not drawn as one.**
   *
   * The plainest card in the set: no rail, no tint, nothing raised. The
   * ideal's §13 audit measured what the opposite costs — *"user bấm 'Không
   * biết' 15 lần liên tiếp, cảm thấy mình dốt, rồi thoát"* — and a map that
   * marks five areas as deficiencies is that same screen wearing a new name.
   * The dash is the absence mark, which is all this is.
   */
  unknown: { tone: 'unknown', icon: 'dash', confirmable: false, asksInstead: false, settled: false },

  /**
   * They said so, and nothing has checked it.
   *
   * Slate, the tone this product already uses for *quiet, but with holes in
   * it*, and a DOTTED rail: the claim is theirs and the product has put
   * nothing behind it. No confirm control — there is nothing on the card for
   * a person to agree with except their own sentence.
   */
  stated: { tone: 'stated', icon: null, confirmable: false, asksInstead: false, settled: false },

  /**
   * Something was seen that might mean this.
   *
   * Wears the shape the report gives an unconfirmed pattern — dashed edge,
   * accent rail — because it is the same claim at the same strength, and one
   * product drawing the same uncertainty two ways teaches a reader that the
   * drawing means nothing.
   */
  suspected: {
    tone: 'suspected',
    icon: null,
    confirmable: true,
    asksInstead: true,
    settled: false,
  },

  /**
   * Seen plainly, and the card can say where.
   *
   * Ink: the strongest neutral in the palette. Definite, and carrying no
   * verdict about whether the thing found is good — a map is not a report of
   * problems, and an area drawn in amber would be an accusation nobody made.
   */
  observed: {
    tone: 'observed',
    icon: null,
    confirmable: true,
    asksInstead: false,
    settled: false,
  },

  /**
   * Shown to a person, and agreed by them. The only settled rung.
   *
   * Ink again and heavier, because the difference between this and `observed`
   * is not a difference of degree — one is a measurement and the other is a
   * measurement somebody signed. `check` is spent here for the same reason
   * `verdict-shape.ts` spends it on the one honest all-clear: a tick means
   * *this is done being argued about*, and this is the only rung that is.
   *
   * No confirm control: agreeing twice is not a thing, and a live button here
   * would invite a second press that changes nothing.
   */
  verified: { tone: 'verified', icon: 'check', confirmable: false, asksInstead: false, settled: true },
} as const satisfies Record<Rung, RungShape>;

export function shapeForRung(rung: Rung): RungShape {
  return RUNGS[rung];
}

/**
 * Every rung, in the ladder's own order.
 *
 * 🟥 NOT a second copy of the contract's list, and the difference matters:
 * `RUNGS` is checked against `Record<Rung, RungShape>`, so a rung added to
 * `KnowledgeState` is a compile error in this file before it can be a name
 * missing from this array. §4.27 is the account of what a real copy costs —
 * a third copy of `ClaimKind` sat two hundred lines from the fence built to
 * catch copies, and a build ended up refusing to read what it had written.
 *
 * The renderer needs it to print counts per rung on the smoke line, which has
 * to name every rung including the ones at zero.
 */
export const EVERY_RUNG: readonly Rung[] = Object.keys(RUNGS) as Rung[];

/**
 * The rungs that carry evidence, stated once so the confirm rule can be
 * checked against something rather than against itself.
 *
 * `shared/ipc.ts` says `evidence` is empty on exactly `unknown` and `stated`,
 * and calls that the one place on the contract where an absence carries
 * meaning — allowed there because `state` says which rung it is first.
 */
export const RUNGS_WITH_EVIDENCE: readonly Rung[] = ['suspected', 'observed', 'verified'];

export type ConflictShape = {
  /** CSS modifier on the card. */
  readonly tone: 'found' | 'unseen';
  readonly icon: IconName;
};

/**
 * The two directions of a disagreement, which mean opposite things.
 *
 * 🟥 This is the pair the product is most able to get wrong, and the wrong
 * version is the more natural one to write. `conflictsIn` in the contract says
 * it plainly: *"Treating it as their error would be the product mistaking the
 * edge of its own vision for the edge of the world."*
 */
const DIRECTIONS = {
  /**
   * They said no; it is there.
   *
   * The most valuable thing the map can hold — the question they did not know
   * to ask — so it gets the loudest shape on the screen: solid, heavy, and
   * the glyph that stops a skim. What keeps that from reading as blame is the
   * copy, not the colour, and the copy says outright that nothing here means
   * anything is broken.
   */
  said_no_found_yes: { tone: 'found', icon: 'alert' },

  /**
   * They said yes; nothing here showed it.
   *
   * 🟥 This is a statement about OUR reach, and it may not wear the shape
   * that means *something was found in your system*. Dashed and slate — the
   * vocabulary this product already uses for a hole in its own coverage — and
   * the absence mark rather than the alert, because what is absent is our
   * sight of the thing, not the thing.
   */
  said_yes_found_no: { tone: 'unseen', icon: 'dash' },
} as const satisfies Record<ConflictDirection, ConflictShape>;

export function shapeForDirection(direction: ConflictDirection): ConflictShape {
  return DIRECTIONS[direction];
}
