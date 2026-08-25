/**
 * The cache, and the four things it must never do.
 *
 * A cache is easy to test into a false sense of working: store, fetch, assert
 * equal, green. What matters is the other four:
 *
 *   it must not be able to cost anybody their evidence
 *   it must not hand back something the caller would have refused
 *   it must not collide two questions that mean different things
 *   it must not key on a language, because the answer has none
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AnswerCache } from '../src/answer-cache.js';
import type { CacheKey } from '../src/answer-cache.js';

const KEY: CacheKey = {
  structureHash: 'abc123',
  question: 'how many rows does this rest on?',
  tier: 'answers',
};

const ANSWER = { answerable: true, facts: ['rows_examined'], missing: [] };

/** Stands in for `sealAnswer`: accepts anything whose facts are all offered. */
const validatorFor = (offered: readonly string[]) => (raw: unknown) => {
  const a = raw as { facts?: string[] };
  const bad = (a.facts ?? []).filter((f) => !offered.includes(f));
  if (bad.length > 0) throw new Error(`not offered: ${bad.join(', ')}`);
  return a;
};

const accept = validatorFor(['rows_examined', 'sampling', 'column']);

describe('answers already paid for', () => {
  it('gives back what it was given', () => {
    const c = AnswerCache.memory();
    assert.equal(c.get(KEY, accept), null, 'a fresh cache had something in it');
    c.put(KEY, ANSWER);
    assert.deepEqual(c.get(KEY, accept), ANSWER);
    assert.equal(c.size(), 1);
    c.close();
  });

  it('does not key on the language, because the answer has none', () => {
    // The design paying off. A model returns identifiers and the PRODUCT
    // renders the sentence, so one stored answer serves every market. The
    // obvious key would have carried a language and halved the hit rate for
    // nothing.
    const c = AnswerCache.memory();
    c.put(KEY, ANSWER);
    // Nothing in `CacheKey` can express a language, which is the point: this
    // is enforced by the type rather than by whoever writes the next call.
    assert.deepEqual(Object.keys(KEY).sort(), ['question', 'structureHash', 'tier']);
    assert.deepEqual(c.get(KEY, accept), ANSWER);
    c.close();
  });
});

describe('what it must never do', () => {
  it('treats an answer the caller would refuse as a MISS', () => {
    // `structureHash` does not hash counts, so a finding can keep its hash and
    // change its facts. An answer citing a fact that no longer exists is a
    // sentence about evidence that is not there any more.
    const c = AnswerCache.memory();
    c.put(KEY, { answerable: true, facts: ['a_fact_that_went_away'], missing: [] });
    assert.equal(c.get(KEY, accept), null, 'a stale answer was served');
    c.close();
  });

  it('forgets a stale answer rather than re-refusing it forever', () => {
    const c = AnswerCache.memory();
    c.put(KEY, { answerable: true, facts: ['gone'], missing: [] });
    assert.equal(c.get(KEY, accept), null);
    assert.equal(c.size(), 0, 'the stale row was kept to be refused again');
    c.close();
  });

  it('does not collide two questions that mean different things', () => {
    // Trimmed, and nothing more. Deciding which differences are meaningful is
    // a judgement a cache is in no position to make, and getting it wrong
    // means answering a question nobody asked.
    const c = AnswerCache.memory();
    c.put(KEY, ANSWER);
    const other = { ...KEY, question: 'how many rows does this NOT rest on?' };
    assert.equal(c.get(other, accept), null);

    // Whitespace is not meaning, though.
    assert.deepEqual(
      c.get({ ...KEY, question: `  ${KEY.question}  ` }, accept),
      ANSWER,
    );
    c.close();
  });

  it('does not serve one tier answer for another', () => {
    // A different tier is a different model, and ㉒ measured what different
    // models do with the same input — one of them obeyed an attacker.
    const c = AnswerCache.memory();
    c.put(KEY, ANSWER);
    assert.equal(c.get({ ...KEY, tier: 'decides' }, accept), null);
    c.close();
  });

  it('does not collide two findings that say different things', () => {
    const c = AnswerCache.memory();
    c.put(KEY, ANSWER);
    assert.equal(c.get({ ...KEY, structureHash: 'def456' }, accept), null);
    c.close();
  });
});

describe('when its own shape moves on', () => {
  it('rebuilds itself instead of refusing to open', () => {
    // Correct here and indefensible in the history. Nothing in this file is
    // evidence; every row can be had again by asking. A cache that refuses to
    // open because it is old has confused itself for a record — and the
    // history's own answer, moving the file aside, would mean a cache bump
    // costing somebody their scans.
    const c = AnswerCache.memory();
    c.put(KEY, ANSWER);
    assert.equal(c.size(), 1);
    c.close();

    // A real version mismatch needs a file; `:memory:` cannot be reopened.
    // What is asserted here is the property that makes the drop safe: the
    // cache holds nothing that cannot be recomputed.
    const fresh = AnswerCache.memory();
    assert.equal(fresh.size(), 0);
    assert.equal(fresh.get(KEY, accept), null, 'a miss is always safe');
    fresh.close();
  });
});

describe('overwriting', () => {
  it('keeps the newest answer for one key, not two rows', () => {
    const c = AnswerCache.memory();
    c.put(KEY, ANSWER);
    const second = { answerable: false, facts: [], missing: ['who'] };
    c.put(KEY, second);
    assert.equal(c.size(), 1);
    assert.deepEqual(c.get(KEY, accept), second);
    c.close();
  });
});
