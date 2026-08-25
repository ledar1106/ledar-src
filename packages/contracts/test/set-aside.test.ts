/**
 * The second channel into the report, and the gate it did not have. Debt N42.
 *
 * Every `Finding` passes `sealFindings`, so hard rule ③ — a Layer B pattern
 * nobody has ruled on may not be called a bug, an error, or broken — is
 * enforced by a machine. `ruledOut` and `notExamined` are not findings: they
 * are the pack's own structures, they are printed into the report in the
 * product's own voice, and until schema 4 no gate read a word of them.
 *
 * Nothing had got through. Every sentence was checked by hand when the debt
 * was filed, and the one that came closest — *"not as that many broken
 * links"* — was a negation. This is a fence built before anything crossed it,
 * which is the only time a fence costs nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFECT_WORDS_VI } from '../src/findings.js';
import { sealSetAside, sealSetAsides, SetAsideRefused } from '../src/set-aside.js';

describe('a sentence the scanner declines to raise', () => {
  it('passes an ordinary reason through unchanged', () => {
    const sealed = sealSetAside({
      target: 'public.votes.post_id',
      reason: 'only 31% of values line up with posts — probably a coincidence',
    });
    assert.equal(sealed.target, 'public.votes.post_id');
    assert.match(sealed.reason, /coincidence/);
  });

  it('refuses a defect word in the reason', () => {
    // The same clause `sealFindings` applies, on text reaching the same
    // reader. Unconditional here rather than gated on a confidence level: a
    // set-aside entry carries no confidence, because it is not a claim about
    // the database at all — it is a statement about what this scanner chose
    // not to say. Nothing that is not a claim may call anything broken.
    for (const word of ['bug', 'broken', 'error', 'wrong', 'invalid', 'corrupt']) {
      assert.throws(
        () =>
          sealSetAside({
            target: 'public.orders.user_id',
            reason: `the values are ${word}, so this is not being raised`,
          }),
        new RegExp(`says "${word}"`, 'i'),
        `"${word}" reached a reader through the set-aside list`,
      );
    }
  });

  it('refuses a defect word in Vietnamese too', () => {
    // 🟥 Open from the day LEDAR_LANG=vi shipped until 2026-08-24. The word
    // list was English-only, so hard rule ③ was enforced on half the product.
    // It stayed harmless only because every Vietnamese sentence was written by
    // a person who had read the vi catalogue's header. It stops being harmless
    // the moment a model writes Vietnamese into a report — VS-8 — so the fence
    // goes up before the thing it fences exists.
    //
    // AGENTS §4.9 ①, third occurrence: a gate that reads one language guards
    // half a report.
    for (const word of DEFECT_WORDS_VI) {
      assert.throws(
        () =>
          sealSetAside({
            target: 'public.orders.user_id',
            reason: `những giá trị này ${word}, nên tôi không nêu ra`,
          }),
        // The message matcher, not the class: `assertNoDefectWords` throws a
        // plain Error, the way the English case above already asserts. A test
        // that named the class here would pass on a shape failure and call it
        // a word ban.
        new RegExp(`says "${word}"`, 'i'),
        `"${word}" reached a Vietnamese reader through the set-aside list`,
      );
    }
  });

  it('has no entry that can never fire', () => {
    // 🟥 The trap this exists for: JavaScript's \w is ASCII-only, so a
    // Vietnamese vowel carrying a diacritic is a NON-word character. `hư`
    // has non-word characters on both sides of its trailing boundary and
    // therefore never matches anything at all. It compiles, it reads
    // correctly, and it is dead.
    //
    // A plausible future addition — `sai số` — would end on `ố` and join
    // the list as a rule nobody enforces. The count would say the rule is
    // covered. A word list with one silently dead entry is worse than a
    // shorter list.
    for (const word of DEFECT_WORDS_VI) {
      assert.throws(
        () =>
          sealSetAside({
            target: 'public.orders.user_id',
            reason: `giá trị ${word} ở đây, nên tôi không nêu ra`,
          }),
        new RegExp(`says "${word}"`, 'i'),
        `"${word}" is in the ban list and matches nothing — check its \b ` +
          `boundaries, and whether it ends on an ASCII letter`,
      );
    }
  });

  it('does not ban the words the Vietnamese catalogue needs', () => {
    // The interesting half of the rule. `hư` means broken — and `hư không`
    // means NOTHINGNESS, which is exactly what the vi catalogue says in
    // `layer-b.aside.one-repeated-value`: links that lead `tới hư không`. That
    // phrasing was itself written to satisfy an earlier version of this rule.
    // A gate banning `hư` would fail the sentence written to obey it.
    //
    // `sai số` is `margin of error`, a thing this product says about its own
    // measurements constantly. Banning bare `sai` would take that with it.
    for (const reason of [
      'chừng ấy liên kết dẫn tới hư không, nên tôi không nêu nó thành câu hỏi',
      'sai số của phép lấy mẫu quá lớn để nói được điều gì',
    ]) {
      assert.doesNotThrow(
        () => sealSetAside({ target: 'public.orders.user_id', reason }),
        `the gate refused a sentence the product itself writes: ${reason}`,
      );
    }
  });

  it('refuses an entry with nothing legible in it', () => {
    // Throws rather than dropping the row. A silently discarded entry takes
    // the coverage hole with it, and the report goes back to being unable to
    // tell "nothing was wrong here" from "nothing was looked at here".
    assert.throws(() => sealSetAside({ target: '', reason: 'x' }), SetAsideRefused);
    assert.throws(() => sealSetAside({ target: 'x', reason: '' }), SetAsideRefused);
  });

  it('seals a whole list, and one bad entry stops the list', () => {
    const ok = sealSetAsides([
      { target: 'a', reason: 'the name matching is probably a coincidence' },
      { target: 'b', reason: 'the scan reached its ceiling on this database' },
    ]);
    assert.equal(ok.length, 2);

    assert.throws(
      () =>
        sealSetAsides([
          { target: 'a', reason: 'fine' },
          { target: 'b', reason: 'this column is broken' },
        ]),
      /says "broken"/i,
    );
  });

  it('allows the words once an owner could have ruled — nowhere, here', () => {
    // Deliberately no escape hatch. `assertClaimDiscipline` lifts the ban for
    // a finding the owner has marked `confirmed`, because at that point the
    // owner is the one calling it a defect. A set-aside entry has no
    // `userStatus` and never will: it is the scanner talking about its own
    // restraint, and there is no owner ruling to inherit.
    assert.throws(
      () => sealSetAside({ target: 'a', reason: 'confirmed by the owner: broken' }),
      /says "broken"/i,
    );
  });
});
