/**
 * The credential half of `OperationSession` — a DSN, and nowhere for it to go.
 *
 * The window proves a connection once and then wants to do things with it.
 * The obvious wiring is for the renderer to keep the connection string and
 * send it back on the next call, and that wiring is what this file exists to
 * make impossible: a string that crosses the preload bridge has been in a web
 * page, and a credential that has been in a web page is a credential in every
 * crash dump, devtools heap snapshot and error report that page ever produces.
 *
 * So the DSN stops here. The renderer is handed a handle — a name for a
 * session it already watched being proved — and every later call names the
 * session instead of re-supplying the secret. `dsnFor` is the only way back
 * out and it is not reachable from the bridge; nothing in `preload.cts` or
 * `ipc.ts` returns it, logs it, or puts it in a message.
 *
 * The handle is not itself a secret. It is unguessable anyway, because
 * "unguessable" and "secret" solve different problems: a predictable handle
 * (a counter, a timestamp) is a handle some other webContents can *name*
 * without ever having been told it, and naming it is all an attacker needs.
 * `randomUUID` is CSPRNG-backed, so there is no sequence to walk.
 *
 * ⚠️ This is the credential half ONLY. Sol's audit of 2026-08-27 named three:
 * this one, a catalog epoch bound into anything sealed, and an egress
 * authority over what may leave the machine. The other two are absent because
 * nothing in this slice seals a rule or calls a model — see the note on
 * `SessionHandle` in `shared/ipc.ts`. Their absence is a scope boundary, not
 * an oversight, and this file must not be read as covering them.
 */

import { randomUUID } from 'node:crypto';

import type { SessionHandle } from '../shared/ipc.js';

/**
 * Handle → DSN, for the life of this process.
 *
 * A `Map` rather than a plain object, and not for style. A plain object
 * carries `Object.prototype`, so a lookup for `__proto__` or `constructor`
 * returns something truthy that was never put there — a handle nobody issued
 * that resolves anyway. A `Map` has no such keys, so an unissued handle
 * misses, which is the only answer this lookup is allowed to give.
 *
 * Module scope on purpose: this is the main process's memory, and there is
 * exactly one of it. Handing an instance around would let a second store be
 * constructed somewhere, and two stores means `closeAllSessions` empties one
 * of them while the other keeps holding a credential.
 */
const sessions = new Map<SessionHandle, string>();

/**
 * Records a DSN and returns the name the renderer will use for it.
 *
 * ⚠️ Call this ONLY where the database itself has just refused a write —
 * `connect-flow.ts`, the `read_only_enforced` branch, and nowhere else. This
 * function cannot check that for itself: by the time a string arrives here
 * the proof has already happened somewhere else, and a parameter claiming it
 * happened would be a label rather than a gate (AGENTS.md §4.23). The gate is
 * that there is one call site and it is the branch that holds the evidence.
 */
export function openSession(dsn: string): SessionHandle {
  if (typeof dsn !== 'string' || dsn.trim().length === 0) {
    // No DSN in the message, here or anywhere else in this file. This throw
    // travels up through `runConnectFlow`'s catch and becomes a `connect_error`
    // the window renders, so anything written into it is on screen.
    throw new Error('refused: a session cannot be opened without a connection string');
  }

  const handle = randomUUID();
  sessions.set(handle, dsn);
  return handle;
}

/**
 * The DSN behind a handle, or null if there is none.
 *
 * Main process only. Null covers every way of not having one — a handle that
 * was closed, a handle from a previous run of the app, a handle nobody ever
 * issued — deliberately with no way to tell them apart. A caller that could
 * distinguish "closed" from "never existed" would be an oracle for which
 * handles are real, which is the one thing a handle's unguessability is
 * protecting.
 */
export function dsnFor(handle: SessionHandle): string | null {
  return sessions.get(handle) ?? null;
}

/** Forgets one session. Closing a handle that is not open is not an error. */
export function closeSession(handle: SessionHandle): void {
  sessions.delete(handle);
}

/**
 * Forgets every session. Wired to app quit in `main.ts`.
 *
 * Dropping the references is the whole of what this can do — JavaScript
 * strings are immutable, so there is no buffer to overwrite and claiming to
 * "wipe" the DSN would be describing work that does not happen. What it
 * genuinely buys is the quit path where the process lingers: no window, no
 * session, nothing left holding a credential while the app winds down.
 */
export function closeAllSessions(): void {
  sessions.clear();
}

/**
 * How many sessions are open.
 *
 * Exists so the count is observable rather than inferred. A test that opens
 * two and closes one can say so; without this the only evidence that
 * `closeAllSessions` did anything would be that some other call started
 * failing, which is a much weaker thing to assert.
 */
export function sessionCount(): number {
  return sessions.size;
}
