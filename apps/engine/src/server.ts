/**
 * The engine as its own process — HS-A A.3.
 *
 * `_doc` and the plan both say the same thing about this boundary: *the engine
 * does not know what shell is in front of it.* Today that shell is a command
 * line; the audience this product is for (AGENTS.md §2 — somebody responsible
 * for a database they do not understand) cannot use a command line, so there
 * will be another one. Putting the engine behind HTTP now is what stops the
 * eventual UI from being welded to the CLI's internals.
 *
 * ## Not a second code path
 *
 * Every route here is a thin wrapper over the same seven packages the CLI
 * calls. Nothing about scanning, comparing, or reading history lives in this
 * file. That was worth a refactor before writing it: the history-assembly half
 * of `apps/cli/src/diff.ts` moved into `@ledar/store` as `HistoryTimeline`,
 * because the alternative was this file growing its own copy — which is how
 * two answers to "which runs exist" start disagreeing.
 *
 * ## Security is not optional here and is not in this file
 *
 * See `guard.ts`. Hard rule 7: 127.0.0.1 is not authentication. Bind, headers
 * and token each answer a different attacker, and the one that is easy to
 * forget is DNS rebinding.
 *
 *     npm run engine
 */

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import { HistoryTimeline, diffRuns } from '@ledar/store';

import { guard } from './guard.js';

/** Loopback only. Never 0.0.0.0, never `::` — see guard.ts. */
const BIND = '127.0.0.1';

/**
 * Port 0 asks the operating system for a free one.
 *
 * A fixed port is a port anything can guess and probe. It is a small defence
 * on its own — it does not stop a scan of the ephemeral range — and it is
 * listed as E.2 beside the header check because the two are the same idea:
 * make the engine hard to reach by accident, and impossible to reach by a page
 * that reached it on purpose.
 */
const PORT = Number(process.env.LEDAR_ENGINE_PORT ?? 0);

/** Where the scan history lives. Same rule as the CLI; see apps/cli/src/paths.ts. */
function historyFile(): string {
  const named = process.env.LEDAR_HISTORY_DB?.trim();
  if (named) return resolve(named);
  const home = process.env.LOCALAPPDATA?.trim() || process.env.HOME || '.';
  return join(home, 'ledar', 'history.db');
}

type Handler = (url: URL) => unknown;

function routes(): Record<string, Handler> {
  return {
    '/health': () => ({ ok: true, service: 'ledar-engine' }),

    '/runs': (url) => {
      const history = HistoryTimeline.open(historyFile());
      try {
        if (history.isEmpty) return { files: [], runs: [] };
        const want = url.searchParams.get('database') ?? undefined;
        return {
          files: history.files,
          fingerprint: want ?? history.newestFingerprint(),
          runs: history.entries(want).map((e) => ({
            handle: e.handle,
            runId: e.run.runId,
            label: e.run.label,
            startedAt: e.run.startedAt,
            outcome: e.run.outcome,
            findingCount: e.run.findingCount,
            source: e.source,
          })),
        };
      } finally {
        history.close();
      }
    },

    '/diff': (url) => {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (from === null || to === null) {
        throw new BadRequest('both `from` and `to` are required, as run handles from /runs');
      }
      const history = HistoryTimeline.open(historyFile());
      try {
        const before = history.snapshotOf(from);
        const after = history.snapshotOf(to);
        if (before === null) throw new BadRequest(`there is no run \`${from}\``);
        if (after === null) throw new BadRequest(`there is no run \`${to}\``);
        // Every judgement, every caution and every limit comes from the store.
        // This route decides nothing about what a difference means.
        return diffRuns(before, after);
      } finally {
        history.close();
      }
    },
  };
}

class BadRequest extends Error {}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  // Length declared rather than left to chunked encoding. The body is a
  // finite string that is already in memory, so there is nothing to stream —
  // and a caller reading the socket directly should not have to un-chunk a
  // two-line JSON object to find out it was refused.
  res.writeHead(status, {
    'content-length': Buffer.byteLength(text, 'utf8'),
    'content-type': 'application/json; charset=utf-8',
    // No caller of this engine is a browser (guard.ts), so none of these are
    // load-bearing. They are here so that stays true if one ever arrives by
    // mistake rather than by design.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

export function start(port = PORT): Promise<{ port: number; token: string; close: () => void }> {
  // 32 bytes from the OS CSPRNG. Held in memory only: written to a file it
  // becomes a secret with a lifetime, and printed once it belongs to whoever
  // started the process.
  const token = randomBytes(32).toString('base64url');
  const table = routes();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const bound = server.address();
    const actual = typeof bound === 'object' && bound !== null ? bound.port : port;

    const verdict = guard({ headers: req.headers }, actual, token);
    if (!verdict.ok) {
      // The reason is returned because the only caller who can read it is one
      // already on this machine, and a refusal nobody can diagnose becomes a
      // refusal somebody disables. It never names the token.
      send(res, verdict.status, { error: verdict.reason });
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', `http://${BIND}:${actual}`);
    } catch {
      send(res, 400, { error: 'unreadable request path' });
      return;
    }

    const handler = table[url.pathname];
    if (handler === undefined) {
      send(res, 404, { error: `no route ${url.pathname}`, routes: Object.keys(table) });
      return;
    }

    try {
      send(res, 200, handler(url));
    } catch (err) {
      if (err instanceof BadRequest) {
        send(res, 400, { error: err.message });
        return;
      }
      // Deliberately not the stack, and deliberately not `err.message` from an
      // unknown throw: a path or a DSN can end up in either.
      console.error('  engine: unhandled error on', url.pathname, err);
      send(res, 500, { error: 'the engine failed to answer; see its output' });
    }
  });

  return new Promise((ready) => {
    server.listen(port, BIND, () => {
      const bound = server.address();
      const actual = typeof bound === 'object' && bound !== null ? bound.port : port;
      ready({ port: actual, token, close: () => server.close() });
    });
  });
}
