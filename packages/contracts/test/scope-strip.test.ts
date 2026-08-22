/**
 * VS-4 — the one line a reader is told they can rely on.
 *
 * Run:  npx tsx --test packages/contracts/test/scope-strip.test.ts
 *
 * Every case here is a strip a user could have been shown above a report,
 * with the conclusion it was supposed to bound printed right under it. The
 * point of the file is that none of them can be printed.
 *
 * The strip is load-bearing in a way no other sentence in the report is: if
 * it is wrong, every other sentence loses the thing that limits it. So the
 * bar is not "the numbers are usually right" — it is that a number nobody
 * can stand behind cannot reach the line at all, and that a hole in the
 * numbers is spelled rather than closed over.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildScopeStrip,
  scopeStripLine,
  ScopeStripRefused,
  type RuleCoverage,
  type ScopeManifest,
  type ScopeStrip,
} from '../src/index.js';

/**
 * The separator, written as an escape on purpose.
 *
 * An exact-equality assertion below is the only thing that catches a whole
 * part quietly falling off the line, and it would be a poor trade to have it
 * fail on a file encoding instead.
 */
const DOT = ' · ';

/** A scope with nothing wrong with it: 47 of 52 tables, and the 52 is known. */
function scope(over: Partial<ScopeManifest> = {}): ScopeManifest {
  return {
    database: 'pagila',
    role: 'ledar_reader',
    schemas: ['public'],
    visibleTables: 47,
    totalTables: 52,
    grantedAt: null,
    readOnlyEnforcedByDatabase: true,
    disclosure: null,
    ...over,
  };
}

/**
 * One rule's coverage, coherent, to be spoiled one field at a time.
 *
 * Coherent matters here more than it usually does. `buildScopeStrip` has two
 * gates in a row, and a fixture that trips the first one can never reach the
 * second — a test written on a rule that is wrong in two ways at once goes
 * green on a refusal it was not asking about.
 */
function ruleCoverage(over: Record<string, unknown> = {}): RuleCoverage {
  return {
    rule: 'layer-a/no-unvalidated-constraint-violations',
    ran: true,
    eligible: 14,
    checked: 12,
    notChecked: 2,
    ...over,
  } as RuleCoverage;
}

function refusalFrom(
  rules: readonly RuleCoverage[],
  manifest: ScopeManifest = scope(),
): ScopeStripRefused {
  try {
    buildScopeStrip(manifest, rules);
  } catch (err) {
    assert.ok(
      err instanceof ScopeStripRefused,
      `expected ScopeStripRefused, got ${err}`,
    );
    return err;
  }
  throw new assert.AssertionError({
    message: 'the strip was built out of numbers that do not describe anything',
  });
}

