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
import { useCipher } from '../src/main/model-settings.js';

/**
 * `modelConfig` now reads the person's stored settings, and those are held by
 * the operating system's own cipher. Under plain node there is none — the
 * `electron` stub has no `safeStorage` — so the seam is filled with something
 * that cannot encrypt. That is the honest stand-in for a fresh machine where
 * nobody has typed a key: no stored key, and the environment is what is left.
 */
function noStoredKey(): void {
  useCipher({
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  });
}

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
    noStoredKey();
    process.env['AI_BASE_URL'] = 'https://example.invalid/v1';
    process.env['AI_API_KEY'] = 'not-a-real-key';
    try {
      const config = modelConfig();
      assert.notEqual(config, null);
      assert.equal(config?.tiers['rules']?.model, shipped.tiers['rules']?.model);
    } finally {
      delete process.env['AI_BASE_URL'];
      delete process.env['AI_API_KEY'];
      useCipher(null);
    }
  });

  it('🟥 no key is null, and null is a state rather than a throw', () => {
    noStoredKey();
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
      useCipher(null);
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

describe('a refusal has to say whether anything was sent', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const whole = readFileSync(resolve(here, '../src/main/ask-flow.ts'), 'utf8');
  // askSend only. `askPreview` returns an `AskPreview`, whose `unavailable`
  // carries a `reason` and never sends anything, so counting its returns here
  // would be counting a different type's cases against this rule.
  const source = whole.slice(whole.indexOf('export async function askSend('));

  /**
   * The two model calls, as a position in the file.
   *
   * Everything `askSend` returns above this line refused before a byte left
   * the machine; everything below it refused after the calls were paid for.
   * The window re-enables Send only for the first group, so a refusal filed
   * on the wrong side is either a dead button or an invitation to spend
   * again without saying so.
   */
  const sendLine = source.indexOf('askLookupInTwoRounds(');

  it('🟥 every unavailable outcome carries the fact', () => {
    assert.ok(sendLine > 0, 'the send call moved; this test is reading the wrong file');

    const returns = [...source.matchAll(/kind: 'unavailable'/g)];
    // Ten today. The number is asserted so that adding an eleventh has to
    // come through here rather than inheriting whatever the copied line said —
    // and it has already earned that: an eleventh was added on 2026-08-31 and
    // this line went red for it, which is how the change got read before it
    // shipped. (That change was then withdrawn; see field result 50.)
    assert.equal(returns.length, 10);

    /**
     * The object literal this `kind` belongs to, to its own closing brace.
     *
     * 🟥 Counted, not `indexOf('}')`. The first version took the next brace,
     * and on 2026-08-31 a refusal whose sentence interpolates `${aimedAt}`
     * ended the slice at the template's closing brace — three lines before
     * the `sent` it was looking for. The test reported a missing field that
     * was there.
     *
     * ⚠️ Brace counting assumes braces balance, which holds here because the
     * only ones inside these literals are template interpolations. A literal
     * containing an unmatched brace in a string would break it, and there is
     * none.
     */
    const literalAt = (at: number): string => {
      let depth = 1;
      for (let i = at; i < source.length; i += 1) {
        const c = source[i];
        if (c === '{') depth += 1;
        else if (c === '}') {
          depth -= 1;
          if (depth === 0) return source.slice(at, i);
        }
      }
      return source.slice(at);
    };

    for (const match of returns) {
      const at = match.index!;
      const literal = literalAt(at);
      assert.match(
        literal,
        /sent: (true|false)/,
        `an unavailable outcome near offset ${at} does not say whether it sent anything`,
      );
      const spent = /sent: true/.test(literal);
      assert.equal(
        spent,
        at > sendLine,
        at > sendLine
          ? `a refusal after the calls claims nothing was sent (offset ${at})`
          : `a refusal before the calls claims it sent something (offset ${at})`,
      );
    }
  });
});
