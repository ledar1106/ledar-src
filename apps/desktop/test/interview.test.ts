/**
 * The five questions, and the promises the shape has to keep.
 *
 * Ideal §13–§18. What is asserted here is not "the UI works" — there is no DOM
 * in this suite — it is the handful of rules that, if they break, turn a map
 * into a record of things somebody did not actually say.
 *
 *   1. The set the window renders is the CONTRACT'S set. Not a copy.
 *   2. Skipping is a first-class ending, and it keeps what was already said.
 *   3. "Not answered" and "I do not know" never collapse into each other.
 *   4. An answer that is not `yes` carries no list of things they use.
 *   5. Every option the contract offers has a label to render.
 *
 * 🟥 Rule 5 is the one that would fail silently. The ids cross the bridge as
 * strings, so no compiler checks them against the catalogue; without this test
 * a new option in `@ledar/contracts` reaches a person as a raw `supabase_auth`
 * on screen, or worse as a blank row they never mention.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AREA_OPTIONS, PROFILE_AREAS } from '@ledar/contracts';

import { interviewForm } from '../src/main/interview-form.js';
import { en } from '../src/renderer/i18n/en.js';
import {
  answer,
  currentQuestion,
  isFinished,
  repliesOf,
  skipRest,
  startInterview,
} from '../src/renderer/interview.js';

const FORM = interviewForm();

describe('the set the window is given', () => {
  it('🟥 is the contract’s set, in the contract’s order', () => {
    // Rule 1. The renderer holds no list of areas and must not grow one — the
    // whole reason `interviewForm` is a channel rather than a constant is
    // §4.27, where a third copy of a contract vocabulary sat just outside the
    // fence built to catch copies and a build ended up refusing to read a row
    // it had written itself.
    assert.deepEqual(
      FORM.questions.map((q) => q.area),
      [...PROFILE_AREAS],
    );
  });

  it('carries each area’s options, including the area that has none', () => {
    for (const question of FORM.questions) {
      assert.deepEqual(question.options, [...AREA_OPTIONS[question.area]]);
    }
    // §18 asks its question and offers no list. An empty array travelling
    // intact is the decision arriving; an absent key would be an oversight
    // nobody could tell from a decision.
    assert.deepEqual(
      FORM.questions.find((q) => q.area === 'jobs')?.options,
      [],
    );
  });

  it('hands over copies, so nothing across the bridge holds a contract value', () => {
    assert.notEqual(FORM.questions[0]?.options, AREA_OPTIONS[PROFILE_AREAS[0]!]);
  });
});

describe('answering', () => {
  it('walks the questions in order and finishes', () => {
    let interview = startInterview(FORM);
    for (const area of PROFILE_AREAS) {
      assert.equal(currentQuestion(interview)?.area, area);
      const result = answer(interview, { answer: 'no' });
      assert.ok(result.ok);
      if (result.ok) interview = result.interview;
    }
    assert.ok(isFinished(interview));
    assert.equal(currentQuestion(interview), null);
    assert.equal(answer(interview, { answer: 'no' }).ok, false);
  });

  it('🟥 an answer that is not "yes" carries no list of things they use', () => {
    // Rule 4. Somebody ticks two boxes, changes their mind to "no", and the
    // record must not keep the ticks — a `no` carrying a list of tools is a
    // contradiction the profile would have to be read twice to catch.
    const interview = startInterview(FORM);
    const result = answer(interview, { answer: 'no', picked: ['supabase_auth'] });
    assert.ok(result.ok);
    if (result.ok) assert.deepEqual(result.interview.replies[0]?.picked, []);
  });

  it('🟥 refuses an option the form never offered', () => {
    // The renderer builds its boxes from what main sent, so this cannot be
    // reached by clicking. It is refused rather than passed on because the
    // only ways to produce one are a bug or somebody at a console, and both
    // deserve the same answer.
    const interview = startInterview(FORM);
    const result = answer(interview, { answer: 'yes', picked: ['definitely-not-an-option'] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'unknown-option');
  });

  it('keeps a real pick', () => {
    const interview = startInterview(FORM);
    const result = answer(interview, { answer: 'yes', picked: ['supabase_auth'] });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.interview.replies[0], {
        area: 'auth',
        answer: 'yes',
        picked: ['supabase_auth'],
      });
    }
  });
});

describe('the person who skips', () => {
  it('🟥 skipping ends the interview and keeps what was already said', () => {
    // Rule 2. Skipping the rest is not retracting the part you answered, and
    // the ideal's audit expects this button to be the most-used control in the
    // product for this ICP — so it is a first-class ending, not an escape.
    let interview = startInterview(FORM);
    const first = answer(interview, { answer: 'yes', picked: ['clerk'] });
    assert.ok(first.ok);
    if (first.ok) interview = first.interview;

    const skipped = skipRest(interview);
    assert.ok(isFinished(skipped));
    assert.equal(skipped.replies[0]?.answer, 'yes');
    assert.deepEqual(skipped.replies[0]?.picked, ['clerk']);
    for (let i = 1; i < PROFILE_AREAS.length; i += 1) {
      assert.equal(skipped.replies[i]?.answer, 'dont_know');
    }
  });

  it('skipping from the very first question answers every area "I do not know"', () => {
    const skipped = skipRest(startInterview(FORM));
    assert.equal(repliesOf(skipped).length, PROFILE_AREAS.length);
    assert.ok(repliesOf(skipped).every((r) => r.answer === 'dont_know'));
  });

  it('🟥 walking away is not the same as saying "I do not know"', () => {
    // Rule 3, and it is the one that changes what a later reader concludes.
    // An abandoned interview leaves the rest UNANSWERED — those areas stay
    // `unknown` on the ladder, which is true — rather than `dont_know`, which
    // would be putting words in somebody's mouth.
    let interview = startInterview(FORM);
    const first = answer(interview, { answer: 'no' });
    assert.ok(first.ok);
    if (first.ok) interview = first.interview;

    assert.equal(repliesOf(interview).length, 1);
    assert.equal(interview.replies[1], null);
    assert.notEqual(interview.replies[1], 'dont_know');
  });
});

describe('every option the contract offers can be rendered', () => {
  it('🟥 has a label, or a person meets a raw id', () => {
    // Rule 5. Ids cross the bridge as strings, so nothing else checks this.
    const missing: string[] = [];
    for (const area of PROFILE_AREAS) {
      for (const id of AREA_OPTIONS[area]) {
        if (!(`interview.option.${id}` in en)) missing.push(`${area}/${id}`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      `these options would reach a person as a raw id: ${missing.join(', ')}`,
    );
  });

  it('🟥 every area has a question and a follow-up heading', () => {
    const missing: string[] = [];
    for (const area of PROFILE_AREAS) {
      if (!(`interview.area.${area}` in en)) missing.push(`interview.area.${area}`);
      if (!(`interview.which.${area}` in en)) missing.push(`interview.which.${area}`);
    }
    assert.deepEqual(missing, [], `missing catalogue keys: ${missing.join(', ')}`);
  });

  it('🟥 no question asks the person to know how something works', () => {
    // The rule the six questions this replaced broke. A question containing
    // "expect", "must", "should" or "why" is asking for KNOWLEDGE; these ask
    // whether a thing is there, which somebody can answer by looking at their
    // own screen.
    //
    // ⚠️ A word list is a coarse instrument and catches a revert, not a
    // rephrase. Stated so nobody reads a green here as proof the questions are
    // answerable — that was measured on one real person, not asserted here.
    const KNOWLEDGE_WORDS = [' expect', ' must ', ' should ', ' why '];
    for (const area of PROFILE_AREAS) {
      const asked = ` ${en[`interview.area.${area}` as keyof typeof en].toLowerCase()} `;
      for (const word of KNOWLEDGE_WORDS) {
        assert.ok(
          !asked.includes(word),
          `"${area}" asks for knowledge, not recognition: it contains "${word.trim()}"`,
        );
      }
    }
  });
});