// ---------------------------------------------------------------------------
describe('VS-4 — a fraction that does not add up is refused, not rendered', () => {
  test('two targets lost between the numerator and the denominator', () => {
    const refusal = refusalFrom([
      ruleCoverage({ eligible: 14, checked: 10, notChecked: 2 }),
    ]);
    assert.match(refusal.message, /layer-a\/no-unvalidated-constraint-violations/);
    assert.match(refusal.message, /10 checked and 2 not checked out of 14 eligible/);
    assert.match(refusal.message, /does not add up/);
  });

  test('a rule that accounted for more targets than it had', () => {
    const refusal = refusalFrom([
      ruleCoverage({ eligible: 14, checked: 14, notChecked: 3 }),
    ]);
    assert.match(refusal.message, /14 checked and 3 not checked out of 14 eligible/);
    assert.match(refusal.message, /does not add up/);
  });

  // The reader of a refusal is the person who has to fix it, and the fix here
  // is almost always the same one: a target the rule examined and let go got
  // filed as a hole. The message has to say which side it belongs on.
  test('the refusal names the rule it is about, and says where a let-go target goes', () => {
    const refusal = refusalFrom([
      ruleCoverage({ rule: 'layer-b/orphan-candidates', eligible: 9, checked: 4, notChecked: 2 }),
    ]);
    assert.match(refusal.message, /Rule layer-b\/orphan-candidates reports/);
    assert.match(refusal.message, /exactly one of the two paths/);
    assert.match(refusal.message, /is CHECKED/);
    assert.match(refusal.message, /restraint is work/);
    // It refuses rather than doing its best, and this is where that is
    // asserted: `refusalFrom` fails the test outright if a strip came back.
    assert.equal(refusal.name, 'ScopeStripRefused');
  });

  test('one rule that does not add up takes the whole strip down, not just its own row', () => {
    const refusal = refusalFrom([
      ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 12, notChecked: 2 }),
      ruleCoverage({ rule: 'layer-b/orphan-candidates', eligible: 27, checked: 20, notChecked: 3 }),
    ]);
    assert.match(refusal.message, /layer-b\/orphan-candidates/);
    assert.doesNotMatch(refusal.message, /layer-a\/constraints/);
  });

  test('numbers that add up produce a strip — and there is something in it to count', () => {
    const strip = buildScopeStrip(scope(), [
      ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 12, notChecked: 2 }),
      ruleCoverage({ rule: 'layer-a/indexes', eligible: 27, checked: 27, notChecked: 0 }),
    ]);

    // Anti-empty-pass. `0 + 0 === 0` is true of a strip that counted nothing,
    // and every equality below would hold on it while proving nothing at all.
    assert.ok(
      strip.targetsEligible !== null && strip.targetsEligible > 0,
      'this case has to have targets in it, or the rest of it is vacuous',
    );

    assert.equal(strip.targetsEligible, 41);
    assert.equal(strip.targetsChecked, 39);
    assert.equal(strip.targetsNotChecked, 2);
    assert.deepEqual(strip.rulesWithoutDenominator, []);
    assert.deepEqual(strip.rulesThatDidNotRun, []);
    assert.equal(strip.tablesVisible, 47);
    assert.equal(strip.tablesTotal, 52);
  });

  test('zero eligible is a real answer, and it still has to add up', () => {
    const strip = buildScopeStrip(scope(), [
      ruleCoverage({ eligible: 0, checked: 0, notChecked: 0 }),
    ]);
    assert.equal(strip.targetsEligible, 0);
    assert.deepEqual(strip.rulesWithoutDenominator, []);
  });
});

// ---------------------------------------------------------------------------
describe('VS-4 — a rule cannot say it did not run and also that it checked things', () => {
  test('did not run, and checked three targets — two sentences, and no way to tell which', () => {
    // The arithmetic is deliberately made to add up. Without that, the gate
    // in front of this one fires and the case goes green on the wrong
    // refusal, proving only that *something* threw.
    const refusal = refusalFrom([
      ruleCoverage({ ran: false, eligible: 5, checked: 3, notChecked: 2 }),
    ]);
    assert.match(refusal.message, /says it did not run/);
    assert.match(refusal.message, /it checked 3 targets/);
    assert.match(refusal.message, /no way to tell which/);
    assert.doesNotMatch(refusal.message, /does not add up/);
  });

  test('the same contradiction with no denominator, where the sum check never looks', () => {
    // `eligible: null` skips the arithmetic gate entirely, so this is the
    // only gate standing between the contradiction and the line.
    const refusal = refusalFrom([
      ruleCoverage({ ran: false, eligible: null, checked: 3, notChecked: 0 }),
    ]);
    assert.match(refusal.message, /says it did not run/);
    assert.match(refusal.message, /it checked 3 targets/);
  });

  test('a rule that did not run and checked nothing is legal, and gets named for it', () => {
    const strip = buildScopeStrip(scope(), [
      ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 14, notChecked: 0 }),
      ruleCoverage({
        rule: 'layer-b/orphan-candidates',
        ran: false,
        eligible: 9,
        checked: 0,
        notChecked: 9,
      }),
    ]);
    assert.ok(strip.targetsEligible !== null && strip.targetsEligible > 0);
    assert.deepEqual(strip.rulesThatDidNotRun, ['layer-b/orphan-candidates']);
    // Its targets are all on the hole side, which is the whole reason a rule
    // that did not run is allowed to appear on the strip at all.
    assert.equal(strip.targetsNotChecked, 9);
    assert.equal(strip.targetsChecked, 14);
  });
});

