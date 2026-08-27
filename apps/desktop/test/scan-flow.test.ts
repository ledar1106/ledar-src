/**
 * S3 "Scan" as one flow, against the real fixture — and the credential that
 * must not come back out with the report.
 *
 * Two halves, and the second is the reason this file exists.
 *
 * The fixture half proves the flow does something: Pagila is a real database
 * with 19 planted faults in it, and a scan of it produces a scope strip, a
 * verdict with a sentence in it, and a line saying where the run was
 * recorded. Nothing here pins the counts — the fixture grows tables — only
 * the shape and the provenance, the same bargain `connect-flow.test.ts`
 * strikes.
 *
 * 🟥 The other half is hard rule ⑥ made checkable. The renderer holds a
 * `SessionHandle` precisely so the DSN never has to cross the bridge, and
 * the way that promise dies is not a `console.log` — it is a field on the
 * outcome that seemed harmless. `historyLines` naming the file it wrote,
 * a `scan_error` message quoting pg, a scope line naming the server. So the
 * whole returned object is walked, every string in it, and the password is
 * looked for in all of them.
 *
 * `LEDAR_HISTORY_DB` points at a temp file. Without it this suite writes
 * runs into the operator's own `%LOCALAPPDATA%\ledar\history.db`, which is
 * the record of somebody's real databases.
 *
 * 🟥 No container, no pass. The skip is announced out loud — HANDOFF-STATUS
 * §1b: the three `ledar-*` containers are `restart=no`, so a reboot leaves
 * them lying down, and `skipped > 0` at a glance looks exactly like green.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { PAGILA_DSN, announceSkip, openPagila } from '@ledar/test-fixtures';

import { closeAllSessions, closeSession, openSession } from '../src/main/session.js';

const SUITE = 'desktop scan flow (pagila)';

const HISTORY_DIR = mkdtempSync(join(tmpdir(), 'ledar-desktop-scan-'));
const HISTORY_DB = join(HISTORY_DIR, 'history.db');
process.env.LEDAR_HISTORY_DB = HISTORY_DB;

/**
 * Loaded after the environment is set, and that is the whole reason it is a
 * dynamic import.
 *
 * `historyFile()` reads `LEDAR_HISTORY_DB` when it is called, but a module
 * that resolves its path once at load time would already have read the real
 * one — static imports are evaluated before a single line of this file runs.
 * Paying one `await` here means the test cannot write into the operator's
 * history no matter which of the two ways the flow resolves its path.
 */
const { runScanFlow } = await import('../src/main/scan-flow.js');

/**
 * The password, taken from the DSN rather than written down again.
 *
 * Two copies of a credential in two files is how one of them ends up being
 * the wrong one, and a leak test looking for the wrong string is a leak test
 * that cannot fail. `LEDAR_PAGILA_DSN` can point this somewhere else, so the
 * length is asserted before it is used for anything.
 */
const CREDENTIAL = new URL(PAGILA_DSN).password;

/**
 * Everything in the temp directory, by name and size.
 *
 * The whole directory rather than one file: `node:sqlite` writes `-wal` and
 * `-shm` siblings, and a run that opened the store and got no further would
 * leave those behind while `history.db` looked untouched.
 */
function historyState(): string {
  if (!existsSync(HISTORY_DIR)) return '<gone>';
  return readdirSync(HISTORY_DIR)
    .sort()
    .map((name) => `${name}:${statSync(join(HISTORY_DIR, name)).size}`)
    .join('|');
}

/** Every string anywhere in the outcome, including ones JSON.stringify drops. */
function everyStringIn(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const out: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...everyStringIn(item, seen));
    return out;
  }
  // `getOwnPropertyNames`, not `Object.values`: a non-enumerable field is
  // still a field, and it is exactly where somebody would stash a DSN they
  // did not want to see in a log.
  for (const key of Object.getOwnPropertyNames(value)) {
    out.push(key);
    out.push(...everyStringIn((value as Record<string, unknown>)[key], seen));
  }
  return out;
}

