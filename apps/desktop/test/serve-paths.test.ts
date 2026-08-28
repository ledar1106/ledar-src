/**
 * The app:// origin serves an allowlist, and this is the allowlist saying no.
 *
 * The refusals matter more than the map: a renderer that can read one file
 * outside its three shapes can read any file the process can, and the
 * process is the user. Every case here runs without Electron — the policy
 * was split into serve-paths.ts for exactly that reason.
 *
 * Since 2026-08-28 every case runs TWICE, once per layout. The packaged tree
 * is a second set of paths that no one reaches from a terminal, so it is the
 * one that would rot unwatched; running the refusals against it costs a loop
 * and closes the gap where a traversal is rejected in development and
 * accepted in the build people install.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sep } from 'node:path';

import { mimeFor, resolveAppPath } from '../src/main/serve-paths.js';
import type { Layout } from '../src/main/serve-paths.js';

const ROOT = sep === '\\' ? 'C:\\repo\\apps\\desktop' : '/repo/apps/desktop';

function rel(resolved: string | null): string | null {
  if (resolved === null) return null;
  return resolved.slice(ROOT.length + 1).split(sep).join('/');
}

const LAYOUTS: readonly Layout[] = ['dev', 'packaged'];

/** What the three URLs land on, per layout. Written out, not derived. */
const EXPECTED: Record<Layout, { html: string; css: string; script: string }> = {
  dev: {
    html: 'src/renderer/index.html',
    css: 'src/renderer/styles.css',
    script: 'dist/web/renderer/app.js',
  },
  packaged: {
    html: 'ui/index.html',
    css: 'ui/styles.css',
    script: 'ui/app/renderer/app.js',
  },
};

describe('resolveAppPath', () => {
  for (const layout of LAYOUTS) {
    const want = EXPECTED[layout];

    it(`${layout}: maps exactly the three shapes the page is made of`, () => {
      assert.equal(rel(resolveAppPath(ROOT, '/', layout)), want.html);
      assert.equal(rel(resolveAppPath(ROOT, '/index.html', layout)), want.html);
      assert.equal(rel(resolveAppPath(ROOT, '/styles.css', layout)), want.css);
      assert.equal(rel(resolveAppPath(ROOT, '/app/renderer/app.js', layout)), want.script);
    });

    it(`${layout}: refuses everything off the map`, () => {
      assert.equal(resolveAppPath(ROOT, '/package.json', layout), null);
      assert.equal(resolveAppPath(ROOT, '/src/main/main.ts', layout), null);
      assert.equal(resolveAppPath(ROOT, '/app', layout), null);
      assert.equal(resolveAppPath(ROOT, '', layout), null);
    });

    it(`${layout}: refuses traversal in every spelling`, () => {
      assert.equal(resolveAppPath(ROOT, '/app/../../../infra/.env', layout), null);
      assert.equal(resolveAppPath(ROOT, '/app/..', layout), null);
      assert.equal(resolveAppPath(ROOT, '/..', layout), null);
      assert.equal(resolveAppPath(ROOT, '\\app\\..\\secrets', layout), null);
      assert.equal(resolveAppPath(ROOT, '/app/a\0b.js', layout), null);
    });

    it(`${layout}: is case-sensitive about its own prefixes even on a case-folding disk`, () => {
      assert.equal(resolveAppPath(ROOT, '/APP/renderer/app.js', layout), null);
      assert.equal(resolveAppPath(ROOT, '/Index.html', layout), null);
    });
  }

  it('the two layouts are actually different trees', () => {
    // Guards the SHAPE of the fix rather than its values. If a later edit
    // collapses the packaged branch back onto the development one — the state
    // this file exists because of — every assertion above still passes, since
    // both layouts would then be checked against the same paths.
    for (const url of ['/', '/styles.css', '/app/renderer/app.js']) {
      assert.notEqual(
        resolveAppPath(ROOT, url, 'dev'),
        resolveAppPath(ROOT, url, 'packaged'),
        `${url} resolves to the same file in both layouts`,
      );
    }
  });

  it('the shipped layout keeps the whole page under one directory', () => {
    // Why the pack script can copy the UI in a single step: three URLs, one
    // folder. If a path ever escapes `ui/`, infra/pack-msix/build.mjs starts
    // shipping an app that is missing a file, and the window says so with a
    // path that does not exist on the machine reading it.
    for (const url of ['/', '/styles.css', '/app/renderer/app.js']) {
      const got = rel(resolveAppPath(ROOT, url, 'packaged'));
      assert.ok(got?.startsWith('ui/'), `${url} -> ${got ?? 'null'} is outside ui/`);
    }
  });
});

describe('mimeFor', () => {
  it('knows the five types the page uses and nothing else', () => {
    assert.match(mimeFor('a.html') ?? '', /^text\/html/);
    assert.match(mimeFor('a.js') ?? '', /^text\/javascript/);
    assert.match(mimeFor('a.css') ?? '', /^text\/css/);
    assert.equal(mimeFor('a.exe'), null);
    assert.equal(mimeFor('a'), null);
  });
});
