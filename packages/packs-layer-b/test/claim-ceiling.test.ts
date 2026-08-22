/**
 * Layer B cannot speak with certainty, and now it is structure that says so.
 *
 * WHY THIS FILE EXISTS
 *
 * AGENTS.md section 3 rule 3 says Layer A states facts and Layer B may only
 * raise a question. Until today the only thing enforcing that on a live path
 * was `assertClaimDiscipline`, which reads the two prose fields of an
 * `unconfirmed` finding and looks for "bug", "error", "wrong" and four other
 * words. That is a blacklist over English, and the lesson this repo already
 * paid for once is that a blacklist is empty exactly where nobody thought to
 * look: a name has no shape to detect, and neither does a confident sentence
 * written politely.
 *
 * The sentence below is polite. It contains none of the seven words. Before
 * the provenance fields existed, Layer B could publish it with
 * `confidence: 'certain'` and every gate in the product would have waved it
 * through — a guess about two similarly named columns, presented to somebody
 * who cannot read SQL as a fact, in a report whose credibility is the entire
 * product.
 *
 * What refuses it now is `provenanceProblem` in `packages/contracts/src/seal.ts`,
 * and it refuses on structure rather than on wording:
 *
 *   BASIS_FOR_ORIGIN   `name_pattern` may only rest on `name_similarity`;
 *                      relabelling the basis to buy a higher ceiling is
 *                      caught as two halves of one sentence disagreeing.
 *   CEILING            `name_similarity` supports at most `unconfirmed`.
 *
 * HOW THIS SUITE AVOIDS PROVING NOTHING
 *
 * Three things could make a refusal here meaningless, and each is closed:
 *
 *   1. The draft might be refused for some unrelated defect — a missing
 *      field, an impossible coverage fraction — and read as the ceiling
 *      working. So the *same draft* is sealed successfully at `unconfirmed`
 *      first. Anything the shape and coverage gates would object to is
 *      already objected to there.
 *   2. The refusal might come from the old word blacklist instead. That gate
 *      only runs on `unconfirmed` claims, so a clean seal at `unconfirmed` is
 *      itself the proof that the prose passes it — and no copy of the word
 *      list is kept here, which is the mistake that let three redactors drift
 *      apart. The blacklist is separately shown to be alive by putting one of
 *      its words into the same draft and watching a *different* refusal.
 *   3. The ceiling might be a blanket "Layer B is never certain" rather than
 *      a table consulted per basis, in which case it would not be measuring
 *      provenance at all. So the same draft is also run with a sampled
 *      origin, where the ceiling really is higher, and `probable` is accepted.
 *
 * No database. This is a law about what may be said, not about what is in
 * anyone's data. The claim that the *live* pack declares this provenance is
 * a separate matter and is pinned in `layer-b.regression.test.ts` against
 * real Pagila findings — if `implicit-fk.ts` ever stops writing
 * `name_pattern`, that suite goes red, not this one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ClaimRefused, sealFinding, type FindingDraft } from '@ledar/contracts';
import { IMPLICIT_FK_RULE, LAYER_B_RULE_VERSION } from '@ledar/packs-layer-b';

const PRODUCER = 'layer-b';

/**
 * A Layer B finding as `runImplicitForeignKeys` builds one, in prose that
 * gives the word blacklist nothing to catch.
 *
 * Every sentence here is the kind a careful engineer would write while
 * meaning to be helpful. It reports a real measurement, it names no defect,
 * and it reads as completely reasonable — which is the point. The reason it
 * must not be publishable as `certain` is not that it is impolite. It is
 * that the reason to believe the column is a reference at all is that two
 * names look alike.
 */