const gate = await openPagila();
if (gate.ok) {
  // The gate's own connection has done its job; the flow opens its own from
  // the DSN the session holds.
  await gate.client.end();
} else {
  announceSkip(SUITE, gate.reason);

  /**
   * The skip, said twice, because the two places a person looks say
   * different things.
   *
   * `announceSkip` writes the reason to stderr, the way
   * `connect-flow.test.ts` does — that is the line a person reading the run
   * sees. But a suite skipped at the `describe` level does NOT move the
   * runner's counters: measured here, the four fixture tests vanish from the
   * totals and `skipped` reads `0`. HANDOFF-STATUS §1b leans on `skipped > 0`
   * as the tell that a container is lying down, and that tell stays silent
   * for a `describe` skip.
   *
   * So, one counted marker as well, in the shape
   * `packages/rule-runner/test/run-rule.pagila.test.ts` already uses.
   */
  describe(`${SUITE} — not run`, () => {
    it('nothing was scanned against a real database', { skip: gate.reason }, () => {
      // Deliberately empty. `skipped > 0` is not green, and the handoff says so.
    });
  });
}

after(() => {
  closeAllSessions();
  rmSync(HISTORY_DIR, { recursive: true, force: true, maxRetries: 5 });
});

/**
 * Declared first on purpose. These assert that nothing was written, and they
 * are only worth anything while nothing has been written yet — the fixture
 * suite below is what proves a real scan DOES write there, and without it
 * "the history is untouched" would be true of a flow that never records
 * anything at all (AGENTS.md §4.3).
 */
describe('runScanFlow without a session it issued', () => {
  it('refuses a handle nobody issued, and runs nothing', async () => {
    const before = historyState();

    for (const stranger of ['', '   ', 'not-a-handle', PAGILA_DSN, '__proto__', 'constructor']) {
      const outcome = await runScanFlow(stranger);
      assert.equal(
        outcome.kind,
        'no_session',
        `${JSON.stringify(stranger)} was treated as a session`,
      );
      if (outcome.kind === 'no_session') {
        // "Nothing ran" still has to be said. Silence is the failure mode
        // this product is built against.
        assert.ok(outcome.message.trim().length > 0);
      }
    }

    assert.equal(
      historyState(),
      before,
      'the history changed while no session existed, so something ran',
    );
  });

  it('refuses a payload that is not a string at all', async () => {
    // The renderer is the untrusted side of this bridge — `shared/ipc.ts`
    // says so at the top — so the cast is the test standing where a
    // compromised window stands. The channel carries whatever was sent; the
    // type is a promise about the honest case only.
    const before = historyState();
    const outcome = await runScanFlow({ handle: 'x' } as unknown as string);

    assert.equal(outcome.kind, 'no_session');
    assert.equal(historyState(), before);
  });

  it('refuses a handle that WAS valid, once it has been closed', async () => {
    // The sharper case. An unknown string was never anything; a closed
    // handle was a real session five milliseconds ago, and a lookup that
    // holds onto the DSN one moment too long fails exactly here.
    const handle = openSession(PAGILA_DSN);
    closeSession(handle);
    const before = historyState();

    const outcome = await runScanFlow(handle);

    // Order matters for legibility, not for strength: with `closeSession`
    // mutated to a no-op, the kind assertion fires first and hides the one
    // below it. Checked with the two swapped, and the history assertion goes
    // red on its own ('history.db:94208' where '' was expected) — AGENTS.md
    // §4.16, an assertion nobody has watched fail is not an assertion.
    assert.equal(outcome.kind, 'no_session');
    assert.equal(historyState(), before, 'a closed session still ran a scan');
  });

  it('says no_session without naming the credential', async () => {
    assert.ok(CREDENTIAL.length > 0, 'the fixture DSN has no password, so this test checks nothing');

    const outcome = await runScanFlow(PAGILA_DSN);
    assert.equal(outcome.kind, 'no_session');
    if (outcome.kind !== 'no_session') return;

    // The whole DSN was just handed in where a handle belongs. A refusal
    // that echoes what it was given puts the credential on the screen.
    assert.ok(
      !outcome.message.includes(CREDENTIAL),
      'the refusal quoted the password back at the renderer',
    );
    assert.ok(!outcome.message.includes(PAGILA_DSN));
  });
});

