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

/**
 * Which of the two trees this process is reading the page out of.
 *
 * 🟥 This type exists because of the failure mode the MSIX handbook records
 * at `_doc/so-tay-msix-store.md` §1: a lookup function with no branch for the
 * SHIPPED layout, which knows only an environment variable and the
 * development tree. In the package nothing matches, and the app reports that
 * it cannot find its own files — naming paths that do not exist on the user's
 * machine. It reads as a broken install rather than a missing branch.
 *
 * The two layouts are genuinely different trees, not one tree with a
 * different prefix:
 *
 * ```text
 * dev        apps/desktop/src/renderer/index.html   authored files
 *            apps/desktop/dist/web/…                tsc output, a sibling of src
 * packaged   resources/app/ui/index.html            both copied together, flat
 *            resources/app/ui/app/…                 beside the bundled main
 * ```
 *
 * The parameter is REQUIRED, with no default. A default would be a value that
 * is silently wrong in exactly one of the two builds, and the wrong one is the
 * build nobody runs from a terminal.
 */
export type Layout = 'dev' | 'packaged';

type PageFiles = {
  /** The document, relative to the root. */
  readonly html: string;
  /** Its stylesheet, relative to the root. */
  readonly css: string;
  /** The directory `/app/…` is served out of, relative to the root. */
  readonly scripts: string;
};

const LAYOUTS: Record<Layout, PageFiles> = {
  dev: {
    html: join('src', 'renderer', 'index.html'),
    css: join('src', 'renderer', 'styles.css'),
    scripts: join('dist', 'web'),
  },
  packaged: {
    html: join('ui', 'index.html'),
    css: join('ui', 'styles.css'),
    scripts: join('ui', 'app'),
  },
};

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
 *
 * The URLs are the same in both layouts. What the layout changes is only
 * which files those three URLs land on, so a page authored against `/` and
 * `/app/renderer/app.js` cannot tell which build it is running inside.
 */
export function resolveAppPath(
  packageRoot: string,
  pathname: string,
  layout: Layout,
): string | null {
  const clean = pathname.replace(/\\/g, '/');
  if (clean.includes('..') || clean.includes('\0')) return null;

  const files = LAYOUTS[layout];
  let rel: string | null = null;
  if (clean === '/' || clean === '/index.html') rel = files.html;
  else if (clean === '/styles.css') rel = files.css;
  else if (clean.startsWith('/app/')) rel = join(files.scripts, clean.slice('/app/'.length));
  if (rel === null) return null;

  const jail = resolve(packageRoot);
  const abs = resolve(jail, rel);
  if (abs !== jail && !abs.startsWith(jail + sep)) return null;
  return abs;
}
