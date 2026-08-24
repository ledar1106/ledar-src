/**
 * The other half of what a reader sees, and until now the half with no gate.
 *
 * Every `Finding` goes through `sealFindings`, so hard rule ③ — a Layer B
 * pattern the owner has not ruled on may not be called a bug, an error, or
 * broken — is enforced by a machine rather than by a habit. `ruledOut` and
 * `notExamined` are not findings. They are the pack's own structures, they are
 * printed into the report in the product's own voice, and no gate read them.
 *
 * Debt N42, and it was a channel rather than a leak. Every sentence in there
 * was checked by hand when the debt was filed and none of them broke the rule;
 * the one that came closest — *"not as that many broken links"* — is a
 * negation, saying the opposite. So this is a fence built before anything got
 * through it, which is the only time a fence is cheap.
 *
 * ## The wider lesson, which is bigger than these two lists
 *
 * A gate that keys on a TYPE protects what carries that type. A reader keys on
 * a SCREEN, and the screen does not know which sentences arrived as `Finding`
 * and which arrived as a bare object with a `reason` on it. Any text a person
 * reads in this product's voice has to pass the same discipline, whatever its
 * shape in the code.
 *
 * ## Why a brand rather than a function to remember
 *
 * The same reason `SealedFinding` has one, written down in `seal.ts`: a
 * validator called by hand at every call site is a convention, and a
 * convention is something that holds until somebody is in a hurry. A pack
 * returns `SealedSetAside[]`, no object literal satisfies that type, and the
 * only way to obtain one is through `sealSetAside`.
 */

import { z } from 'zod';

import { assertNoDefectWords } from './findings.js';

/** A target the scanner looked at and then declined to raise. */
export const SetAside = z.object({
  /** What was set aside — a column, a constraint, an index. */
  target: z.string().min(1),
  /** Why, in the sentence a person will read. */
  reason: z.string().min(1),
});
export type SetAside = z.infer<typeof SetAside>;

declare const SET_ASIDE_SEAL: unique symbol;

/**
 * A set-aside sentence that has been through `sealSetAside`.
 *
 * The brand exists only in the type system; at run time this is an ordinary
 * object with two strings on it. Its job is to make the gate unavoidable
 * rather than merely available.
 */
export type SealedSetAside = SetAside & {
  readonly [SET_ASIDE_SEAL]: 'checked at the pack boundary';
};

export class SetAsideRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetAsideRefused';
  }
}

/**
 * Checks one set-aside sentence and returns it sealed, or throws.
 *
 * Throws rather than dropping the entry. A silently discarded row would take
 * the coverage hole with it — the report would go back to being unable to tell
 * *nothing was wrong here* from *nothing was looked at here*, which is the one
 * distinction this product exists to make.
 */
export function sealSetAside(entry: SetAside): SealedSetAside {
  const parsed = SetAside.safeParse(entry);
  if (!parsed.success) {
    throw new SetAsideRefused(
      `A set-aside entry is not usable: ` +
        `${parsed.error.issues[0]?.message ?? 'wrong shape'}. It is printed ` +
        `to the reader as the scanner declining to raise something, and an ` +
        `entry with no target or no reason declines nothing legible.`,
    );
  }

  // The same clause `sealFindings` applies, on text that reaches the same
  // reader. Unconditional here rather than gated on a confidence level: a
  // set-aside entry carries no confidence, because it is not a claim about the
  // database — it is a statement about what this scanner chose not to say.
  // Nothing that is not a claim is entitled to call anything broken.
  assertNoDefectWords(
    parsed.data.reason,
    `The reason given for setting aside ${parsed.data.target}`,
  );

  return parsed.data as SealedSetAside;
}

/** The same, for a whole list, so a pack seals once at its boundary. */
export function sealSetAsides(entries: readonly SetAside[]): SealedSetAside[] {
  return entries.map((e) => sealSetAside(e));
}
