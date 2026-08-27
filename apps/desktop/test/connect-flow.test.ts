/**
 * The S2 flow, end to end against the fixture, and its refusals without one.
 *
 * The fixture half proves the sentence the screen exists to show — the
 * verdict comes from `inspectPrivileges` reading pg_roles and privileges,
 * and the probe's rejection text comes from Postgres itself. Measured
 * before being pinned (2026-08-26, pagila fixture): kind
 * `read_only_enforced`, probe blocked with "cannot execute CREATE TABLE in
 * a read-only transaction", 93/93 tables readable. The counts are not
 * pinned — the fixture grows tables — the shape and the provenance are.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PAGILA_DSN, announceSkip, openPagila } from '@ledar/test-fixtures';

import { runConnectFlow } from '../src/main/connect-flow.js';

const gate = await openPagila();
if (gate.ok) {
  await gate.client.end();
} else {
  announceSkip('desktop connect flow (pagila)', gate.reason);
}

describe('runConnectFlow against the pagila fixture', { skip: !gate.ok }, () => {
  it('returns the database-enforced verdict, proven, with scope and revoke attached', async () => {
    const outcome = await runConnectFlow(PAGILA_DSN);

    assert.equal(outcome.kind, 'read_only_enforced');
    if (outcome.kind !== 'read_only_enforced') return;

    // The probe is the evidence: the database refused, in its own words.
    assert.equal(outcome.probe.blocked, true);
    if (outcome.probe.blocked) {
      assert.match(outcome.probe.error, /read-only transaction/);
    }

    assert.equal(outcome.session.transactionReadOnly, true);
    assert.equal(outcome.session.isSuperuser, false);

    // Scope arrives as backend sentences with both numbers already in them
    // (reconciliation law 1: the FE never divides).
    assert.ok(outcome.scope.tablesReadable > 0);
    assert.ok(outcome.scope.lines.length > 0);
    assert.match(outcome.scope.lines[0] ?? '', /^\d+ of \d+ tables in public$/);

    // The exit is handed over unprompted, written around the real role.
    assert.ok(outcome.scope.revokeSql.includes('"ledar_reader"'));
    assert.ok(outcome.scope.revokeSql.includes('DROP ROLE'));
  });
});

describe('runConnectFlow refusals that never reach a database', () => {
  it('turns an empty connection string into a connect_error, not a crash', async () => {
    const outcome = await runConnectFlow('');
    assert.equal(outcome.kind, 'connect_error');
  });

  it('refuses a non-string payload from the renderer', async () => {
    const outcome = await runConnectFlow({ dsn: 'postgresql://x@y/z' });
    assert.equal(outcome.kind, 'connect_error');
  });

  it('caps the length before anything is parsed', async () => {
    const outcome = await runConnectFlow(`postgresql://u:fixture_no_real_data@h/${'a'.repeat(5000)}`);
    assert.equal(outcome.kind, 'connect_error');
    if (outcome.kind === 'connect_error') {
      assert.match(outcome.message, /longer than/);
    }
  });

  it('reports an unreachable server as a connect_error with pg’s own message', async () => {
    // Port 9 (discard) answers nothing; refusal is immediate on loopback.
    const outcome = await runConnectFlow('postgresql://nobody:fixture_no_real_data@127.0.0.1:9/postgres');
    assert.equal(outcome.kind, 'connect_error');
    if (outcome.kind === 'connect_error') {
      assert.ok(outcome.message.length > 0);
      // The credential must not ride along in what the screen will show.
      assert.ok(!outcome.message.includes('fixture_no_real_data'));
    }
  });
});
