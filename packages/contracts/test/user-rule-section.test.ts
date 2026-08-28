/**
 * The third section, and the property that let it exist at all — VS-6.
 *
 * VS-7 put this report in front of five people and four read it correctly.
 * The Licensor ended that measurement on 2026-08-24, so a change to the layout
 * it measured can never be re-measured. The first test below is the one that
 * makes a new section payable: it does not appear unless somebody typed a
 * rule, and until VS-6 ships nobody has.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGS } from '../src/i18n.js';
import { coverageOf } from '../src/findings.js';
import { sealFindings } from '../src/seal.js';
import type { FindingDraft } from '../src/seal.js';
import { buildUserRuleSection, isUserRule } from '../src/user-rule-section.js';

/** A draft in the shape `rule-runner` produces, minus the database. */
function draft(over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    id: 'user/is-never-repeated/public.users.email',
    rule: 'user/is-never-repeated',
    kind: 'observation',
    confidence: 'probable',
    origin: 'user_declared',
    confidenceBasis: 'user_statement',
    severity: 'info',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-25T00:00:00.000Z',
    engineRuleVersion: 'user-rules@1.0.0',
    schema: 'public',
    table: 'users',
    columns: ['email'],
    plainText: '12 of the 900 rows in public.users do not match the rule you described.',
    technical: 'is-never-repeated on public.users.email: 12 of 900 rows',
    // N50: on every kind now, including this observation. The section's own
    // rule about REPEATING it is what the tests below measure.
    boundary: 'I checked the rule exactly as it was read back to you.',
    evidence: { sql: 'SELECT 1', rowCount: 12, sampleSize: null, durationMs: 1, sample: [] },
    // `coverageOf`, not a literal: the four fields debt N1 added are
    // nullable on purpose, and writing them out here by hand is how a test
    // fixture drifts from the shape the product actually builds.
    coverage: coverageOf(1, 1),
    ...over,
  } as FindingDraft;
}

/** A Layer A finding, to prove the filter is not "everything in the list". */
function layerA(): FindingDraft {
  return draft({
    id: 'layer-a/fk-orphans/public.votes.x',
    rule: 'layer-a/unvalidated-foreign-key-has-orphans',
    confidence: 'certain',
    origin: 'counted',
    confidenceBasis: 'full_count',
    severity: 'high',
    engineRuleVersion: 'layer-a@1.0.0',
    plainText: '3 rows in votes point at a post that is not there.',
  });
}

describe('the section that only exists when somebody asked for it', () => {
  it('🟥 returns null when no rule was the user\'s — the report VS-7 measured is unchanged', () => {
    // The load-bearing test in this file. Every scan today produces exactly
    // this case, because nothing calls `runRule` yet: no heading, no
    // preamble, no blank line. If this ever returns a section for a scan
    // with no user rules, a layout measured on five real readers has been
    // altered by a feature none of them saw.
    const only = sealFindings([layerA()], 'test');
    assert.equal(buildUserRuleSection(only, 'en'), null);
    assert.equal(buildUserRuleSection([], 'en'), null);
  });

  it('keeps a user rule out of the Layer A pile and vice versa', () => {
    const mixed = sealFindings([layerA(), draft()], 'test');
    assert.equal(mixed.filter(isUserRule).length, 1);
    const section = buildUserRuleSection(mixed, 'en');
    assert.equal(section?.entries.length, 1);
    assert.match(section!.entries[0]!.plain, /the rule you described/);
  });

  it('decides membership on origin, not on the rule id', () => {
    // A rule id is a string a future pack could collide with. `user_declared`
    // is a closed vocabulary value the seal already checks, and
    // BASIS_FOR_ORIGIN ties it to `user_statement`.
    const disguised = sealFindings(
      [draft({ rule: 'layer-a/unvalidated-foreign-key-has-orphans' })],
      'test',
    );
    assert.equal(buildUserRuleSection(disguised, 'en')?.entries.length, 1);
  });

  it('says whose rule it is in the heading, in both languages', () => {
    const findings = sealFindings([draft()], 'test');
    for (const lang of LANGS) {
      const section = buildUserRuleSection(findings, lang)!;
      assert.ok(section.heading.length > 5);
      assert.match(section.heading, lang === 'en' ? /YOU ASKED/ : /BẠN BẢO/);
    }
  });

  it('carries the caveat ㉔ and ㉕ measured, once, above the entries', () => {
    // Once. VS-7 found what per-finding repetition costs: "an empty table is
    // not a clean one" printed three times in sixty lines and stopped being
    // read. Two findings, one preamble.
    const findings = sealFindings([draft(), draft({ id: 'user/x/y', table: 'posts' })], 'test');
    const section = buildUserRuleSection(findings, 'en')!;
    assert.equal(section.entries.length, 2);
    assert.match(section.preamble, /not whether that is the rule you meant/);
    for (const e of section.entries) {
      assert.doesNotMatch(e.plain, /the rule you meant/);
    }
  });

  it('🟥 drops a boundary every entry shares, and keeps one that differs', () => {
    // The rule this replaces was "a boundary only for the kinds the contract
    // gives one to", and N50 gave one to all five — so that rule now means
    // "print it on every entry", which is the repetition VS-7 measured as
    // fatal: every user rule carries the SAME sentence, and the preamble above
    // already says it once.
    //
    // The rule is about repetition rather than about claim kind, and the
    // difference is the case below: a rule with a limit of its OWN to disclose
    // is exactly what the old shape would have hidden, because it hid by kind.
    const shared = sealFindings(
      [draft(), draft({ id: 'user/x/y', table: 'posts' })],
      'test',
    );
    for (const e of buildUserRuleSection(shared, 'en')!.entries) {
      assert.equal(
        e.boundary,
        null,
        'both rules carry the identical boundary, and the preamble already ' +
          'states it — printing it twice more is the repetition VS-7 measured',
      );
    }

    const differing = sealFindings(
      [
        draft(),
        draft({
          id: 'user/x/y',
          table: 'posts',
          boundary:
            'I could only read 40 of the 900 rows in public.posts; the rest ' +
            'are not visible to this account.',
        }),
      ],
      'test',
    );
    const entries = buildUserRuleSection(differing, 'en')!.entries;
    assert.ok(
      entries.every((e) => e.boundary !== null),
      'one rule had something of its own to disclose and the section swallowed ' +
        'it — suppression is for a sentence they SHARE, never for a kind',
    );
    assert.notEqual(entries[0]!.boundary, entries[1]!.boundary);
  });

  it('a lone entry keeps its boundary — there is nothing for it to repeat', () => {
    // The edge the suppression rule has to get right. One entry cannot repeat
    // anything, so "they all share it" is not a reason to drop it, and the
    // preamble is not a substitute for a sentence about the only rule shown.
    const one = sealFindings([draft()], 'test');
    assert.ok(
      buildUserRuleSection(one, 'en')!.entries[0]!.boundary,
      'the only entry in the section lost the limit of its own measurement',
    );
  });
});
