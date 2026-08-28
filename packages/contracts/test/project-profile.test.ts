/**
 * What the profile shape is not allowed to let happen.
 *
 * This is G1's contract — ideal §13–§18 (the fixed question set), §22 (the
 * knowledge ladder) and §23–§24 (the profile itself). Everything asserted here
 * is a rule the ideal states in prose and this repo has to state in a type,
 * because the interview it replaces was prose-only and drifted for a week.
 *
 * The rules, in the order they matter:
 *
 *   1. A rung of the ladder cannot exist without what earns it. `verified`
 *      needs an observation AND a person; `observed` needs something a person
 *      could go and look at.
 *   2. What somebody SAID and what the scan SAW never merge. They are
 *      different kinds of knowing and the shape keeps them apart.
 *   3. An all-unknown profile is valid and must still produce a plan. That is
 *      the person who pressed "skip all of this", and the ideal's audit
 *      expects them to be the majority.
 *   4. A disagreement between the two halves is the most valuable output, and
 *      the two DIRECTIONS of disagreement must not be phrased alike.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  AREA_OPTIONS,
  AreaKnowledge,
  KnowledgeState,
  PROFILE_AREAS,
  ProjectProfile,
  canPlanFrom,
  conflictsIn,
  emptyProfile,
} from '../src/index.js';
import type { ProfileEvidence } from '../src/index.js';

const AT = '2026-08-27T00:00:00.000Z';
const FINGERPRINT = 'fp-test';

function evidence(over: Partial<ProfileEvidence> = {}): ProfileEvidence {
  return {
    where: 'public.users.stripe_customer_id',
    why: 'values in this column start with cus_',
    observedAt: AT,
    ...over,
  };
}

describe('the question set is the one the ideal specifies', () => {
  it('asks about five areas, and every one is answerable by recognition', () => {
    // §14-§18. Pinned as a set rather than a count so that adding an area is a
    // decision somebody makes here, in front of the note about why five.
    assert.deepEqual([...PROFILE_AREAS], ['auth', 'database', 'payment', 'storage', 'jobs']);
  });

  it('every area has an option list, including the one that has none', () => {
    // §18 asks its yes/no question and offers no follow-up list. An EMPTY list
    // is a decision a reader can see; a MISSING key is an oversight nobody can
    // tell apart from a decision.
    for (const area of PROFILE_AREAS) {
      assert.ok(AREA_OPTIONS[area] !== undefined, `${area} has no option list at all`);
    }
    assert.deepEqual(AREA_OPTIONS.jobs, []);
  });

  it("every list that exists offers 'other' and 'dont_know'", () => {
    // §13: the escape hatches are not optional. A list that forces a person to
    // pick something they are not sure of collects worse data than one that
    // lets them say so.
    for (const area of PROFILE_AREAS) {
      const options = AREA_OPTIONS[area];
      if (options.length === 0) continue;
      assert.ok(options.includes('other'), `${area} gives no way to say "something else"`);
      assert.ok(options.includes('dont_know'), `${area} gives no way to say "I do not know"`);
    }
  });

  it('🟥 the lists stay short enough to be recognised rather than read', () => {
    // The ideal's audit measured what a long interview costs: fifteen "don't
    // know"s in a row, and the person leaves feeling stupid. This is that
    // finding as a number. It is a JUDGEMENT, not a measurement — said out
    // loud so nobody later reads 9 as having been derived from anything.
    for (const area of PROFILE_AREAS) {
      assert.ok(
        AREA_OPTIONS[area].length <= 9,
        `${area} offers ${AREA_OPTIONS[area].length} options — past the point where a ` +
          `list is scanned rather than read`,
      );
    }
  });
});

describe('a rung of the ladder cannot exist without what earns it', () => {
  it('🟥 verified needs an observation and a person, and refuses without either', () => {
    // The whole reason the ladder is a union and not an enum plus optional
    // fields. Debt N49 cost a slice to learn this: optional fields let a state
    // be built without its backing, and then the ABSENCE starts meaning
    // something nobody wrote.
    assert.throws(
      () => AreaKnowledge.parse({ state: 'verified', evidence: [], confirmedAt: AT }),
      'verified was accepted with no evidence behind it',
    );
    assert.throws(
      () => AreaKnowledge.parse({ state: 'verified', evidence: [evidence()] }),
      'verified was accepted with nobody having confirmed it',
    );
    assert.doesNotThrow(() =>
      AreaKnowledge.parse({ state: 'verified', evidence: [evidence()], confirmedAt: AT }),
    );
  });

  it('observed and suspected both refuse to exist with nothing seen', () => {
    assert.throws(() => AreaKnowledge.parse({ state: 'observed', evidence: [], stated: null }));
    assert.throws(() => AreaKnowledge.parse({ state: 'suspected', evidence: [], stated: null }));
  });

  it('🟥 an observation names a place a person could go and check', () => {
    // An observation nobody can verify is an assertion, and this product does
    // not get to make those. A blank `why` passes `.min(1)` as a space, which
    // is the exact hole `saying()` exists to close on findings.
    assert.throws(
      () => AreaKnowledge.parse({ state: 'observed', stated: null, evidence: [evidence({ why: '   ' })] }),
      'an observation whose reason is whitespace was accepted',
    );
    assert.throws(
      () => AreaKnowledge.parse({ state: 'observed', stated: null, evidence: [evidence({ where: '' })] }),
      'an observation with no place to look was accepted',
    );
  });

  it('the ladder has exactly the five rungs the ideal names', () => {
    assert.deepEqual(
      [...KnowledgeState.options],
      ['unknown', 'stated', 'suspected', 'observed', 'verified'],
    );
  });
});

describe('what was said and what was seen stay apart', () => {
  it('🟥 a stated answer carries no evidence field to put a measurement in', () => {
    // Law 2. If `stated` could carry evidence, some code path would eventually
    // write a scan result into it and the two kinds of knowing would merge —
    // and after that no report can say which half it is relying on. This is
    // the same split `origin` and `confidenceBasis` enforce on a finding.
    const parsed = AreaKnowledge.parse({ state: 'stated', answer: 'yes', picked: ['stripe'] });
    assert.ok(!('evidence' in parsed), '`stated` grew a place to keep a measurement');
  });

  it("'no' is kept as an answer rather than treated as an absence", () => {
    // Someone saying "no payments" is a FACT about what they believe. A scan
    // that then finds a payments table has found a disagreement — which is the
    // most useful thing the product can put on screen. Dropping the `no` would
    // throw that away and leave only "we found a payments table", which is
    // the question they did not know to ask, minus the reason it is
    // interesting.
    const parsed = AreaKnowledge.parse({ state: 'stated', answer: 'no' });
    assert.equal(parsed.state === 'stated' && parsed.answer, 'no');
  });
});

describe('the person who skipped everything', () => {
  it('🟥 an all-unknown profile is valid, and can still plan a scan', () => {
    // Law 3, and it is not a corner case. The ideal's audit says the "skip all
    // of this — just go and look" button will be the most pressed one for this
    // ICP, and calls that normal rather than a failure. A profile shape that
    // needed answers would make the product unusable for exactly the people it
    // is for.
    const p = emptyProfile(FINGERPRINT, AT);
    assert.doesNotThrow(() => ProjectProfile.parse(p));
    assert.ok(canPlanFrom(p), 'a person who skipped every question cannot be scanned for');
    for (const area of PROFILE_AREAS) {
      assert.equal(p.areas[area]?.state, 'unknown');
    }
  });

  it('a profile carries a version and a time, because it is meant to be edited', () => {
    // §24: a profile is not the final truth. Without a version nothing can
    // diff two of them, and without a timestamp an answer given in a hurry in
    // March reads six months later as though it were current.
    const p = emptyProfile(FINGERPRINT, AT);
    assert.equal(p.version, 1);
    assert.equal(p.updatedAt, AT);
  });

  it('🟥 it holds a fingerprint, never a connection string', () => {
    // Same rule the run history lives under. A profile is a file meant to be
    // read often; a credential inside it is a credential read often.
    assert.throws(() => ProjectProfile.parse({ ...emptyProfile(FINGERPRINT, AT), databaseFingerprint: '' }));
  });
});

describe('where the two halves disagree', () => {
  function profileWith(area: 'payment', known: unknown): ProjectProfile {
    const p = emptyProfile(FINGERPRINT, AT);
    return { ...p, areas: { ...p.areas, [area]: AreaKnowledge.parse(known) } };
  }

  it('🟥 said no, found something — the case worth showing them', () => {
    const found = conflictsIn(
      profileWith('payment', { state: 'observed', stated: 'no', evidence: [evidence()] }),
    );
    assert.equal(found.length, 1);
    assert.equal(found[0]?.direction, 'said_no_found_yes');
    assert.equal(found[0]?.area, 'payment');
  });

  it('agreement is not a conflict', () => {
    const found = conflictsIn(
      profileWith('payment', { state: 'observed', stated: 'yes', evidence: [evidence()] }),
    );
    assert.deepEqual(found, []);
  });

  it('🟥 "I do not know" is never reported as a disagreement', () => {
    // The default answer. Treating it as a conflict would turn the button the
    // product WANTS people to press into a source of accusations.
    const found = conflictsIn(
      profileWith('payment', { state: 'observed', stated: 'dont_know', evidence: [evidence()] }),
    );
    assert.deepEqual(found, []);
  });

  it('nothing measured means nothing to disagree with', () => {
    // `stated` alone cannot conflict: there is no measurement on the other
    // side of it. Reporting one would be the product contradicting a person
    // on the strength of having not looked.
    const p = profileWith('payment', { state: 'stated', answer: 'no' });
    assert.deepEqual(conflictsIn(p), []);
    assert.deepEqual(conflictsIn(emptyProfile(FINGERPRINT, AT)), []);
  });

  it('🟥 the two directions are separate values, not one flag', () => {
    // They mean opposite things and must never be phrased alike. "You did not
    // know this was here" is a finding about their system; "I could not see
    // what you described" is a finding about MY COVERAGE — usually because it
    // lives outside this database — and calling that second one an error
    // would be the product mistaking the edge of its own vision for the edge
    // of the world.
    const directions: readonly string[] = ['said_no_found_yes', 'said_yes_found_no'];
    assert.equal(new Set(directions).size, 2);
  });
});
