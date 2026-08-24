/**
 * The coverage split `_doc/05` asked for. Debt N1.
 *
 * `checked` and `eligible` are the pair every rule has always been able to
 * state. The four fields added here pull that pair apart — what the role could
 * see, what was read in full, what was answered from a sample, what was looked
 * at and then set aside — and every one of them is nullable.
 *
 * The nullability is the design, not a convenience. If the only way to say
 * *this rule did not separate these* were to write 0, then not knowing would
 * be recorded as a measurement. That substitution is not hypothetical here:
 * `GREATEST(reltuples, 0)` turned "nobody has run ANALYZE on this table" into
 * "this table has 0 rows" once already.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Coverage, coverageOf } from '../src/findings.js';

const FULL = {
  checked: 10,
  eligible: 12,
  skipped: [],
  truncatedAt: null,
  visibleToRole: 20,
  verified: 7,
  sampled: 3,
  excluded: 2,
};

describe('the coverage split', () => {
  it('accepts a record whose parts add up', () => {
    assert.equal(Coverage.safeParse(FULL).success, true);
  });

  it('refuses verified + sampled that disagrees with checked', () => {
    // Every target that was checked took exactly one of the two routes. A
    // record saying otherwise cannot all be true at once, and a diff built on
    // it would compare two numbers that were never counted over one
    // population.
    const bad = Coverage.safeParse({ ...FULL, verified: 7, sampled: 9 });
    assert.equal(bad.success, false);
    assert.match(
      bad.success ? '' : (bad.error.issues[0]?.message ?? ''),
      /verified \(7\) \+ sampled \(9\) is 16, but checked says 10/,
    );
  });

  it('refuses a rule that applies to more than the role can see', () => {
    const bad = Coverage.safeParse({ ...FULL, visibleToRole: 5, eligible: 12 });
    assert.equal(bad.success, false);
    assert.match(
      bad.success ? '' : (bad.error.issues[0]?.message ?? ''),
      /visibleToRole \(5\) is below eligible \(12\)/,
    );
  });

  it('refuses more excluded than were ever checked', () => {
    // `excluded` is a subset of `checked`, not a sibling. Layer B says so in
    // its own docstring — "these were checked; they are already inside
    // candidatesVerified" — and the definition here agrees: a target set aside
    // was looked at first.
    const bad = Coverage.safeParse({ ...FULL, excluded: 11 });
    assert.equal(bad.success, false);
    assert.match(
      bad.success ? '' : (bad.error.issues[0]?.message ?? ''),
      /excluded \(11\) is above checked \(10\)/,
    );
  });

  it('checks nothing when a half was not stated', () => {
    // A rule that says nothing is not making a claim that can be wrong. The
    // arithmetic gate applies to records that state both halves, and stays
    // silent about records that state one — which is most of them.
    assert.equal(Coverage.safeParse({ ...FULL, sampled: null }).success, true);
    assert.equal(Coverage.safeParse({ ...FULL, verified: null }).success, true);
    assert.equal(
      Coverage.safeParse({ ...FULL, visibleToRole: null, eligible: 999 }).success,
      true,
    );
  });

  it('says "did not separate these" rather than zero, by default', () => {
    // `coverageOf` exists so that adding four fields did not turn into four
    // zeroes appearing across the codebase. A zero here is a claim: it says
    // the rule looked and found none of that kind.
    const c = coverageOf(4, 6);
    assert.equal(c.checked, 4);
    assert.equal(c.eligible, 6);
    assert.equal(c.visibleToRole, null);
    assert.equal(c.verified, null);
    assert.equal(c.sampled, null);
    assert.equal(c.excluded, null);
    assert.equal(Coverage.safeParse(c).success, true);
  });

  it('lets a rule state zero when zero is what it measured', () => {
    // The other side of the same coin. Layer A never samples — it counts every
    // offending row up to a ceiling — so `sampled: 0` is a real measurement
    // there, and it has to be expressible without being confused with silence.
    const layerA = { ...coverageOf(5, 5), verified: 5, sampled: 0, excluded: 0 };
    assert.equal(Coverage.safeParse(layerA).success, true);
    assert.notEqual(layerA.sampled, null);
  });
});
