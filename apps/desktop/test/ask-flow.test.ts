/**
 * The pure parts of S6's main-process side.
 *
 * What is testable here is what does not need a database or a model: the
 * sentence a person reads when a walk could not run. It matters because that
 * sentence appeared on a real screen, in a real window, reading badly — and
 * the two faults in it are exactly the kind a suite can hold still.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { modelConfig, readableDbError, readerSentenceFor } from '../src/main/ask-flow.js';

describe('the database refused, and a person has to read why', () => {
  it("🟥 strips the aliases this product invented, not the database's words", () => {
    // `walkRoute` numbers joined tables `t0`, `t1`… so `t0.customer_id` is
    // OUR noise inside Postgres's sentence. It went to a real screen once.
    const said = readableDbError(new Error('column t0.customer_id does not exist'));
    assert.equal(said.includes('t0.'), false);
    assert.match(said, /column customer_id does not exist/);
    // And the database's own wording survives. Paraphrasing would put this
    // product's guess where an authority's answer was.
    assert.match(said, /does not exist/);
  });

  it('handles more than one alias in one sentence', () => {
    const said = readableDbError(new Error('t0.a and t12.b cannot be compared'));
    assert.equal(said.includes('t0.'), false);
    assert.equal(said.includes('t12.'), false);
    assert.match(said, /^a and b cannot be compared\./);
  });

  it('🟥 ends the sentence, because Postgres does not', () => {
    // On screen: "…does not exist Nothing was counted…" — two sentences run
    // together, because this text is embedded in one of ours.
    assert.match(readableDbError(new Error('relation "x" does not exist')), /exist\.$/);
  });

  it('leaves a sentence that already ends alone', () => {
    assert.equal(readableDbError(new Error('it broke.')), 'it broke.');
    assert.equal(readableDbError(new Error('what?')), 'what?');
  });

  it('says something when the error says nothing', () => {
    // A blank message would leave the reader's sentence with a hole in the
    // middle of it.
    assert.match(readableDbError(new Error('')), /refused the query/);
    assert.match(readableDbError(undefined), /undefined/);
  });

  it('does not strip a column that merely starts with a t', () => {
    // `\bt\d+\.` and not `t.*\.`: `total.amount` is somebody's real column.
    assert.match(readableDbError(new Error('column total.amount is ambiguous')), /total\.amount/);
  });
});

describe('the tier name is written twice, and the two must agree', () => {
  it('🟥 matches infra/ai-tiers.json, or says why it could not look', () => {
    // `ask-flow.ts` writes the model name out because the packaged desktop has
    // no `infra/` beside it. That is a second copy of a value, which is debt
    // N57's exact shape — taken deliberately and narrowly, and only tolerable
    // if something notices when the two drift.
    //
    // 🟥 This test exists because a COMMENT claimed it did. The comment said
    // "ask-flow.test.ts asserts the two agree" while no such assertion had
    // been written: a claim about a check, standing in for the check.
    const here = dirname(fileURLToPath(import.meta.url));
    const tiers = resolve(here, '../../../infra/ai-tiers.json');
    if (!existsSync(tiers)) {
      // The public tree does not carry `infra/`. Skipping is honest; asserting
      // against a file that is not there would fail for the wrong reason.
      assert.ok(true, 'infra/ai-tiers.json is not in this tree');
      return;
    }
    const shipped = JSON.parse(readFileSync(tiers, 'utf8')) as {
      tiers: Record<string, { model: string }>;
    };
    process.env['AI_BASE_URL'] = 'https://example.invalid/v1';
    process.env['AI_API_KEY'] = 'not-a-real-key';
    try {
      const config = modelConfig();
      assert.notEqual(config, null);
      assert.equal(config?.tiers['rules']?.model, shipped.tiers['rules']?.model);
    } finally {
      delete process.env['AI_BASE_URL'];
      delete process.env['AI_API_KEY'];
    }
  });

  it('🟥 no key is null, and null is a state rather than a throw', () => {
    const base = process.env['AI_BASE_URL'];
    const key = process.env['AI_API_KEY'];
    delete process.env['AI_BASE_URL'];
    delete process.env['AI_API_KEY'];
    try {
      // A packaged build reaches exactly this. It must not throw: the screen
      // has a sentence for "no model configured" and none for an exception.
      assert.equal(modelConfig(), null);
    } finally {
      if (base !== undefined) process.env['AI_BASE_URL'] = base;
      if (key !== undefined) process.env['AI_API_KEY'] = key;
    }
  });
});

describe('what the gate says, and what a person is told', () => {
  it('🟥 never passes a field-result reference to the reader', () => {
    // This is the sentence that reached a real screen. It names VS-7 and ends
    // with a latency figure, and the person reading it does not understand
    // backends and is accountable for one.
    const gate =
      'The choice says the database cannot answer and will not say what is ' +
      'outside it. A refusal that names no gap is the hedging a reader ' +
      'discounts, and VS-7 measured what discounted hedging costs. · 10745ms';
    const said = readerSentenceFor(gate);
    assert.equal(said.includes('VS-7'), false);
    assert.equal(/\d+ms/.test(said), false);
    assert.equal(said.includes('hedging'), false);
    // And it still says the three things that matter.
    assert.match(said, /cannot help/);
    assert.match(said, /would not say what it would take/);
    assert.match(said, /nothing about your data follows/);
  });

  it('tells the six refusals apart', () => {
    // Each of `sealLookup`'s refusals leads a reader somewhere different, so
    // one sentence for all six would be the same as no sentence.
    const said = [
      'names no gap',
      'was never offered',
      'more than once',
      'names nothing to look at',
      'two different answers',
      'shape it was asked for',
    ].map(readerSentenceFor);
    assert.equal(new Set(said).size, 6);
    for (const s of said) assert.match(s, /nothing about your data follows/);
  });

  it('🟥 admits it when a refusal is one it has not been taught', () => {
    // A rule added to sealLookup and not here must produce an honest shrug,
    // not a confident explanation of the wrong thing.
    const said = readerSentenceFor('some rule nobody wrote a sentence for');
    assert.match(said, /will not guess at what it meant/);
    assert.match(said, /nothing about your data follows/);
  });
});