function draft(over: Partial<FindingDraft> = {}): FindingDraft {
  return {
    id: 'layer-b/implicit-fk/public.damaged_invoice.customer_id',
    rule: IMPLICIT_FK_RULE,
    kind: 'inference',
    confidence: 'unconfirmed',
    severity: 'medium',

    origin: 'name_pattern',
    confidenceBasis: 'name_similarity',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-21T09:15:00.000Z',
    engineRuleVersion: LAYER_B_RULE_VERSION,

    schema: 'public',
    table: 'damaged_invoice',
    columns: ['customer_id'],

    plainText:
      '5 of the 25 rows in damaged_invoice carry a customer_id that no ' +
      'customer record matches. The other 80% match, so the column does look ' +
      'like it points at customer. Nothing in the database enforces that, so ' +
      'I cannot tell whether those 5 are leftovers you would want to know ' +
      'about, or rows kept deliberately.',
    technical:
      'public.damaged_invoice.customer_id (20 distinct values over 25 sampled ' +
      'non-null rows) matches public.customer.customer_id at 80.0%, with 5 ' +
      'unmatched (20.0%). No foreign key is declared between them.',

    evidence: {
      sql: 'SELECT count(*) FROM public.damaged_invoice c LEFT JOIN public.customer p ON p.customer_id = c.customer_id',
      rowCount: 5,
      sampleSize: 25,
      durationMs: 4,
      sample: [],
    },
    coverage: { checked: 1, eligible: 1, skipped: [], truncatedAt: null },

    ...over,
  } as FindingDraft;
}

/** Seals and hands back the refusal, insisting it is the gate's own error. */
function refusalFor(d: FindingDraft): ClaimRefused {
  try {
    sealFinding(d, PRODUCER);
  } catch (err) {
    assert.ok(
      err instanceof ClaimRefused,
      `the gate threw a ${err instanceof Error ? err.constructor.name : typeof err} ` +
        `rather than a ClaimRefused: ${err instanceof Error ? err.message : String(err)}. ` +
        `A TypeError here would mean this draft never reached the provenance ` +
        `rules at all, and the assertions below would be reading the wrong ` +
        `failure.`,
    );
    return err as ClaimRefused;
  }

  assert.fail(
    `sealFindings published this draft. It carries confidence ` +
      `"${d.confidence}" on basis "${d.confidenceBasis}", which is more than ` +
      `that basis can support, and the gate let it through.`,
  );
}

