/**
 * What the report says when the model step did not happen — HS-D D.5.
 *
 * ## The plan said the opposite, and the plan was written before the evidence
 *
 * `BUILD-PROGRESS` D.5 reads: *"degraded mode khi API lỗi → rơi về mẫu câu +
 * **nói rõ đang giảm cấp**"*. Model first; hand-written sentences as the
 * fallback; and when falling back, tell the reader they are getting the lesser
 * thing.
 *
 * Then VS-7 measured it. Five people who are responsible for a database and do
 * not build one read two real reports produced by hand-written rule packs with
 * no model anywhere in the path, and four of five came away with the right
 * conclusion. Nobody has ever measured the model path, because it does not
 * exist.
 *
 * So the sentence *"running in degraded mode"* would be a **claim about
 * quality with no measurement behind it, pointing the wrong way**. It teaches
 * the reader to discount the only output this product has ever validated on
 * human beings, in favour of one nobody has tested. That is not caution. It is
 * a confident statement about an ordering of two things where the evidence
 * runs the other way.
 *
 * The inversion, and it is a design decision rather than a wording change:
 *
 * ```text
 * WAS   model is the product · rule packs are the fallback · say it is degraded
 * IS    rule packs ARE the product · a model ADDS · say what was not added
 * ```
 *
 * ## What that leaves to say, and it is not nothing
 *
 * Saying nothing at all would be the opposite mistake. If a model was going to
 * add something and did not, the reader is looking at a report with a hole in
 * it, and this product's entire argument is that a hole must be visible. So
 * the rule is narrow:
 *
 * > Name **what did not get added**. Never grade **what is there**.
 *
 * The report's facts came from rule packs and did not change. What changed is
 * that an addition is missing, and that is a fact about the addition.
 *
 * ## Why there is a gate and not just careful wording
 *
 * `assertNoDefectWords` exists because *"an observed pattern is not a defect
 * until the owner says so"* was a rule people kept nearly breaking. This is the
 * same shape one step over: *"a report is not lesser because an addition to it
 * is missing"* is a rule the next person writing a status line will nearly
 * break, in good faith, because "degraded" is the word every other system uses.
 * `assertDoesNotDisparage` is the fence, and it is run over every sentence in
 * this module by its own test.
 */

import { z } from 'zod';

import { t } from './i18n.js';
import type { Lang } from './i18n.js';

/**
 * What happened to the model step on this run.
 *
 * Deliberately parallel to `LlmCallOutcome` in `llm-call.ts` without being the
 * same type. That one records **one call** as the history holds it; this one
 * describes **the step as a whole** to a reader, and the two differ in exactly
 * one place that matters: `not_configured` never produces a call, so it can
 * never appear in `llm_call`, and a shared enum would put a value in that
 * table's CHECK that nothing can ever write.
 */
export const ModelStepState = z.enum([
  /** No model is set up. The ordinary state today, and not a fault. */
  'not_configured',
  /** A model was asked and answered. */
  'answered',
  /** A model was asked and could not answer — down, slow, or refusing. */
  'unavailable',
  /** This product declined to send. See `untrusted.ts`. */
  'declined',
]);
export type ModelStepState = z.infer<typeof ModelStepState>;

export const MODEL_STEP_STATES = ModelStepState.options;

/**
 * Words that grade the report rather than name the gap.
 *
 * Every one of these is the natural word to reach for, which is the point of
 * writing them down. "Degraded" is what the original plan said and what every
 * other system prints; it is banned here because on the evidence this product
 * actually has, it is false.
 *
 * Matched on English and Vietnamese together, because the catalogue holds
 * both and a gate that only reads one language guards half a report — the
 * exact hole `AGENTS.md` §4.9 ① describes.
 */
const DISPARAGING =
  /\b(degrade[ds]?|degraded mode|reduced|limited mode|fallback mode|lesser|worse|incomplete report|partial report|best[- ]effort)\b|giảm cấp|kém hơn|hạn chế hơn|sơ sài|tạm bợ|chế độ dự phòng/i;

export class ReportDisparaged extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportDisparaged';
  }
}

/**
 * Refuses a sentence that grades the report instead of naming the gap.
 *
 * Throws rather than rewriting. A gate that quietly repairs its input is a
 * gate whose rule nobody ever learns, and this rule has to be learned — the
 * next status line somebody writes will reach for "degraded" in good faith.
 */
export function assertDoesNotDisparage(text: string, subject: string): void {
  const hit = DISPARAGING.exec(text);
  if (hit) {
    throw new ReportDisparaged(
      `${subject} but says "${hit[0]}". The findings in this report came from ` +
        `rule packs and did not change; what is missing is an ADDITION to ` +
        `them. Name what was not added. Grading what is there claims the ` +
        `model path is better than the rule packs, and the only measurement ` +
        `this product has — VS-7, five readers, 4 of 5 — points the other way.`,
    );
  }
}

/**
 * The one line a reader sees about the model step, or null for silence.
 *
 * `answered` and `not_configured` are both silent, for different reasons that
 * happen to land in the same place:
 *
 * ```text
 * answered        the addition is on the page; a line saying so is a line
 *                 saying "this worked", which every scan would carry
 * not_configured  nothing was expected, so nothing is missing. Announcing an
 *                 absent optional feature on every report is how a reader
 *                 learns to skip the top of the page.
 * ```
 *
 * The two that speak are the two where something a reader was going to get did
 * not arrive.
 */
export function modelStepLine(state: ModelStepState, lang: Lang = 'en'): string | null {
  switch (state) {
    case 'answered':
    case 'not_configured':
      return null;
    case 'unavailable':
      return t(lang, 'model.unavailable');
    case 'declined':
      return t(lang, 'model.declined');
  }
}
