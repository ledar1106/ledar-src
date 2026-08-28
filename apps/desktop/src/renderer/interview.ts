/**
 * S3 — the fixed question set, as state rather than screens.
 *
 * Ideal §13–§18. Five areas, `Yes / No / Don't know`, and a short list to
 * recognise after a `yes`. The set is the same for everyone on purpose: a
 * thousand people answering the same five questions is a MAP, and a thousand
 * people each writing a sentence is a thousand sentences nobody can join up.
 *
 * ## 🟥 What stood here before, and why it went — 2026-08-27
 *
 * One free-text question: *"Is there a rule your business depends on that I
 * should check?"* — with a model waiting downstream to turn the answer into a
 * runnable check. That was never what VS-6 asked for. Reading it that way cost:
 *
 * ```text
 * · a prompt-injection test rig built for a text box that should not exist,
 *   which then measured 7 breaches in 72 shots
 * · a "0-1/5 of cold questions land in a checkable shape" measurement, which
 *   was measuring the wrong thing entirely — "do you use Stripe?" is
 *   answerable 5 times out of 5
 * · the slice parked on the strength of that number
 * · an interview cut from six questions to one, which threw away the only
 *   substantive answer the first real person gave ("latency and speed")
 * ```
 *
 * The six it replaced were not the ideal's either. They asked for KNOWLEDGE —
 * *"what does a customer expect after an ORDER"* — and two of six were
 * unanswerable for the first real person because both assumed they sell
 * things. The questions here ask for RECOGNITION. Nobody has to understand a
 * backend to say whether their system logs people in.
 *
 * ## No model touches this path
 *
 * Not a mitigation, an absence. There is no free text, so there is nothing to
 * inject into and nothing to misread. The answers are three enum values and a
 * set of option ids that came from the contract in the first place.
 *
 * ## Where the question set comes from
 *
 * `window.ledar.interviewForm()`, built from `@ledar/contracts` on the main
 * side. This file holds no list of areas — see `main/interview-form.ts` for
 * why the round trip is cheaper than the copy it avoids.
 */

import type { AreaReply, InterviewForm, InterviewQuestion } from '../shared/ipc.js';

/**
 * What a person has said about one area, before it is sent anywhere.
 *
 * `null` is "not answered yet" and is different from `dont_know`, which is a
 * real answer somebody gave. Collapsing the two would make an interview a
 * person walked away from indistinguishable from one they finished by saying
 * they did not know — and those mean opposite things to whoever reads the
 * profile later.
 */
export type Reply = AreaReply | null;

export type Interview = {
  /** The questions THIS interview is asking, as the main side sent them. */
  readonly questions: readonly InterviewQuestion[];
  /** Which question is being asked. Equal to the count when finished. */
  readonly index: number;
  readonly replies: readonly Reply[];
};

/**
 * Answering can fail, and the caller has to say which failure it was —
 * returning the interview unchanged would let a rejected answer look exactly
 * like an accepted one that happened to change nothing.
 */
export type AnswerResult =
  | { readonly ok: true; readonly interview: Interview }
  | { readonly ok: false; readonly reason: 'finished' | 'unknown-option' };

export function startInterview(form: InterviewForm): Interview {
  return {
    questions: form.questions,
    index: 0,
    replies: form.questions.map(() => null),
  };
}

export function currentQuestion(interview: Interview): InterviewQuestion | null {
  return interview.questions[interview.index] ?? null;
}

export function isFinished(interview: Interview): boolean {
  return interview.index >= interview.questions.length;
}

/**
 * Records an answer and moves on.
 *
 * ⚠️ `picked` is checked against the options the MAIN side sent, not against
 * a list here. An id the form never offered is refused rather than passed on:
 * the renderer is where a person clicks, and a value arriving from it that
 * the contract never named is either a bug or somebody at a console — and
 * both deserve the same answer.
 *
 * ⚠️ `picked` is emptied for anything but `yes`. Someone who ticks two boxes
 * and then changes their answer to "no" must not leave those ticks behind in
 * the record; a `no` carrying a list of things they use is a contradiction
 * the profile would have to be read twice to catch.
 */
export function answer(
  interview: Interview,
  given: { answer: AreaReply['answer']; picked?: readonly string[] },
): AnswerResult {
  const question = currentQuestion(interview);
  if (question === null) return { ok: false, reason: 'finished' };

  const picked = given.answer === 'yes' ? [...(given.picked ?? [])] : [];
  for (const id of picked) {
    if (!question.options.includes(id)) return { ok: false, reason: 'unknown-option' };
  }

  const replies = [...interview.replies];
  replies[interview.index] = { area: question.area, answer: given.answer, picked };
  return { ok: true, interview: { ...interview, index: interview.index + 1, replies } };
}

/**
 * The button the ideal expects to be pressed most.
 *
 * *"Bỏ qua tất cả — cứ tự tìm đi."* Every unanswered area becomes `dont_know`,
 * because that is exactly what it means, and the interview ends.
 *
 * 🟩 This is not a failure path and the code should not read like one. The
 * ideal's audit is explicit: for this ICP it will be the most-used button, and
 * that is normal. A product that only worked for people who answered five
 * questions about a backend would be a product that does not work for the
 * people it is for.
 *
 * ⚠️ Answers already given are KEPT. Skipping the rest is not retracting what
 * you already said.
 */
export function skipRest(interview: Interview): Interview {
  const replies = interview.questions.map(
    (question, i): Reply =>
      interview.replies[i] ?? { area: question.area, answer: 'dont_know', picked: [] },
  );
  return { ...interview, index: interview.questions.length, replies };
}

/**
 * Everything the person said, for the main side to turn into `stated` rungs.
 *
 * Returns only what was actually answered. An interview abandoned halfway
 * yields the part that was answered and nothing invented for the rest — the
 * remaining areas stay `unknown` on the ladder, which is true, rather than
 * `dont_know`, which would be putting words in somebody's mouth.
 */
export function repliesOf(interview: Interview): readonly AreaReply[] {
  return interview.replies.filter((r): r is AreaReply => r !== null);
}
