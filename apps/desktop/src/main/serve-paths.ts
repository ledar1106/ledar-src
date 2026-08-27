/**
 * The path policy of the app:// origin, with no Electron in sight.
 *
 * Split from serve.ts so the refusals — traversal, smuggled absolute paths,
 * anything off the map — can be exercised by the test suite under plain
 * Node. serve.ts owns the wire; this file owns the decision.
 */

import { extname, join, resolve, sep } from 'node:path';

export const APP_HOST = 'ledar';
export const APP_ORIGIN = `app://${APP_HOST}`;

/**
 * One policy, sent as a header on every response and mirrored as a <meta>
 * in index.html. No remote anything: scripts, styles and images come from
 * this scheme, nothing connects out, nothing embeds this window.
 */
export const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
};

export function mimeFor(file: string): string | null {
  return MIME[extname(file).toLowerCase()] ?? null;
}

/**
 * Pathname -> absolute file, or null for anything off the map.
 *
 * The handler serves an allowlist, not a directory. Three shapes exist —
 * the page, its stylesheet, and the compiled scripts under /app/ — and a
 * request for anything else is a 404, path traversal included. The jail
 * check under the allowlist is a second lock on a door the allowlist
 * already shut: cheap, and it stays shut if the allowlist ever widens.
 */
export function resolveAppPath(packageRoot: string, pathname: string): string | null {
  const clean = pathname.replace(/\\/g, '/');
  if (clean.includes('..') || clean.includes('\0')) return null;

  let rel: string | null = null;
  if (clean === '/' || clean === '/index.html') rel = join('src', 'renderer', 'index.html');
  else if (clean === '/styles.css') rel = join('src', 'renderer', 'styles.css');
  else if (clean.startsWith('/app/')) rel = join('dist', 'web', clean.slice('/app/'.length));
  if (rel === null) return null;

  const jail = resolve(packageRoot);
  const abs = resolve(jail, rel);
  if (abs !== jail && !abs.startsWith(jail + sep)) return null;
  return abs;
}
