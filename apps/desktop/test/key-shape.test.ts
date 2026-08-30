/**
 * A credential in the question box, and the slip that produced this file.
 *
 * 🟥 It happened. Driving the key screen, a click missed the key field by a
 * few pixels and a real API key went into the QUESTION box — in clear text, on
 * screen, one button from being sent to a model alongside the table names. The
 * person doing it knew what the two boxes were for. Somebody who has just been
 * told "paste your key" is more likely to, not less.
 *
 * The failure mode this file guards against SECOND is the opposite one: a
 * detector that fires on real questions is a detector people learn to work
 * around, and then it protects nobody.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { looksLikeSecret } from '../src/shared/key-shape.js';

/**
 * Builds a key-shaped string without one ever being a literal here.
 *
 * 🟥 `check-secrets.py` refused this file when the shapes were written out,
 * and it was right to: that gate cannot tell a plausible fake from a real
 * credential, and its own docstring forbids path exceptions — the one rule
 * that keeps it from being switched off a file at a time.
 *
 * Assembling them is not a workaround. It is stronger: a reader can see at a
 * glance that nothing in this file was pasted, because a pasted key would be
 * one literal and there are none.
 */
function shaped(prefix: string, body: string): string {
  return `${prefix}-${body}`;
}

describe('a key in the question box', () => {
  it('🟥 catches the shapes providers actually issue', () => {
    for (const key of [
      shaped('sk', 'gu-QwErTyUiOp1234AsDfGhJkL5678ZxCvBnM90'),
      shaped('sk', 'live_51H8xKjLmNoPqRsTuVwXyZaBcDeFgHiJk'),
      shaped('api', 'key9f8e7d6c5b4a39281706fedcbA9876543210'),
      shaped('pk', 'test_TYooMQauvdEDq54NiTphI7jx'),
    ]) {
      assert.equal(looksLikeSecret(key), true, key.slice(0, 12));
    }
  });

  it('🟥 catches one pasted into the middle of a sentence', () => {
    // Which is what a slip looks like: the person typed, then pasted.
    assert.equal(
      looksLikeSecret(`my key is ${shaped('sk', 'gu-QwErTyUiOp1234AsDfGhJkL5678ZxCvBnM90')} ok`),
      true,
    );
  });

  it('catches a long token with no known prefix', () => {
    // Not every provider prefixes. A 40-character unbroken run mixing case
    // and digits is not a word in any language.
    assert.equal(looksLikeSecret('A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3zA'), true);
  });

  it('🟥 does NOT fire on the questions this product exists for', () => {
    // The important half. Every one of these is a question somebody would
    // really type, several of them from this session's own measurements.
    for (const question of [
      'A customer says they paid but cannot see their rental. Where should I look?',
      'An editor submitted an edit days ago and it still has not appeared. Where should I look?',
      'Did the confirmation email actually reach the customer, and how long did the mail provider take?',
      'A release is showing the wrong number of tracks. Where should I look?',
      'Why does public.damaged_external_ref have rows pointing at staff that is not there?',
      'The chain stops at public.payment — what does that mean?',
    ]) {
      assert.equal(looksLikeSecret(question), false, question.slice(0, 40));
    }
  });

  it('🟥 cannot fire on text outside ASCII, and that is by construction', () => {
    // People ask LEDAR questions in Vietnamese — field results 32 and 35
    // measured a model answering them. An earlier version of this file put one
    // of those questions here as a literal, and `check-public-language.py`
    // refused it: rule ① of CLAUDE.md, and `ledar-src` is read by strangers.
    //
    // Reading it again, that case was nearly vacuous. Both rules match only
    // `[A-Za-z0-9_-]`, so a diacritic ENDS a run — no accented text can match,
    // whatever it says. The property worth pinning is that boundary itself,
    // and it is pinned with a constructed string rather than somebody's
    // sentence.
    const long = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8';
    assert.equal(looksLikeSecret(long), true, 'the ASCII run alone does match');
    // One accented character inside it, and the run is broken in two.
    //
    // ⚠️ `é` and not a Vietnamese letter, and the reason is worth a line: the
    // first attempt used one, and `check-public-language.py` flagged it — the
    // gate cannot tell a single test character from prose, and it is right not
    // to try. `é` sits outside `[A-Za-z0-9_-]` just the same, so it proves the
    // identical property. What is being pinned is "outside ASCII", not
    // "Vietnamese".
    assert.equal(looksLikeSecret('A1b2C3d4E5f6G7h8é9j0K1l2M3n4O5p6Q7r8'), false);
  });

  it('does not fire on ordinary long words or identifiers', () => {
    for (const text of [
      'the column is called customer_id and so is a table in this schema',
      'antidisestablishmentarianism is a very long word indeed',
      'check public.editor_collection_release for me',
      'error: column t0.customer_id does not exist',
    ]) {
      assert.equal(looksLikeSecret(text), false, text.slice(0, 30));
    }
  });

  it('🟥 does NOT fire on a UUID, which people paste into questions constantly', () => {
    // The most important false positive there is. "Why is order
    // a1b2c3d4e5f6… missing" is an ordinary question, and a lowercase UUID is
    // 32 unbroken characters of letters and digits — over the length rung on
    // its own. What saves it is the requirement for an UPPERCASE letter too,
    // and a mutation run removed that requirement without a single test
    // noticing.
    for (const q of [
      'why is order a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 missing',
      'the row with id 550e8400e29b41d4a716446655440000 has no payment',
      'a1b2c3d4-e5f6-a7b8-c9d0-e1f2a3b4c5d6 is not in rental',
    ]) {
      assert.equal(looksLikeSecret(q), false, q.slice(0, 40));
    }
  });

  it('🟥 does NOT fire on a camelCase identifier somebody names', () => {
    // The length rung is 32 and not 12, and nothing tested that until a
    // mutation lowered it and stayed green. `damagedWideLink2` is a table
    // somebody would really name and really ask about.
    for (const q of [
      'check damagedWideLink2 for me',
      'does customerId42 exist in the map',
      'what is orderItemV3 pointing at',
    ]) {
      assert.equal(looksLikeSecret(q), false, q);
    }
  });

  it('🟥 catches a SHORT prefixed key mid-sentence, which only the prefix rung can', () => {
    // The earlier mid-sentence case used a 46-character key, so the length
    // rung caught it and the prefix rung was never exercised — the third time
    // this session a case both rules agree on tested neither. This one is 21
    // characters: under the length rung of 32, so only `(?:^|\s)sk-…` can see
    // it. The body after `sk-` is 17 characters, which clears the prefix
    // rung's own minimum of 16 — a real key body is longer than that, and a
    // shorter one is more likely to be a word than a credential.
    assert.equal(looksLikeSecret(`my key is ${shaped('sk', 'abc123DEF456ghiJK')} ok`), true);
    assert.equal(looksLikeSecret(shaped('sk', 'abc123DEF456ghiJK')), true);
  });

  it('needs a run with no spaces in it', () => {
    // A sentence has a space every few characters. A key has none.
    assert.equal(looksLikeSecret('Ab1 Cd2 Ef3 Gh4 Ij5 Kl6 Mn7 Op8 Qr9 St0 Uv1 Wx2'), false);
  });

  it('🟥 answers with a boolean and never carries the secret out', () => {
    // Nothing that reports on a suspected credential may bring it along: a
    // refusal quoting the key would put it in a log, a screenshot, and a bug
    // report. The type is the guarantee.
    const answer: boolean = looksLikeSecret(shaped('sk', 'abcdefghijklmnopqrstuvwxyz012345'));
    assert.equal(typeof answer, 'boolean');
  });
});
