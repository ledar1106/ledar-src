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

  it('keeps the acceptance sentence exactly as the contract writes it', () => {
    // _doc/25 S2 and the audited demo agree on this headline, em dash and
    // capitals included. The screen quoting it differently would be the
    // screen drifting from the contract, not the contract from the screen.
    assert.equal(t('proof.enforced.headline'), 'READ-ONLY — ENFORCED BY THE DATABASE');
  });
});
