/**
 * The window's own origin: `app://ledar`.
 *
 * The renderer is not loaded from `file://` — a `file://` page has an opaque
 * origin, which makes two security tools blunt: the IPC layer cannot name the
 * caller it expects, and a Content-Security-Policy cannot say 'self' and mean
 * anything. A registered standard scheme gives the window a real origin, and
 * everything else (sender checks in ipc.ts, the CSP header here) hangs off it.
 *
 * The path policy — what exists on this origin at all — lives in
 * serve-paths.ts, where the test suite can reach it without a window.
 */

import { readFile } from 'node:fs/promises';

import { protocol } from 'electron';

import { APP_HOST, CSP, mimeFor, resolveAppPath } from './serve-paths.js';

export { APP_HOST, APP_ORIGIN, CSP } from './serve-paths.js';

export function registerAppProtocol(packageRoot: string): void {
  protocol.handle('app', async (request) => {
    const refuse = (status: number): Response => new Response(null, { status });
    try {
      const url = new URL(request.url);
      if (url.host !== APP_HOST) return refuse(404);

      const file = resolveAppPath(packageRoot, decodeURIComponent(url.pathname));
      if (file === null) return refuse(404);

      const type = mimeFor(file);
      if (type === null) return refuse(404);

      const body = await readFile(file);
      return new Response(body, {
        headers: {
          'content-type': type,
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'cache-control': 'no-store',
        },
      });
    } catch {
      return refuse(404);
    }
  });
}
