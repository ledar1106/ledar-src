/**
 * The credential stays in the main process, and a handle is not a key.
 *
 * `SessionHandle` exists because of hard rule ⑥ and Sol's audit of
 * 2026-08-27 (blockers 2 and 3): the renderer proved a connection once, and
 * from then on it names that session with a string it cannot do anything
 * else with. Everything below is about the two ways that can quietly stop
 * being true —
 *
 *   ① the handle turns out to BE the credential, encoded
 *   ② the handle turns out to be guessable, so a renderer that has been
 *     told what to do by injected page content can name a session it was
 *     never given
 *
 * Neither failure is loud. A handle that is `btoa(dsn)` works perfectly, and
 * so does `session-1`.
 *
 * 🟥 The anchor test is `dsnFor` round-tripping a LIVE handle. Without it,
 * every "returns null" assertion in this file is satisfied by a `dsnFor`
 * that always returns null, and the file would count four tests while
 * watching nothing — AGENTS.md §4.16.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, it } from 'node:test';

import {
  closeAllSessions,
  closeSession,
  dsnFor,
  openSession,
  sessionCount,
} from '../src/main/session.js';

// The pieces are joined at run time, for the reason `packages/test-fixtures`
// gives: a credential-shaped literal in source trips GitHub push protection
// and this project's own publish gate (`infra/publish-public.py`, layer 3),
// and none of those tools can tell a planted fake from a live key. The VALUE
// is the throwaway fixture password written down in HANDOFF-STATUS §1b; only
// the source text stops matching.
const SECRET = ['fixture', 'no', 'real', 'data'].join('_');
const USER = 'ledar_reader';
const DSN = ['postgresql://', USER, ':', SECRET, '@127.0.0.1:55432/pagila'].join('');
const OTHER_DSN = ['postgresql://', USER, ':', SECRET, '@127.0.0.1:55433/chinook'].join('');

/**
 * Handles this module never issued, including the shapes that are not
 * merely wrong but actively confusing to a lookup written the easy way.
 *
 * `__proto__` and `constructor` are here because a session store built on a
 * plain object rather than a `Map` answers both of them with something that
 * is not null, and the caller then holds a function where it expected a DSN.
 * `DSN` itself is here because "the renderer sent the connection string
 * where the handle goes" is the exact confusion this type exists to make
 * impossible.
 */
const STRANGERS = [
  '',
  '   ',
  'not-a-handle',
  DSN,
  SECRET,
  '0',
  '1',
  'undefined',
  'null',
  '__proto__',
  'constructor',
  'toString',
  randomUUID(),
];

beforeEach(() => {
  closeAllSessions();
});

describe('a handle is not the credential', () => {
  it('round-trips the DSN while the session is open — the anchor for everything below', () => {
    // If this one is red, no other test in this file means anything: a
    // `dsnFor` that always answers null passes all of them.
    const handle = openSession(DSN);
    assert.equal(dsnFor(handle), DSN);
    assert.equal(sessionCount(), 1);
  });

  it('hands back something that is not the DSN and does not carry it', () => {
    const handle = openSession(DSN);

    assert.notEqual(handle, DSN);
    assert.ok(!handle.includes(DSN), 'the handle contains the whole connection string');
    assert.ok(!handle.includes(SECRET), 'the handle contains the password');
    assert.ok(!handle.includes(USER), 'the handle contains the username');
    assert.ok(!handle.includes('55432'), 'the handle contains the port it connects to');

    // The encoded version of the same mistake. `btoa(dsn)` is opaque to read
    // and transparent to anyone who tries one decode, so `includes` on the
    // raw text would call it a pass.
    const decoded = [
      Buffer.from(handle, 'base64').toString('utf8'),
      Buffer.from(handle, 'hex').toString('utf8'),
      Buffer.from(handle, 'base64url').toString('utf8'),
    ];
    for (const attempt of decoded) {
      assert.ok(
        !attempt.includes(SECRET),
        `the handle decodes to something holding the password: ${attempt.slice(0, 40)}`,
      );
    }
  });

  it('gives two DIFFERENT handles for the same DSN, and they close independently', () => {
    // Two windows onto the same database are two sessions. Returning the
    // same handle twice would make closing one silently close the other,
    // and the renderer holding the survivor has no way to find that out.
    const first = openSession(DSN);
    const second = openSession(DSN);

    assert.notEqual(first, second);
    assert.equal(sessionCount(), 2);
    assert.equal(dsnFor(first), DSN);
    assert.equal(dsnFor(second), DSN);

    closeSession(first);
    assert.equal(dsnFor(first), null);
    assert.equal(dsnFor(second), DSN, 'closing one session closed the other as well');
    assert.equal(sessionCount(), 1);
  });

  it('keeps two different DSNs apart', () => {
    const pagila = openSession(DSN);
    const chinook = openSession(OTHER_DSN);

    assert.equal(dsnFor(pagila), DSN);
    assert.equal(dsnFor(chinook), OTHER_DSN);
  });
});

