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

  it('never promises the read-back without the branch where it is refused', () => {
    // The first real person to finish the interview wrote a rule about a
    // number — the one shape `bounded-rule` declines outright. The copy at
    // the time promised, flatly, to say back "which table and which column",
    // which for that sentence was never going to happen.
    //
    // The half pinned here is the half a tightening edit deletes first,
    // because on its own the promise reads cleaner. It is not decoration:
    // without it the screen states an outcome the product cannot guarantee.
    const then = t('interview.done.rule.then');
    assert.match(then, /If I cannot/);
    assert.match(t('interview.done.rule.next'), /may turn out I cannot/);
  });

  it('keeps the acceptance sentence exactly as the contract writes it', () => {
    // _doc/25 S2 and the audited demo agree on this headline, em dash and
    // capitals included. The screen quoting it differently would be the
    // screen drifting from the contract, not the contract from the screen.
    assert.equal(t('proof.enforced.headline'), 'READ-ONLY — ENFORCED BY THE DATABASE');
  });
});
