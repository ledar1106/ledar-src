/**
 * What a rule that raised nothing is able to say for itself.
 *
 * Debt N7. The aggregate strip adds every rule together, so once a report
 * contains findings, a rule that ran and found none vanishes into the total —
 * and on screen that is indistinguishable from a rule that never ran. The
 * per-rule numbers existed the whole time and were never shown.
 *
 * The distinction is this product's thesis pointed at itself: *nothing found*
 * is a result, worth as much as a finding, PROVIDED it states its denominator.
 * A reader looking at three foreign-key findings and no mention of CHECK
 * constraints cannot otherwise tell whether the CHECK rule looked at forty and
 * was satisfied, or was never reached.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScopeStripRefused, scopeStripByRule } from '../src/scope-strip.js';
import type { RuleCoverage } from '../src/scope-strip.js';

function rule(over: Partial<RuleCoverage> = {}): RuleCoverage {
  return {
    rule: 'layer-a/some-rule',
    ran: true,
    eligible: 10,
    checked: 10,
    notChecked: 0,
    ...over,
  } as RuleCoverage;
}

describe('the rules that raised nothing', () => {
  it('lists a silent rule with the denominator it was silent about', () => {
    const lines = scopeStripByRule([rule({ rule: 'r/quiet' })], { 'r/other': 2 });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /r\/quiet/);
    assert.match(
      lines[0]!,
      /checked 10 of 10/,
      '"raised nothing" without a denominator is the sentence this exists to ' +
        'replace, not the sentence it prints',
    );
  });

  it('says nothing about a rule that raised something', () => {
    // It has already spoken for itself further up the report. Repeating it
    // here pads the part a non-specialist is likeliest to skip.
    const lines = scopeStripByRule([rule({ rule: 'r/loud' })], { 'r/loud': 3 });
    assert.deepEqual(lines, []);
  });

  it('names a rule that did not run as not having run', () => {
    const lines = scopeStripByRule(
      [rule({ rule: 'r/never', ran: false, checked: 0, notChecked: 10 })],
      { 'r/other': 1 },
    );
    assert.match(lines[0]!, /did not run/);
    assert.doesNotMatch(
      lines[0]!,
      /raised nothing/,
      'a rule that never ran did not raise nothing — it has no result at all, ' +
        'and the two readings are exactly what this list exists to separate',
    );
  });

  it('a denominator of zero is an answer, not a shrug', () => {
    const lines = scopeStripByRule(
      [rule({ rule: 'r/empty', eligible: 0, checked: 0, notChecked: 0 })],
      { 'r/other': 1 },
    );
    assert.match(lines[0]!, /nothing of this kind exists here/);
    assert.doesNotMatch(
      lines[0]!,
      /0 of 0/,
      '"checked 0 of 0" is arithmetically true and reads like a shrug. What ' +
        'happened is that the database has none of the thing the rule looks ' +
        'for, and that is a result.',
    );
  });

  it('an unknown denominator is never rendered as a number', () => {
    const lines = scopeStripByRule(
      [rule({ rule: 'r/unknown', eligible: null, checked: 4, notChecked: 0 })],
      { 'r/other': 1 },
    );
    assert.match(lines[0]!, /cannot say out of how many/);
  });

  it('a coverage hole is named beside the coverage', () => {
    const lines = scopeStripByRule(
      [rule({ rule: 'r/partial', eligible: 10, checked: 6, notChecked: 4 })],
      { 'r/other': 1 },
    );
    assert.match(lines[0]!, /checked 6 of 10/);
    assert.match(
      lines[0]!,
      /4 not reached/,
      '"raised nothing, having checked 6 of 10" without saying what happened ' +
        'to the other four invites the reader to assume they were fine',
    );
  });
});

describe('numbers that may not print as a total may not print as a list', () => {
  // The gate is shared with buildScopeStrip on purpose. Two renderers reading
  // the same numbers must not disagree about which numbers are printable — a
  // second copy of these rules is a way for the aggregate line to refuse a
  // scan while the per-rule list prints it happily, and a reader would have no
  // way to tell which one to believe.
  it('refuses coverage that does not add up', () => {
    assert.throws(
      () => scopeStripByRule([rule({ eligible: 10, checked: 6, notChecked: 2 })], {}),
      ScopeStripRefused,
    );
  });

  it('refuses a rule that says it did not run and also checked things', () => {
    assert.throws(
      () => scopeStripByRule([rule({ ran: false, checked: 5, notChecked: 5 })], {}),
      ScopeStripRefused,
    );
  });

  it('refuses coverage of the wrong shape entirely', () => {
    assert.throws(
      () => scopeStripByRule([{ rule: 'r/bad' } as unknown as RuleCoverage], {}),
      ScopeStripRefused,
    );
  });
});
