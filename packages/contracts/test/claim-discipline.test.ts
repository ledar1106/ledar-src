/**
 * HS-F F.12 — a Layer B claim may not call an unconfirmed pattern a defect.
 *
 * This is hard rule ③ of AGENTS.md §3, and it is the rule the whole product
 * rests on: Layer A reads constraints the database itself declared and may
 * speak plainly; Layer B reads a shape in the data and is guessing. The
 * difference has to survive contact with prose, because prose is the only
 * part the reader actually reads.
 *
 * ## What these were written to catch
 *
 * The gate existed and its condition was `confidence === 'unconfirmed'`. The
 * rule it implements is *not yet confirmed*, which is broader:
 * `sample_extrapolation` has a ceiling of `probable` (CEILING in seal.ts), so
 * a Layer B rule reading sampled rows may legitimately publish a `probable`
 * claim — and the ban stopped applying to it, silently.
 *
 * Nothing emits `probable` today. Measured, not assumed: every Layer B
 * finding in the recorded scan history is `unconfirmed`, and
 * `implicit-fk.ts` sets it literally. So this was a hole nobody had walked
 * into yet, which is the only kind that is still open when somebody does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sealFinding } from '../src/index.js';
import { coverageOf } from '@ledar/contracts';

const LAYER_B = {
  id: 'layer-b/implicit-fk/public.orders.customer_id',
  rule: 'layer-b/undeclared-reference-with-unmatched-values',
  kind: 'inference' as const,
  severity: 'medium' as const,
  origin: 'sampled' as const,
  confidenceBasis: 'sample_extrapolation' as const,
  egressClass: 'customer-system-metadata' as const,
  observedAt: '2026-08-22T00:00:00.000Z',
  engineRuleVersion: 'layer-b@2.1.0',
  userStatus: 'unreviewed' as const,
  schema: 'public',
  table: 'orders',
  columns: ['customer_id'],
  technical: '5 of 25 values match no customers row.',
  evidence: { sql: 'SELECT 1', rowCount: 5, sampleSize: 25, durationMs: 1, sample: [] },
  coverage: coverageOf(1, 1),
};

function refusalFor(draft: unknown): Error {
  try {
    sealFinding(draft, 'claim-discipline.test');
  } catch (err) {
    return err as Error;
  }
  throw new Error('the gate let it through, and this test needs a refusal');
}

describe('the words a Layer B claim may not use', () => {
  it('lets an ordinary hedged sentence through', () => {
    // The control. Without it every assertion below could be passing because
    // the draft is malformed rather than because the words were caught — which
    // is exactly what happened while these tests were being written.
    sealFinding(
      { ...LAYER_B, confidence: 'unconfirmed', plainText: '5 of 25 rows point at no customers record.' },
      'claim-discipline.test',
    );
  });

  for (const word of ['bug', 'broken', 'error', 'wrong', 'invalid', 'corrupt', 'failure']) {
    it(`refuses "${word}" in an unconfirmed claim`, () => {
      const refused = refusalFor({
        ...LAYER_B,
        confidence: 'unconfirmed',
        plainText: `The customer_id column is ${word}.`,
      });
      assert.match(refused.message, new RegExp(`says "${word}"`, 'i'));
    });
  }

  it('🟥 refuses them in a PROBABLE claim too — the gap this closed', () => {
    // `sample_extrapolation` permits `probable`, so this draft is entirely
    // legitimate apart from the word. Before the condition was widened this
    // sealed cleanly and shipped the sentence.
    const refused = refusalFor({
      ...LAYER_B,
      confidence: 'probable',
      plainText: 'These 5 rows are wrong.',
    });
    assert.match(refused.message, /says "wrong"/);
    assert.match(refused.message, /not confirmed/);
  });

  it('names the confidence it actually saw, rather than saying "unconfirmed"', () => {
    // The old message read "is unconfirmed but says …" on every refusal. Once
    // the gate covers `probable`, that sentence is simply false half the time,
    // and a refusal that misdescribes the claim is one the author argues with
    // instead of fixing.
    const refused = refusalFor({
      ...LAYER_B,
      confidence: 'probable',
      plainText: 'This is a bug.',
    });
    assert.match(refused.message, /`probable`/);
    assert.doesNotMatch(refused.message, /is unconfirmed but says/);
  });

  it('reads `technical` as well as `plainText`', () => {
    // Both reach a human. Guarding only the plain-language field would move
    // the sentence rather than stop it.
    const refused = refusalFor({
      ...LAYER_B,
      confidence: 'unconfirmed',
      plainText: '5 of 25 rows point at no customers record.',
      technical: 'customer_id is invalid for 5 rows',
    });
    assert.match(refused.message, /says "invalid"/);
  });
});

describe('who is allowed to use them', () => {
  it('allows a `certain` claim — Layer A reads what the database declared', () => {
    sealFinding(
      {
        ...LAYER_B,
        id: 'layer-a/fk-orphans/public.orders.fk',
        rule: 'layer-a/unvalidated-foreign-key-has-orphans',
        kind: 'observation',
        confidence: 'certain',
        origin: 'counted',
        confidenceBasis: 'full_count',
        plainText: '5 rows break the foreign key the database was told to keep.',
        technical: 'orders_customer_id_fkey is NOT VALID and has 5 orphans',
      },
      'claim-discipline.test',
    );
  });

  it('allows the words once the owner has confirmed the finding', () => {
    // The rule is "not until the person who owns the system says it was not
    // intended". They have. At that point it IS a defect, and refusing the
    // word would be the gate arguing with the only person entitled to decide.
    sealFinding(
      {
        ...LAYER_B,
        confidence: 'unconfirmed',
        userStatus: 'confirmed',
        plainText: 'Confirmed by the owner: these 5 rows are broken links.',
      },
      'claim-discipline.test',
    );
  });

  it('does NOT allow them merely because the owner looked and moved on', () => {
    // `rejected` and `intentional` are rulings too, and both mean the opposite
    // of "yes, it is a defect". Only `confirmed` opens the words.
    for (const userStatus of ['unreviewed', 'rejected', 'intentional'] as const) {
      const refused = refusalFor({
        ...LAYER_B,
        confidence: 'unconfirmed',
        userStatus,
        plainText: 'These rows are broken.',
      });
      assert.match(refused.message, /says "broken"/, `userStatus ${userStatus} let it through`);
    }
  });
});
