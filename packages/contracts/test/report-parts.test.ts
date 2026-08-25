/**
 * D.5's second half, and the reason it could not be closed before now.
 *
 * The criterion is *"the report does not change when the model step does not
 * happen"*. That was true trivially until D.1 existed, because there was no
 * model step that could change it — so D.5 was marked 🟨 rather than ✅, on the
 * grounds that ticking it would record a test nobody could run.
 *
 * This is that test. The assertion that carries it is that the rule packs'
 * output comes back **unchanged**, in every state and every language.
 *
 * ⚠️ It used to also assert `Object.is`, on the theory that "the same object"
 * was the stronger claim. A mutation proved that line could never fail —
 * strings are primitives, so identity and equality are one question. Removed
 * rather than kept: an assertion that cannot fail is worse than no assertion,
 * because the count says the property is guarded.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGS } from '../src/i18n.js';
import { MODEL_STEP_STATES } from '../src/model-step.js';
import {
  ModelStepMisused,
  joinParts,
  modelAdditionHeading,
  withModelStep,
} from '../src/report-parts.js';

/** Stands in for whatever the rule packs produced. Its content is irrelevant. */
const REPORT = [
  'WHAT THE DATABASE ITSELF CONFIRMS',
  '',
  '  6,459 of 49,148 rows in public.votes.post_id point at no post — 13.1%.',
].join('\n');

describe('the report the rule packs produced', () => {
  it('comes back unchanged, in every state, in every language', () => {
    // The closing half of D.5. There is no
    // argument to withModelStep that could make the rule packs' output differ,
    // and that is what "the report does not change" has to mean if a test is
    // to be able to falsify it.
    for (const lang of LANGS) {
      for (const step of MODEL_STEP_STATES) {
        const addition = step === 'answered' ? 'an addition' : null;
        const parts = withModelStep(REPORT, step, addition, lang);
        // 🟥 There used to be an `Object.is` assertion here too, on the
        // theory that "the same object" is stronger than "an equal one". A
        // mutation replacing `fromRules` with `String(fromRules)` left it
        // GREEN — strings are primitives, so identity and equality are the
        // same question and the extra line could never fail.
        //
        // Content equality is the strongest statement available about a
        // string, and it is enough: a string cannot be mutated, so the only
        // way the report can change is by being REBUILT, and rebuilding
        // changes the content. The splice mutation below proves this line
        // catches that.
        assert.equal(
          parts.fromRules,
          REPORT,
          `${lang}/${step} returned a different report`,
        );
      }
    }
  });

  it('keeps the model out of the report even when it answered', () => {
    const parts = withModelStep(REPORT, 'answered', 'MODEL WROTE THIS', 'en');
    assert.ok(
      !parts.fromRules.includes('MODEL WROTE THIS'),
      'the addition was spliced into the report',
    );
    assert.equal(parts.fromModel, 'MODEL WROTE THIS');
  });
});

describe('what it refuses', () => {
  it('refuses an addition that arrived with a failed step', () => {
    // The one that matters: output from a call that did not finish, on its way
    // to a reader. That is why this takes two arguments and not one string
    // somebody already joined.
    for (const step of ['unavailable', 'declined', 'not_configured'] as const) {
      assert.throws(
        () => withModelStep(REPORT, step, 'half an answer'),
        ModelStepMisused,
        `${step} accepted an addition`,
      );
    }
  });

  it('refuses a step that says it answered and added nothing', () => {
    for (const addition of [null, '', '   ']) {
      assert.throws(
        () => withModelStep(REPORT, 'answered', addition),
        ModelStepMisused,
      );
    }
  });
});

describe('what a reader ends up with', () => {
  it('says nothing about the model when nothing is missing', () => {
    // `not_configured` and `answered` are both silent about the step, for
    // different reasons that land in the same place. A line that fires on
    // every scan stops being read.
    assert.equal(withModelStep(REPORT, 'not_configured').aboutTheStep, null);
    assert.equal(withModelStep(REPORT, 'answered', 'x').aboutTheStep, null);
  });

  it('names the gap when something was going to be added and was not', () => {
    for (const lang of LANGS) {
      for (const step of ['unavailable', 'declined'] as const) {
        const said = withModelStep(REPORT, step, null, lang).aboutTheStep;
        assert.ok(said && said.length > 40, `${lang}/${step} said nothing useful`);
      }
    }
  });

  it('puts the findings first, always', () => {
    // Order is not adjustable. The findings are what the reader came for and
    // what VS-7 measured; a note about an absence, printed before the thing it
    // is absent from, reads as a warning about the report itself.
    for (const step of MODEL_STEP_STATES) {
      const addition = step === 'answered' ? 'an addition' : null;
      const page = joinParts(withModelStep(REPORT, step, addition));
      assert.ok(page.startsWith(REPORT), `${step} did not lead with the findings`);
    }
  });

  it('loses nothing when it joins', () => {
    const parts = withModelStep(REPORT, 'answered', 'an addition');
    const page = joinParts(parts);
    assert.ok(page.includes(REPORT));
    assert.ok(page.includes('an addition'));
  });

  it('marks model-written text as model-written, in both languages', () => {
    // A reader is never left working out which sentences a machine wrote.
    const said = LANGS.map((lang) => modelAdditionHeading(lang));
    assert.equal(new Set(said).size, LANGS.length, 'the heading reads alike');
    for (const s of said) assert.ok(s.length > 10);
  });
});