describe(SUITE, { skip: !gate.ok }, () => {
  it('scans, and says what it looked at, what it concluded, and where the run went', async () => {
    const handle = openSession(PAGILA_DSN);
    const outcome = await runScanFlow(handle);

    assert.equal(outcome.kind, 'scanned');
    if (outcome.kind !== 'scanned') return;

    // The scope strip is the D in the product's name (`_doc/25` 3.3 ④). It
    // is printed at the top and the bottom and cannot be turned off, so an
    // empty one is a report that has stopped saying what it covered.
    assert.ok(outcome.scopeStrip.trim().length > 0, 'the scope strip is empty');

    // The verdict's headline is the one line a reader who reads nothing else
    // comes away with.
    assert.ok(outcome.verdict.headline.trim().length > 0, 'the verdict has no headline');

    // Recorded, or a sentence saying why not — never silence. Both are
    // acceptable answers; an empty list is not one of them.
    assert.ok(outcome.historyLines.length > 0, 'the report says nothing about the run being recorded');
    for (const line of outcome.historyLines) {
      assert.ok(line.trim().length > 0, 'a history line is blank');
    }
  });

  it('records the run in the history it was pointed at — the anchor for the refusals above', async () => {
    // Separated so a red here is legible. If the flow does not write a
    // history at all, every "the history is untouched" assertion in the
    // first suite is vacuously true and this file is watching less than its
    // test count suggests (AGENTS.md §4.3, §4.16).
    const handle = openSession(PAGILA_DSN);
    const outcome = await runScanFlow(handle);

    assert.equal(outcome.kind, 'scanned');
    assert.ok(
      existsSync(HISTORY_DB),
      `no history was written to ${HISTORY_DB}; the refusal tests above are then watching nothing`,
    );
  });

  it('🟥 never lets the DSN out — not in any field, at any depth', async () => {
    assert.ok(CREDENTIAL.length > 0, 'the fixture DSN has no password, so this test checks nothing');

    const handle = openSession(PAGILA_DSN);
    const outcome = await runScanFlow(handle);

    assert.equal(outcome.kind, 'scanned');
    if (outcome.kind !== 'scanned') return;

    const serialized = JSON.stringify(outcome);
    const strings = everyStringIn(outcome);

    // The anchor, first: prove the walk is actually looking at the report.
    // `includes` on an empty haystack answers false for everything, and a
    // leak test over nothing is the cleanest green in this repo.
    assert.ok(outcome.verdict.headline.length > 0);
    assert.ok(
      serialized.includes(outcome.verdict.headline),
      'the serialized outcome does not contain its own headline, so this search is looking at nothing',
    );
    assert.ok(strings.length > 5, `the walk found only ${strings.length} strings in a whole report`);

    assert.ok(!serialized.includes(CREDENTIAL), 'the password is somewhere in the scan outcome');
    assert.ok(!serialized.includes(PAGILA_DSN), 'the whole connection string is in the scan outcome');

    // And the fields JSON.stringify would not have shown.
    for (const found of strings) {
      assert.ok(
        !found.includes(CREDENTIAL),
        `the password is inside a field of the outcome: ${found.slice(0, 80)}`,
      );
      assert.ok(
        !found.includes(PAGILA_DSN),
        `the connection string is inside a field of the outcome: ${found.slice(0, 80)}`,
      );
    }
  });

  it('does not hand the handle back a DSN either — the session survives its own scan', async () => {
    // A flow that closed the session on its way out would make the second
    // scan of a window fail for a reason nobody could see. Cheap to pin, and
    // it is the kind of thing that only shows up in a demo.
    const handle = openSession(PAGILA_DSN);
    const first = await runScanFlow(handle);
    const second = await runScanFlow(handle);

    assert.equal(first.kind, 'scanned');
    assert.equal(second.kind, 'scanned');
  });
});