describe('the seal gate refuses a Layer B claim that speaks with certainty', () => {
  /**
   * The baseline every refusal below is measured against.
   *
   * Without this, a red test proves only that *something* about the draft is
   * unacceptable. With it, the draft is known to satisfy the shape rules, the
   * coverage arithmetic, and the word blacklist — so the one thing changed
   * afterwards is the one thing being tested.
   */
  it('publishes the very same claim, word for word, at `unconfirmed`', () => {
    const sealed = sealFinding(draft(), PRODUCER);

    assert.equal(sealed.confidence, 'unconfirmed');
    assert.equal(sealed.origin, 'name_pattern');
    assert.equal(sealed.confidenceBasis, 'name_similarity');

    // Nobody has ruled on it, and the field says so rather than leaving the
    // reader to assume. This is the default arriving through the schema.
    assert.equal(sealed.userStatus, 'unreviewed');
  });

  it('refuses the same claim at `certain`, on structure rather than wording', () => {
    const refused = refusalFor(draft({ confidence: 'certain' }));

    assert.equal(refused.producer, PRODUCER);
    assert.equal(
      refused.findingId,
      'layer-b/implicit-fk/public.damaged_invoice.customer_id',
    );

    // The problem line has to name both halves. "This finding is not
    // acceptable" tells the rule author nothing about which of the two to
    // change, and the whole design of these messages is that the person
    // reading the refusal is the person who has to fix it.
    assert.match(refused.message, /confidence `certain` on `name_similarity`/);
    assert.match(refused.message, /`name_similarity` supports at most `unconfirmed`/);

    // And it has to say where the rule comes from. A refusal that reads as a
    // validation quirk gets worked around; one that cites the rule gets
    // argued with, which is the outcome worth having.
    assert.match(refused.message, /AGENTS\.md §3 ③/);

    // The refusal is NOT the word blacklist. That gate reports "says
    // <word>", it only runs on unconfirmed claims, and this draft is
    // certain — so its absence here is what makes this a structural refusal.
    assert.ok(
      !/is unconfirmed but says/.test(refused.message),
      `the refusal came from the prose gate, not the provenance gate:\n` +
        refused.message,
    );
  });

  it('refuses `probable` too — the ceiling is `unconfirmed`, not "anything below certain"', () => {
    const refused = refusalFor(draft({ confidence: 'probable' }));
    assert.match(refused.message, /confidence `probable` on `name_similarity`/);
  });

  /**
   * The escape hatch, closed.
   *
   * A ceiling on the basis alone would be trivially defeated: an author who
   * wants to say `certain` writes `confidenceBasis: 'full_count'` and keeps
   * everything else. The pairing table is what makes that a contradiction
   * somebody else can see rather than a field somebody quietly changed.
   */
  it('refuses a basis relabelled to buy a higher ceiling', () => {
    const refused = refusalFor(
      draft({ confidence: 'certain', confidenceBasis: 'full_count' }),
    );

    assert.match(refused.message, /origin `name_pattern` with confidenceBasis `full_count`/);
    assert.match(refused.message, /rests on `name_similarity`/);
  });

  /**
   * The other half of the same escape hatch.
   *
   * Relabelling the *origin* instead makes the halves agree again, so the
   * pairing table has nothing to object to — and this is exactly the swap the
   * brief for this change warned about. It is caught one rule later: a
   * sampled origin buys `probable`, and no origin available to this rule buys
   * `certain`.
   */
  it('refuses `certain` even with origin and basis both moved to sampled', () => {
    const refused = refusalFor(
      draft({
        confidence: 'certain',
        origin: 'sampled',
        confidenceBasis: 'sample_extrapolation',
      }),
    );

    assert.match(refused.message, /confidence `certain` on `sample_extrapolation`/);
    assert.match(refused.message, /`sample_extrapolation` supports at most `probable`/);
  });

  /**
   * The proof that the ceiling is a table and not a blanket ban.
   *
   * This is the assertion that keeps the four refusals above from being
   * vacuous. If `CEILING` were ignored — or if the gate simply refused
   * anything above `unconfirmed` from any producer named layer-b — this would
   * be refused as well, and every test in this file would still be green
   * while measuring nothing about provenance.
   *
   * It is also the mutation the brief demanded, written down rather than
   * performed by hand once: declaring a sampled origin really does raise what
   * a claim may assert, which is precisely why Layer B must not declare one.
   * Its uncertainty is not in the sampling.
   */
  it('accepts `probable` once the origin really is a sample', () => {
    const sealed = sealFinding(
      draft({
        confidence: 'probable',
        origin: 'sampled',
        confidenceBasis: 'sample_extrapolation',
      }),
      PRODUCER,
    );

    assert.equal(sealed.confidence, 'probable');
    assert.equal(sealed.confidenceBasis, 'sample_extrapolation');
  });

  /**
   * The old gate, shown to be alive and shown to be a different gate.
   *
   * Not a copy of its word list — one word, dropped into the same draft. If
   * this stops being refused, the prose gate has gone quiet and the note at
   * the top of this file about it being the *only* previous defence is no
   * longer describing the product.
   */
  it('still refuses defect words in an unconfirmed claim, by a different rule', () => {
    const refused = refusalFor(
      draft({
        plainText:
          '5 of the 25 rows in damaged_invoice carry a customer_id that is ' +
          'an error, because no customer record matches it.',
      }),
    );

    assert.match(refused.message, /is unconfirmed but says "error"/);
    assert.match(refused.message, /not a defect until the person who owns the/);

    // And it is not the provenance gate: that one never ran, because the
    // prose gate throws first. Two independent defences, in that order.
    assert.ok(
      !/supports at most/.test(refused.message),
      `the provenance ceiling answered a prose problem:\n${refused.message}`,
    );
  });

  /**
   * A stamp that is not a time is not a measurement.
   *
   * Cheap to state and easy to lose: `observedAt` is a string in the schema,
   * so `'yesterday'`, `'unknown'`, or a build-time placeholder all satisfy
   * the type. Only this rule tells them apart from an instant.
   */
  it('refuses a claim whose observedAt is not an instant', () => {
    const refused = refusalFor(draft({ observedAt: 'during the scan' }));
    assert.match(refused.message, /observedAt is not a timestamp: during the scan/);
  });
});
