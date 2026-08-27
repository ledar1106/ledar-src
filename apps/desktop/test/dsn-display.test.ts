/**
 * What the conversation shows about a connection string: the target, never
 * the credential. The user's own turn is built from this function, so if it
 * leaks, the leak is on screen and in every screenshot anyone ever shares.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dsnDisplayTarget } from '../src/renderer/dsn.js';

describe('dsnDisplayTarget', () => {
  it('shows host, port and database — no password, and no username either', () => {
    const shown = dsnDisplayTarget('postgresql://ledar_reader:fixture_no_real_data@db.example.com:6543/appdb');
    assert.equal(shown, 'db.example.com:6543/appdb');
    assert.ok(shown !== null && !shown.includes('fixture_no_real_data'));
    assert.ok(shown !== null && !shown.includes('ledar_reader'));
  });

  it('handles both postgres:// and postgresql:// and a missing port', () => {
    assert.equal(dsnDisplayTarget('postgres://u:fixture_no_real_data@localhost/pagila'), 'localhost/pagila');
    assert.equal(dsnDisplayTarget('postgresql://u@localhost:55432/pagila'), 'localhost:55432/pagila');
  });

  it('gives null for anything it cannot parse, so the caller shows a generic label', () => {
    assert.equal(dsnDisplayTarget('Server=tcp:x;Password=y'), null);
    assert.equal(dsnDisplayTarget('https://not-a-database/'), null);
    assert.equal(dsnDisplayTarget(''), null);
    // Rather a generic label than a wrong-looking guess.
    assert.equal(dsnDisplayTarget('postgresql://'), null);
  });

  it('keeps query parameters out of the label entirely', () => {
    const shown = dsnDisplayTarget('postgresql://u:fixture_no_real_data@h:5432/db?sslmode=require&password=oops');
    assert.equal(shown, 'h:5432/db');
  });
});
