/**
 * The cost table, and the rows it must refuse — HS-D D.4.
 *
 * Written before anything can call a model, so there is no behaviour to
 * regression-test yet. What there is instead is a set of rows that would each
 * read as a measurement without being one, and this file exists to prove the
 * DDL turns every one of them away.
 *
 * ## The one that matters most
 *
 * `cost_micros` with no `price_basis`. A cost is derived from a price list and
 * price lists change; a stored cost with nothing saying which prices produced
 * it cannot be re-derived, checked, or corrected — and it will be read later
 * as though it were measured. The tokens are measured. The cost is arithmetic
 * done on top of them with an input nobody wrote down.
 *
 * This is the same failure as a message that explains itself with a reason
 * that has expired (`AGENTS.md` §4.9 ③), and it is worse here, because a
 * sentence is at least obviously prose and a number looks like a fact.
 *
 * ## Why the CHECKs are in the DDL and asserted from outside
 *
 * A validate() in `recordLlmCall` would be skipped by the second writer of
 * this store — a repair script, an import tool, somebody with the sqlite3 CLI
 * at 2am. These assertions go through the public method, but what they are
 * proving is that SQLite refuses, which is true for every writer there is.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ScanStore } from '../src/store.js';
import type { LlmCallInput } from '../src/types.js';

/** The smallest row that is allowed to exist. */
const OK: LlmCallInput = {
  runId: null,
  tier: 'balanced',
  model: 'some-model-v1',
  outcome: 'ok',
  cacheHit: false,
  promptTokens: 1200,
  completionTokens: 300,
  costMicros: 4125,
  priceBasis: 'price-list-2026-08',
  note: null,
};

const store = () => ScanStore.memory();

describe('recording what a model cost', () => {
  it('keeps every field it was given', () => {
    const s = store();
    const id = s.recordLlmCall(OK);
    const [row] = s.everyLlmCall();

    assert.ok(row);
    assert.equal(row.id, id);
    assert.equal(row.tier, 'balanced');
    assert.equal(row.model, 'some-model-v1');
    assert.equal(row.outcome, 'ok');
    assert.equal(row.cacheHit, false);
    assert.equal(row.promptTokens, 1200);
    assert.equal(row.completionTokens, 300);
    assert.equal(row.costMicros, 4125);
    assert.equal(row.priceBasis, 'price-list-2026-08');
    s.close();
  });

  it('records a call that belonged to no scan at all', () => {
    // Onboarding asks before there is anything to scan. A cost record that
    // could only exist inside a run would quietly omit the earliest calls,
    // which are the ones somebody hunting a surprise bill looks for first.
    const s = store();
    s.recordLlmCall({ ...OK, runId: null });
    assert.equal(s.everyLlmCall().length, 1);
    assert.equal(s.everyLlmCall()[0]?.runId, null);
    s.close();
  });

  it('does not let an absent count come back as zero', () => {
    // The distinction the whole product turns on, applied to tokens: null is
    // "there is nothing to count", 0 is "nothing was sent and we know why".
    const s = store();
    s.recordLlmCall({
      ...OK,
      outcome: 'refused',
      promptTokens: null,
      completionTokens: null,
      costMicros: null,
      priceBasis: null,
      note: 'a block was classed never-leaves',
    });
    const [row] = s.everyLlmCall();
    assert.equal(row?.promptTokens, null, 'an absent count came back as a number');
    assert.equal(row?.costMicros, null);
    s.close();
  });
});

describe('rows the history refuses', () => {
  it('refuses a cost with no price list behind it', () => {
    // The assertion this file exists for.
    const s = store();
    assert.throws(
      () => s.recordLlmCall({ ...OK, costMicros: 4125, priceBasis: null }),
      /CHECK|constraint/i,
      'a cost was stored that nobody can re-derive',
    );
    s.close();
  });

  it('allows a cost that is genuinely absent', () => {
    // The other side of the same rule: not knowing is a fine thing to record.
    // Only claiming to know without saying how is refused.
    const s = store();
    s.recordLlmCall({ ...OK, costMicros: null, priceBasis: null });
    assert.equal(s.everyLlmCall()[0]?.costMicros, null);
    s.close();
  });

  it('refuses tokens on a call that was never sent', () => {
    const s = store();
    assert.throws(
      () =>
        s.recordLlmCall({
          ...OK,
          outcome: 'refused',
          note: 'declined at the boundary',
          promptTokens: 900,
        }),
      /CHECK|constraint/i,
      'it counted tokens for something that did not happen',
    );
    s.close();
  });

  it('refuses a cache hit that somehow failed', () => {
    // A cache hit contacted nobody, so there was nothing to fail.
    const s = store();
    assert.throws(
      () =>
        s.recordLlmCall({
          ...OK,
          cacheHit: true,
          outcome: 'failed',
          note: 'timeout',
        }),
      /CHECK|constraint/i,
    );
    s.close();
  });

  it('refuses a failure that does not say why', () => {
    // The one thing this product may not do is decline to act and not say
    // what it declined or why.
    const s = store();
    for (const note of [null, '']) {
      assert.throws(
        () => s.recordLlmCall({ ...OK, outcome: 'failed', note }),
        /CHECK|constraint/i,
        `outcome 'failed' with note ${JSON.stringify(note)} was accepted`,
      );
    }
    s.close();
  });

  it('refuses an outcome outside the vocabulary', () => {
    const s = store();
    assert.throws(
      () =>
        s.recordLlmCall({
          ...OK,
          outcome: 'probably-fine' as never,
          note: 'x',
        }),
      /CHECK|constraint/i,
    );
    s.close();
  });

  it('refuses a negative count', () => {
    const s = store();
    assert.throws(
      () => s.recordLlmCall({ ...OK, promptTokens: -1 }),
      /CHECK|constraint/i,
    );
    s.close();
  });
});

describe('reading the calls back', () => {
  it('separates one run from another, and from the runless ones', () => {
    const s = store();
    const runId = s.openRun({
      database: { host: 'h', port: 5432, database: 'd' },
      scope: {
        database: 'd',
        role: 'r',
        schemas: ['public'],
        visibleTables: 1,
        totalTables: 1,
        grantedAt: null,
        readOnlyEnforcedByDatabase: true,
        disclosure: null,
      },
    });

    s.recordLlmCall({ ...OK, runId });
    s.recordLlmCall({ ...OK, runId });
    s.recordLlmCall({ ...OK, runId: null });

    assert.equal(s.llmCallsOf(runId).length, 2);
    assert.equal(s.everyLlmCall().length, 3, 'the runless call went missing');
    s.close();
  });
});