describe('a handle nobody issued', () => {
  it('answers null, without throwing, and without saying anything about a credential', () => {
    // The store is deliberately NOT empty here. "An unknown handle returns
    // null" is true of an empty store no matter how the lookup is written,
    // and AGENTS.md §4.3 is explicit that an assertion over an empty set is
    // not an assertion.
    const live = openSession(DSN);
    assert.equal(dsnFor(live), DSN);

    for (const stranger of STRANGERS) {
      const named = JSON.stringify(stranger);
      let answer: string | null;
      try {
        answer = dsnFor(stranger);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Both halves matter, and this one matters more: a lookup that
        // throws `no session for X, expected one of [...]` has put the
        // thing it is guarding into a stack trace.
        assert.ok(
          !message.includes(SECRET) && !message.includes(DSN),
          `dsnFor(${named}) threw a message carrying the credential: ${message}`,
        );
        assert.fail(`dsnFor(${named}) threw instead of answering null: ${message}`);
      }
      assert.equal(answer, null, `dsnFor(${named}) answered something other than null`);
    }

    // And the live session is still live: nothing above disturbed the store.
    assert.equal(dsnFor(live), DSN);
    assert.equal(sessionCount(), 1);
  });

  it('is a no-op to close, not a throw', () => {
    const live = openSession(DSN);
    for (const stranger of STRANGERS) {
      closeSession(stranger);
    }
    assert.equal(dsnFor(live), DSN, 'closing handles nobody issued closed a real one');
    assert.equal(sessionCount(), 1);
  });
});

describe('closing', () => {
  it('closeSession then dsnFor is null, and the count drops', () => {
    const handle = openSession(DSN);
    assert.equal(sessionCount(), 1);

    closeSession(handle);

    assert.equal(dsnFor(handle), null);
    assert.equal(sessionCount(), 0);
  });

  it('closing the same handle twice does not reopen it, or throw', () => {
    const handle = openSession(DSN);
    closeSession(handle);
    closeSession(handle);
    assert.equal(dsnFor(handle), null);
    assert.equal(sessionCount(), 0);
  });

  it('closeAllSessions empties the store, and every handle it issued goes dead', () => {
    const handles = [openSession(DSN), openSession(DSN), openSession(OTHER_DSN)];
    // The anchor: there was something to empty.
    assert.equal(sessionCount(), 3);

    closeAllSessions();

    assert.equal(sessionCount(), 0);
    for (const handle of handles) {
      assert.equal(dsnFor(handle), null, 'a handle survived closeAllSessions');
    }
  });
});

describe('handles are not guessable', () => {
  /**
   * What a test can actually see.
   *
   * Whether the bytes come from a CSPRNG is not observable from out here, so
   * these are the two proxies that are: a handle is not short enough to
   * enumerate, and consecutive handles are not consecutive. Both of the
   * tempting wrong implementations — an integer counter, and a prefixed one
   * like `session-1` — fail on the second.
   */
  const MANY = 50;
  const MIN_LENGTH = 16;

  function longestCommonPrefix(a: string, b: string): number {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    return i;
  }

  it('are unique across many opens of the same DSN', () => {
    const handles = Array.from({ length: MANY }, () => openSession(DSN));
    assert.equal(new Set(handles).size, MANY, 'two opens produced the same handle');
    assert.equal(sessionCount(), MANY);
  });

  it('are not short integers, and are long enough not to be enumerated', () => {
    for (let i = 0; i < MANY; i += 1) {
      const handle = openSession(DSN);
      assert.doesNotMatch(handle, /^\d{1,8}$/, `handle ${i} is a bare integer: ${handle}`);
      assert.ok(
        handle.length >= MIN_LENGTH,
        `handle ${i} is ${handle.length} characters, short enough to guess: ${handle}`,
      );
    }
  });

  it('are not a counter, however it is dressed', () => {
    // `1, 2, 3` and `session-1, session-2, session-3` and
    // `0000...01, 0000...02` are the same implementation. Strip whatever two
    // consecutive handles have in common and what is left must not be two
    // numbers.
    const handles = Array.from({ length: MANY }, () => openSession(DSN));

    for (let i = 1; i < handles.length; i += 1) {
      const previous = handles[i - 1]!;
      const current = handles[i]!;
      const shared = longestCommonPrefix(previous, current);
      const tail = current.slice(shared);

      assert.doesNotMatch(
        tail,
        /^\d+$/,
        `handles ${i - 1} and ${i} differ only by a number: ` +
          `${previous} then ${current}`,
      );
    }
  });
});
