/**
 * The catalogue behind t('key') — _doc/21 §4's rule made checkable.
 *
 * A missing key is already a compile error (MessageKey is keyof the
 * catalogue). What the compiler cannot see: an empty string shipped as
 * copy, or a {parameter} that no caller fills because the name drifted.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { en } from '../src/renderer/i18n/en.js';
import { t } from '../src/renderer/i18n.js';

describe('the English catalogue', () => {
  it('has no empty entries', () => {
    for (const [key, value] of Object.entries(en)) {
      assert.ok(value.trim().length > 0, `catalogue entry ${key} is empty`);
    }
  });

  it('substitutes parameters wherever they appear', () => {
    const line = t('user.sent', { target: 'db.example.com/app' });
    assert.ok(line.includes('db.example.com/app'));
    assert.ok(!line.includes('{target}'));

    const timeouts = t('facts.timeouts', { statement: '60s', idle: '30s', lock: '3s' });
    assert.ok(!/\{[a-z]+\}/.test(timeouts), 'a parameter survived unfilled');
  });

  it('🟥 the map says what it was built from, and what it cannot record', () => {
    // 🟥 This assertion MOVED; it was not dropped, and the difference is the
    // whole point of the entry.
    //
    // What stood here pinned two sentences in the closing turn of the
    // interview: *these answers have not been checked against your database*
    // and *nothing has been saved*. Both were true and both stopped being
    // true in the same commit — the answers now go to the main side, meet
    // what the scan saw, and come back as a map. Leaving the old pin would
    // have forced the copy to keep saying something false in order to stay
    // green, which is the worst thing a test can ask of a product.
    //
    // What did NOT change is the obligation. `_doc/25`'s own gate asks every
    // screen where it has not looked (Disclose) and where it does not know
    // (Admit), and the map has exactly two answers:
    //
    //   · it was built from NAMES — not one row of anybody's data was read
    //   · a yes can be recorded here; a no has nowhere to go yet
    //
    // Both are the half of a sentence a tightening edit deletes first,
    // because on its own the confident half reads cleaner.
    const method = t('profile.method');
    assert.match(method, /names/);
    assert.match(method, /not read a single row/);

    const noPath = t('profile.no-path');
    assert.match(noPath, /cannot yet record/);
  });

  it('🟥 the map states its version, and says it is not the last word', () => {
    // Ideal §24: a profile is meant to be EDITED, and it is emphatically not
    // final truth. A screen that shows a map with no version on it, and no
    // sentence saying it moves, is a screen that presents a guess as a
    // settled account of somebody's system.
    const version = t('profile.version', { n: 3 });
    assert.ok(version.includes('3'));
    assert.ok(!version.includes('{n}'), 'a parameter survived unfilled');
    assert.match(version, /not the last word/);
  });

  it('keeps the acceptance sentence exactly as the contract writes it', () => {
    // _doc/25 S2 and the audited demo agree on this headline, em dash and
    // capitals included. The screen quoting it differently would be the
    // screen drifting from the contract, not the contract from the screen.
    assert.equal(t('proof.enforced.headline'), 'READ-ONLY — ENFORCED BY THE DATABASE');
  });
});