// ---------------------------------------------------------------------------
describe('VS-4 — one rule that cannot state a denominator takes the total with it', () => {
  /** Two rules that can say, one that cannot. 14 + 27 would be 41. */
  function mixed(): ScopeStrip {
    return buildScopeStrip(scope(), [
      ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 14, notChecked: 0 }),
      ruleCoverage({ rule: 'layer-a/indexes', eligible: 27, checked: 25, notChecked: 2 }),
      ruleCoverage({
        rule: 'layer-b/orphan-candidates',
        eligible: null,
        checked: 6,
        notChecked: 0,
      }),
    ]);
  }

  test('the total is null, not the sum of the rules that happened to know', () => {
    // 41 is not a smaller total. It is a different number wearing the same
    // name — the two-denominator defect, applied one level up.
    assert.equal(mixed().targetsEligible, null);
  });

  test('the rule that could not say is named, so the gap has an address', () => {
    assert.deepEqual(mixed().rulesWithoutDenominator, ['layer-b/orphan-candidates']);
  });

  test('two rules that cannot say are both named, not counted and dropped', () => {
    const strip = buildScopeStrip(scope(), [
      ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 14, notChecked: 0 }),
      ruleCoverage({ rule: 'layer-b/orphan-candidates', eligible: null, checked: 6, notChecked: 0 }),
      ruleCoverage({ rule: 'layer-b/enum-drift', eligible: null, checked: 3, notChecked: 0 }),
    ]);
    assert.equal(strip.targetsEligible, null);
    assert.deepEqual(strip.rulesWithoutDenominator, [
      'layer-b/orphan-candidates',
      'layer-b/enum-drift',
    ]);
  });

  test('losing the denominator does not lose the work that was done', () => {
    // 14 + 25 + 6 targets were examined whether or not anybody can say how
    // many there were to examine. Those two halves are known, and stay.
    const strip = mixed();
    assert.equal(strip.targetsChecked, 45);
    assert.equal(strip.targetsNotChecked, 2);
  });

  test('a rule with zero eligible is not a rule that could not say', () => {
    // Zero and unknown read identically in a total, which is exactly how a
    // rule that could not count itself disappears into a measured number.
    const strip = buildScopeStrip(scope(), [
      ruleCoverage({ rule: 'layer-a/constraints', eligible: 0, checked: 0, notChecked: 0 }),
      ruleCoverage({ rule: 'layer-a/indexes', eligible: 27, checked: 27, notChecked: 0 }),
    ]);
    assert.equal(strip.targetsEligible, 27);
    assert.deepEqual(strip.rulesWithoutDenominator, []);
  });
});

