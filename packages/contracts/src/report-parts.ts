/**
 * Where the model's contribution is kept apart from the report — HS-D D.5,
 * second half.
 *
 * ## The half that could not be closed until D.1 existed
 *
 * D.5's restated criterion has two clauses. The first — *say what did not get
 * added, never grade what is there* — landed with `model-step.ts` and its
 * gate. The second — **the report does not change when the model step does not
 * happen** — was true only trivially, because there was no model step that
 * could change it. It was marked 🟨 rather than ✅ for exactly that reason:
 * ticking it would have recorded a test nobody could run.
 *
 * D.1 exists now, so it is falsifiable, and this is where it is made false or
 * not.
 *
 * ## The invariant, and why it is a TYPE rather than a promise
 *
 * ```text
 * fromRules   what the rule packs produced. Passed straight through; nothing
 *             here builds a new string out of it.
 * fromModel   what the model added, when it answered. NEVER merged into the
 *             above; kept in its own field so no code path can splice one
 *             into the other.
 * aboutTheStep  the sentence about what did not get added.
 * ```
 *
 * Three fields instead of one joined string, and that is the whole design. A
 * function returning one already-joined page has decided what the reader sees,
 * and a caller cannot tell afterwards whether the report half arrived intact.
 * Keeping them apart leaves the rule packs' output there to compare against,
 * and the test compares it.
 *
 * ⚠️ This paragraph used to claim the guarantee was returning *the same
 * object*, with the test asserting `Object.is`. Both were wrong: strings are
 * primitives, so identity and equality are one question, and that assertion
 * could never fail. What holds is simpler and enough — a string cannot be
 * mutated, so the only way this report changes is by being REBUILT, and
 * content equality catches that.
 *
 * ## What it refuses, and the one that matters
 *
 * A caller passing an addition alongside `unavailable` is trying to print
 * output from a call that failed. That is not a shape to tidy up — it is the
 * bug where a partial answer from a timed-out request reaches a reader, and it
 * throws.
 *
 * VS-7 measured what this protects: four of five readers took the right
 * conclusion off hand-written rule-pack prose. That output is the only writing
 * this product has evidence for. Whatever a model does or fails to do, the
 * reader still gets exactly it.
 */

import { t } from './i18n.js';
import type { Lang } from './i18n.js';
import { modelStepLine } from './model-step.js';
import type { ModelStepState } from './model-step.js';

export type ReportParts = {
  /** Exactly what the rule packs produced, unchanged. */
  readonly fromRules: string;
  /** What the model added, or null. Never merged into `fromRules`. */
  readonly fromModel: string | null;
  /** What did not get added, or null when nothing is missing. */
  readonly aboutTheStep: string | null;
};

export class ModelStepMisused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelStepMisused';
  }
}

/**
 * Puts the model's contribution beside the report, never inside it.
 *
 * `fromRules` goes in and comes out unchanged, and that is the closing half of
 * D.5 rather than a stylistic choice. There is no argument to
 * this function that could cause the rule packs' output to differ, which is
 * what *"the report does not change"* has to mean if it is to mean anything a
 * test can falsify.
 */
export function withModelStep(
  fromRules: string,
  step: ModelStepState,
  addition: string | null = null,
  lang: Lang = 'en',
): ReportParts {
  if (step === 'answered' && (addition === null || addition.trim() === '')) {
    throw new ModelStepMisused(
      `The model step is marked answered and added nothing. That is either a ` +
        `lost answer or a mislabelled failure, and a report cannot be built ` +
        `out of either without deciding which — a decision this function is ` +
        `in no position to make.`,
    );
  }

  if (step !== 'answered' && addition !== null) {
    // The one that matters. An addition arriving with a failed step is a
    // partial answer from a call that did not finish, on its way to a reader.
    throw new ModelStepMisused(
      `The model step is "${step}" and an addition was supplied anyway. ` +
        `Output from a call that failed does not reach a reader — that is the ` +
        `whole reason this function takes them as two arguments instead of ` +
        `one already-joined string.`,
    );
  }

  return {
    // Passed straight through. `withModelStep(r, …).fromRules === r` is what
    // the suite asserts, and it holds only because nothing here builds a new
    // string out of it — which is what a splice would have to do.
    fromRules,
    fromModel: step === 'answered' ? addition : null,
    aboutTheStep: modelStepLine(step, lang),
  };
}

/**
 * The three parts as one page, in the only order they may appear.
 *
 * Separate from `withModelStep` on purpose: composing is the caller's job and
 * this is the caller's convenience, so the invariant above does not depend on
 * anybody choosing to use it. A printer that wants its own spacing can read
 * the fields and never touch this.
 *
 * The order is not adjustable. The findings come first because they are what
 * the reader came for and what VS-7 measured; the note about what is missing
 * comes last because it is about an absence, and an absence announced before
 * the thing it is absent from reads as a warning about the report itself.
 */
export function joinParts(parts: ReportParts): string {
  const out = [parts.fromRules];
  if (parts.fromModel !== null) out.push(parts.fromModel);
  if (parts.aboutTheStep !== null) out.push(parts.aboutTheStep);
  return out.join('\n\n');
}

/**
 * The heading a model-written addition is printed under.
 *
 * It exists so a reader is never left to work out which sentences a machine
 * wrote. `origin: 'model_written'` and `confidenceBasis: 'model_output'` have
 * been in the claim vocabulary since `_doc/05` §7 for the same reason; this is
 * that distinction reaching the page.
 */
export function modelAdditionHeading(lang: Lang = 'en'): string {
  return t(lang, 'model.addition-heading');
}
