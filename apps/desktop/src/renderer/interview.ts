/**
 * S3 — the six-question business interview, as state rather than screens.
 *
 * No DOM in this file. The window renders it; a test drives the whole
 * conversation without a window, which is the only way the assertions below
 * about WHICH answer is the rule can be made at all.
 *
 * ## 🟥 Why `isRule` is a flag on the question and not an index
 *
 * The audited demo shipped this bug twice in one day (`_doc/25` audit block,
 * AGENTS §4.20):
 *
 * ```text
 * P0        a fixed rule was labelled "Your rule" whatever the user typed
 * P0 again  the first patch anchored the rule to the END of the interview,
 *           so it quoted QUESTION SIX back as "your rule"
 * ```
 *
 * Both are the same mistake: deriving *which sentence is the rule* from
 * something that merely correlates with it — a constant, or a position in
 * time. The rule is a property of one question, so it is stored on that
 * question, and `ruleSentence` reads the flag. Moving the rule question, or
 * adding a seventh, cannot silently re-point it.
 *
 * ## "I don't know" is an answer, and it is NOT a rule
 *
 * `_doc/25` S3 makes the button peer-level with the input on purpose: not
 * knowing is a legitimate answer and the product goes and finds out. So it is
 * recorded as its own kind — never as an empty string, which would be
 * indistinguishable from a question nobody answered.
 *
 * The consequence that matters is at question five: "I don't know" there means
 * **there is no rule**. `ruleSentence` returns null, and nothing downstream is
 * allowed to invent one to fill the gap.
 */

/**
 * 🟥 This was six questions until 2026-08-27, and the first real person to
 * answer them is why it is one.
 *
 * ```text
 * asked                                        answered?
 * what does a customer expect after an ORDER   no — "I don't know"
 * which records would confuse you if gone      yes
 * what must be true before an ORDER is done    no — "i don`t no"
 * which part worries you most                  yes — "latency and speed"
 * describe one rule                            yes
 * who should decide                            yes
 * ```
 *
 * The two that failed are the only two that assumed the person sells things.
 * The database they had connected has no orders in it, so those questions had
 * no true answer available — the product was not asking something hard, it
 * was asking something unanswerable.
 *
 * And "which part worries you most" got a real answer — latency — that this
 * product cannot look at at all. Asking a question whose answer you have to
 * throw away is its own kind of dishonesty.
 *
 * ## Why the rest went rather than being rewritten
 *
 * The audit block over §12 of the ideal is the heaviest finding in its
 * onboarding section, and it is exactly this:
 *
 * > You are asking people the very thing that, by your own definition of who
 * > this is for, they do not know. Reverse the order: scan first, show what
 * > was found, and let them confirm. The old question demands KNOWLEDGE; the
 * > new one only asks them to RECOGNISE something already on the screen.
 *
 * Sorted by who can actually answer, most of the six were asking for things
 * the scan reads off the database minutes later — table names, sizes, what
 * points at what. Those belong after a scan, phrased as confirmation, and
 * this shell has no scan screen yet. So they are not here at all rather than
 * here in a worse form.
 *
 * What is left is the one thing no amount of reading a schema produces: a
 * sentence about what the business needs to be true. That is VS-6's whole
 * input, and it is the only question this slice can both ask honestly and
 * use.
 *
 * ⚠️ `_doc/25` S3 still describes six. The correction block at the end of
 * that file records this decision and its evidence; the contract has not been
 * rewritten out from under anyone.
 */
export type QuestionId = 'rule';

export type InterviewQuestion = {
  readonly id: QuestionId;
  /** Whether the answer to THIS question is the rule the product may check. */
  readonly isRule: boolean;
};

export const INTERVIEW_QUESTIONS: readonly InterviewQuestion[] = [
  { id: 'rule', isRule: true },
];

/**
 * A free-text answer longer than this is not a sentence about a business.
 *
 * ⚠️ This is a bound on what the window accumulates, NOT the gate that
 * matters. The gate that matters stands where this text meets a prompt, and
 * that door is not in this slice — it is the subject of `_doc/26`. Counting
 * this as a defence against prompt stuffing would be counting a fence that
 * stands in a different field.
 */
export const MAX_ANSWER_LENGTH = 2000;

export type Answer =
  | { readonly kind: 'typed'; readonly text: string }
  | { readonly kind: 'dont-know' };

export type Interview = {
  /**
   * The questions THIS interview is asking.
   *
   * Carried on the interview rather than read from the module constant so
   * that the flag discipline stays testable after the shipped list shrank to
   * one question. With a single question, "the rule comes from the flagged
   * question and not from the last one answered" is a claim no test can put
   * under strain — and that claim is the one this product got wrong twice.
   * A test builds its own list of several questions and proves it there.
   */
  readonly questions: readonly InterviewQuestion[];
  /** Which question is being asked. Equal to the count when finished. */
  readonly index: number;
  readonly answers: readonly (Answer | null)[];
};

/**
 * Answering can fail, and the caller has to say which failure it was —
 * returning the interview unchanged would let a rejected answer look exactly
 * like an accepted one that happened to change nothing.
 */
export type AnswerResult =
  | { readonly ok: true; readonly interview: Interview }
  | { readonly ok: false; readonly reason: 'empty' | 'too-long' | 'finished' };

export function startInterview(
  questions: readonly InterviewQuestion[] = INTERVIEW_QUESTIONS,
): Interview {
  return { questions, index: 0, answers: questions.map(() => null) };
}

export function isFinished(interview: Interview): boolean {
  return interview.index >= interview.questions.length;
}

export function currentQuestion(interview: Interview): InterviewQuestion | null {
  return interview.questions[interview.index] ?? null;
}

function record(interview: Interview, answer: Answer): Interview {
  const answers = interview.answers.slice();
  answers[interview.index] = answer;
  return { questions: interview.questions, index: interview.index + 1, answers };
}

export function answerTyped(interview: Interview, raw: string): AnswerResult {
  if (isFinished(interview)) return { ok: false, reason: 'finished' };
  const text = raw.trim();
  if (text === '') return { ok: false, reason: 'empty' };
  if (text.length > MAX_ANSWER_LENGTH) return { ok: false, reason: 'too-long' };
  return { ok: true, interview: record(interview, { kind: 'typed', text }) };
}

export function answerDontKnow(interview: Interview): AnswerResult {
  if (isFinished(interview)) return { ok: false, reason: 'finished' };
  return { ok: true, interview: record(interview, { kind: 'dont-know' }) };
}

/**
 * The sentence the user wrote as their rule, or null when there is none.
 *
 * Null has two causes and they are deliberately not distinguished here: the
 * question was answered "I don't know", or it has not been reached yet.
 * Either way there is no rule, and every caller of this function is asking
 * the same question — *do I have a sentence to read back?* A caller that
 * needs to tell those apart is asking about the INTERVIEW, and should read
 * `answers` directly.
 */
export function ruleSentence(interview: Interview): string | null {
  const at = interview.questions.findIndex((question) => question.isRule);
  const answer = interview.answers[at];
  if (answer === undefined || answer === null) return null;
  return answer.kind === 'typed' ? answer.text : null;
}