// ---------------------------------------------------------------------------
describe('VS-4 — the line spells out every hole instead of dropping it', () => {
  test('a fully known strip prints as exactly four parts, and nothing is missing', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [ruleCoverage({ eligible: 41, checked: 39, notChecked: 2 })]),
    );
    // Exact equality, because a part that quietly falls off the line is the
    // failure this line exists to make impossible, and a `match` would not
    // notice it going.
    assert.equal(
      line,
      [
        '47 of 52 tables visible',
        '41 targets eligible',
        '39 targets checked',
        '2 not checked',
      ].join(DOT),
    );
  });

  test('both units are named, so nobody subtracts 41 from 52', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [ruleCoverage({ eligible: 41, checked: 39, notChecked: 2 })]),
    );
    assert.match(line, /\btables\b/);
    assert.match(line, /\btargets\b/);
    assert.match(line, /47 of 52 tables visible/);
    assert.match(line, /41 targets eligible/);
  });

  test('an unknown table total is said out loud, never borrowed from what is visible', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope({ totalTables: null }), [ruleCoverage()]),
    );
    assert.match(line, /47 tables visible/);
    assert.match(line, /total unknown/);
    // The GREATEST(reltuples, 0) failure in this line's units: 47 quietly
    // becoming the denominator turns "nobody has said" into "we saw them all".
    assert.doesNotMatch(line, /of 47/);
    assert.doesNotMatch(line, /47 of/);
    assert.doesNotMatch(line, /all of them/);
  });

  test('an unknown eligible count does not simply drop off the line', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [
        ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 14, notChecked: 0 }),
        ruleCoverage({
          rule: 'layer-b/orphan-candidates',
          eligible: null,
          checked: 6,
          notChecked: 0,
        }),
      ]),
    );
    assert.match(line, /eligible unknown/);
    assert.match(line, /could not say/);
    // A number missing from the line leaves a strip that reads complete. 14
    // is what the rules that could say would have printed between them, and
    // it must not appear as though it were the denominator of anything.
    // No NUMBER of eligible targets — but the word `targets` has to stay.
    // Dropping the unit here left `20 checked` bare beside a count of
    // tables, and 20 below 47 reads as "20 of the 47 tables".
    assert.doesNotMatch(line, /\d+ targets eligible/);
    assert.match(line, /targets eligible unknown/);
    // The work is still on the line even though the denominator is not.
    assert.match(line, /20 targets checked/);
    assert.match(line, /0 not checked/);
  });

  test('one rule that could not say reads as one, not as "1 rules"', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [
        ruleCoverage({ rule: 'layer-b/orphan-candidates', eligible: null, checked: 6, notChecked: 0 }),
      ]),
    );
    assert.match(line, /\(1 rule could not say\)/);
  });

  test('two rules that could not say read as two', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [
        ruleCoverage({ rule: 'layer-b/orphan-candidates', eligible: null, checked: 6, notChecked: 0 }),
        ruleCoverage({ rule: 'layer-b/enum-drift', eligible: null, checked: 3, notChecked: 0 }),
      ]),
    );
    assert.match(line, /\(2 rules could not say\)/);
  });

  test('a rule that did not run is on the line, not only in the object', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [
        ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 14, notChecked: 0 }),
        ruleCoverage({
          rule: 'layer-b/orphan-candidates',
          ran: false,
          eligible: 9,
          checked: 0,
          notChecked: 9,
        }),
      ]),
    );
    assert.match(line, /1 rule did not run/);
  });

  test('two rules that did not run read as two', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [
        ruleCoverage({ rule: 'layer-a/constraints', ran: false, eligible: 14, checked: 0, notChecked: 14 }),
        ruleCoverage({ rule: 'layer-a/indexes', ran: false, eligible: 27, checked: 0, notChecked: 27 }),
      ]),
    );
    assert.match(line, /2 rules did not run/);
  });

  test('a strip where every rule ran does not append a clause about rules that did not', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [ruleCoverage({ eligible: 41, checked: 39, notChecked: 2 })]),
    );
    assert.doesNotMatch(line, /did not run/);
  });

  test('the fourth number is a hole, and the line does not dress it as a decision', () => {
    const line = scopeStripLine(
      buildScopeStrip(scope(), [ruleCoverage({ eligible: 41, checked: 39, notChecked: 2 })]),
    );
    assert.match(line, /2 not checked/);
    // The plan writes this column as "2 abstain". It is not an abstention:
    // merging targets a rule examined and let go with targets nobody reached
    // puts a result and a gap in one bucket under a label that argues with
    // the reason printed under it.
    assert.doesNotMatch(line, /abstain/i);
    assert.doesNotMatch(line, /skipped/i);
  });
});

