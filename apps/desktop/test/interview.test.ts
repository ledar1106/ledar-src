/**
 * S3 — the interview state machine, and mostly one question about it:
 * WHICH answer is the rule.
 *
 * That question has been got wrong twice in this product, both times in a
 * patch written by the person who wrote the spec (`_doc/25` audit block).
 * Neither bug was a typo — each came from deriving the rule from something
 * that merely correlates with it. So the tests below do not check that
 * `ruleSentence` returns *a* string; they check it returns the string from
 * the flagged question while other answers are deliberately arranged to be
 * the tempting wrong one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  INTERVIEW_QUESTIONS,
  MAX_ANSWER_LENGTH,
  answerDontKnow,
  answerTyped,
  currentQuestion,
  isFinished,
  ruleSentence,
  startInterview,
} from '../src/renderer/interview.js';
import type { Interview } from '../src/renderer/interview.js';

/**
 * A longer interview than the product ships, built here on purpose.
 *
 * The shipped list is one question, which means the claim this product got
 * wrong twice — *the rule comes from the FLAGGED question, not from the last
 * answer* — cannot be put under any strain against it. A single-question
 * list passes that test no matter how `ruleSentence` is written.
 *
 * So the machine takes its questions as an argument and the flag discipline
 * is proved here, where the flagged question is deliberately NOT the last
 * one and the answer after it is a plausible-looking rule.
 */
const SEVERAL: readonly { id: 'rule'; isRule: boolean }[] = [
  { id: 'rule', isRule: false },
  { id: 'rule', isRule: true },
  { id: 'rule', isRule: false },
];

function answerAll(
  questions: readonly { id: 'rule'; isRule: boolean }[],
  labels: (i: number) => string,
): Interview {
  let interview = startInterview(questions);
  for (let i = 0; i < questions.length; i += 1) {
    const result = answerTyped(interview, labels(i));
    assert.ok(result.ok, `question ${i} refused an answer`);
    interview = result.interview;
  }
  return interview;
}

describe('what the product actually asks', () => {
  it('ships one question, and it is the rule', () => {
    // It was six until a real person answered them and two turned out to be
    // unanswerable unless you sell things. What is left is the one thing no
    // amount of reading a schema produces.
    assert.equal(INTERVIEW_QUESTIONS.length, 1);
    assert.equal(INTERVIEW_QUESTIONS[0]!.id, 'rule');
  });

  it('marks exactly one question as the rule', () => {
    const flagged = INTERVIEW_QUESTIONS.filter((question) => question.isRule);
    assert.equal(flagged.length, 1, 'exactly one question may carry the rule');
  });

  it('asks in order and then stops', () => {
    let interview = startInterview(SEVERAL);
    for (let i = 0; i < SEVERAL.length; i += 1) {
      assert.notEqual(currentQuestion(interview), null, `no question at position ${i}`);
      const result = answerDontKnow(interview);
      assert.ok(result.ok);
      interview = result.interview;
    }

    assert.ok(isFinished(interview));
    assert.equal(currentQuestion(interview), null);
  });

  it('refuses one answer past the end instead of silently growing', () => {
    const interview = answerAll(SEVERAL, (i) => `answer ${i}`);
    const extra = answerTyped(interview, 'one more');
    assert.equal(extra.ok, false);
    assert.equal(extra.ok === false && extra.reason, 'finished');
  });
});

describe('which sentence is the rule', () => {
  it('takes the flagged question, not the last thing the person said', () => {
    // The shape of the second P0: the patch anchored the rule to the END of
    // the interview and quoted the final answer back as "your rule". The
    // answer after the flagged one is a plausible-looking rule here, so a
    // wrong pick reads as a rule rather than as obvious nonsense.
    const interview = answerAll(SEVERAL, (i) =>
      i === 1
        ? 'No two users may share an email address.'
        : i === 2
          ? 'Every order must belong to a customer.'
          : `answer ${i}`,
    );

    assert.equal(ruleSentence(interview), 'No two users may share an email address.');
  });

  it('has no rule before the flagged question is reached', () => {
    const interview = startInterview(SEVERAL);
    assert.equal(ruleSentence(interview), null);

    const first = answerTyped(interview, 'answer 0');
    assert.ok(first.ok);
    assert.equal(ruleSentence(first.interview), null, 'a rule appeared one question early');
  });

  it('has no rule when the flagged question was skipped', () => {
    let interview = startInterview(SEVERAL);
    for (let i = 0; i < SEVERAL.length; i += 1) {
      const result = SEVERAL[i]!.isRule
        ? answerDontKnow(interview)
        : answerTyped(interview, `answer ${i}`);
      assert.ok(result.ok);
      interview = result.interview;
    }

    assert.ok(isFinished(interview));
    // Other answers are sitting right there. None of them is a rule, and the
    // absence of one has to survive all the way to the screen.
    assert.equal(ruleSentence(interview), null);
  });

  it('keeps the sentence exactly as typed, trimmed and not otherwise touched', () => {
    const result = answerTyped(
      startInterview(),
      '  Không hai người dùng nào được dùng chung một email — "ever".  ',
    );
    assert.ok(result.ok);

    assert.equal(
      ruleSentence(result.interview),
      'Không hai người dùng nào được dùng chung một email — "ever".',
    );
  });
});

describe('what counts as an answer', () => {
  it('records a skip as its own kind, not as an empty answer', () => {
    const result = answerDontKnow(startInterview());
    assert.ok(result.ok);
    // An empty string here would be indistinguishable from a question nobody
    // reached, and the product promises to go and find out — a promise it
    // cannot keep about an answer it cannot see.
    assert.deepEqual(result.interview.answers[0], { kind: 'dont-know' });
  });

  it('refuses blank and whitespace without advancing', () => {
    const interview = startInterview();
    for (const blank of ['', '   ', '\n\t ']) {
      const result = answerTyped(interview, blank);
      assert.equal(result.ok, false, `${JSON.stringify(blank)} was accepted`);
      assert.equal(result.ok === false && result.reason, 'empty');
    }
    assert.equal(interview.index, 0);
  });

  it('accepts an answer at the cap and refuses one past it', () => {
    const interview = startInterview();
    assert.ok(answerTyped(interview, 'a'.repeat(MAX_ANSWER_LENGTH)).ok);

    const over = answerTyped(interview, 'a'.repeat(MAX_ANSWER_LENGTH + 1));
    assert.equal(over.ok, false);
    assert.equal(over.ok === false && over.reason, 'too-long');
  });

  it('does not mutate the interview it was handed', () => {
    const first = startInterview();
    const second = answerTyped(first, 'an answer');
    assert.ok(second.ok);

    assert.equal(first.index, 0);
    assert.equal(first.answers[0], null);
    assert.equal(second.interview.index, 1);
  });
});