// ---------------------------------------------------------------------------
// The shape gate. Every number above is only worth asserting because a number
// nobody parsed cannot get this far.
describe('VS-4 — numbers nobody checked do not reach the strip', () => {
  test('a negative count is refused, and the refusal says which rule it was', () => {
    const refusal = refusalFrom([
      ruleCoverage({ rule: 'layer-a/constraints', eligible: 14, checked: 14, notChecked: 0 }),
      ruleCoverage({ checked: -1 }),
    ]);
    assert.match(refusal.message, /Rule coverage #2 is not usable/);
    assert.match(refusal.message, /not assembled out of numbers nobody checked/);
  });

  test('minus one is not a way of saying "nobody has ever counted this"', () => {
    // reltuples returns -1 for a table nobody has analysed. A sentinel that
    // survives into an integer field becomes a measurement one line later.
    const refusal = refusalFrom([ruleCoverage({ eligible: -1, checked: 0, notChecked: 0 })]);
    assert.match(refusal.message, /Rule coverage #1 is not usable/);
  });

  test('half a target is not a unit', () => {
    const refusal = refusalFrom([ruleCoverage({ eligible: 14, checked: 11.5, notChecked: 2.5 })]);
    assert.match(refusal.message, /Rule coverage #1 is not usable/);
  });

  test('a rule with no name is refused — a gap nobody can address is not a gap anyone closes', () => {
    const refusal = refusalFrom([ruleCoverage({ rule: '', eligible: null, checked: 0, notChecked: 0 })]);
    assert.match(refusal.message, /Rule coverage #1 is not usable/);
  });

  test('a rule that does not say whether it ran is refused', () => {
    const draft = ruleCoverage();
    delete (draft as unknown as Record<string, unknown>).ran;
    const refusal = refusalFrom([draft]);
    assert.match(refusal.message, /Rule coverage #1 is not usable/);
  });

  test('an untyped source gets no discount', () => {
    // Nothing was compiled against these shapes on the way in. This is the
    // shape a stored run or a model hands back: plain JSON, and every number
    // in it as trustworthy as whoever wrote the file.
    const stored = JSON.parse(
      JSON.stringify({
        rule: 'layer-a/constraints',
        ran: true,
        eligible: 14,
        checked: 12,
        notChecked: 1,
      }),
    ) as RuleCoverage;

    const refusal = refusalFrom([stored]);
    assert.match(refusal.message, /12 checked and 1 not checked out of 14 eligible/);
  });
});

// ---------------------------------------------------------------------------
// the second door
//
// Everything above tests `buildScopeStrip`, which is the door a rule comes
// through. `ScopeStrip` is an ordinary object, so it is not the only way to
// hold one: a strip can arrive as JSON out of the history store, from a front
// end, or from a literal somebody typed in a hurry. Measured on the day this
// was written, `scopeStripLine` rendered all of those without meeting a single
// one of the arithmetic rules — `39 checked · 5 not checked` against `41
// eligible`, and `eligible unknown (0 rules could not say)`, which is two
// sentences arguing with each other on one line.
//
// `serializeEvidencePack` already had this shape: accept only what the gate
// produces, and re-run the whole check anyway. These are that.

describe('VS-4 — the line re-checks what it is handed', () => {
  /** A strip built by hand, the way one arrives from anywhere but the gate. */
  function strip(over: Partial<ScopeStrip> = {}): ScopeStrip {
    return {
      tablesVisible: 47,
      tablesTotal: 52,
      targetsEligible: 41,
      targetsChecked: 39,
      targetsNotChecked: 2,
      rulesWithoutDenominator: [],
      rulesThatDidNotRun: [],
      ...over,
    };
  }

  test('a strip that does not add up is refused rather than rendered', () => {
    assert.doesNotThrow(() => scopeStripLine(strip()));

    assert.throws(
      () => scopeStripLine(strip({ targetsNotChecked: 5 })),
      ScopeStripRefused,
      'a hand-built strip printed 39 + 5 against 41 eligible. The line is ' +
        'the one sentence a reader is told bounds every other sentence, so ' +
        'it does not render numbers nobody checked.',
    );
  });

  test('more tables visible than exist is refused here too', () => {
    assert.throws(
      () => scopeStripLine(strip({ tablesVisible: 60, tablesTotal: 52 })),
      /Both cannot be true/,
    );
  });

  test('an unknown total with nobody to blame for it is refused', () => {
    // The unknown has to have an address. `rulesWithoutDenominator` is where
    // a reader goes to find out which rule could not count itself, and an
    // unknown with an empty list is one nobody can chase.
    assert.throws(
      () => scopeStripLine(strip({ targetsEligible: null })),
      /names no rule/,
    );
  });

  test('a total that exists beside a rule that could not count is refused', () => {
    // The mirror, and the more dangerous direction: a number that looks
    // measured while one rule's targets are in none of it.
    assert.throws(
      () =>
        scopeStripLine(
          strip({ rulesWithoutDenominator: ['layer-b/undeclared-reference'] }),
        ),
      /the total is not one/,
    );
  });
});

// ---------------------------------------------------------------------------
describe('VS-4 — the manifest is checked, not trusted', () => {
  test('a scope claiming more visible than exist never reaches the strip', () => {
    // `assertScopeManifest` has existed and been tested since HS-C, refuses
    // exactly this pair, and had no caller. Measured before it was wired in
    // here: `60 of 52 tables visible` printed.
    assert.throws(
      () => buildScopeStrip(scope({ visibleTables: 60, totalTables: 52 }), []),
      /Both cannot be true/,
    );
  });

  test('a read-only promise made by software must say so, before any strip', () => {
    assert.throws(
      () =>
        buildScopeStrip(
          scope({ readOnlyEnforcedByDatabase: false, disclosure: null }),
          [],
        ),
      /disclosure/,
    );
  });
});
