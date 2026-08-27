/**
 * The app:// origin serves an allowlist, and this is the allowlist saying no.
 *
 * The refusals matter more than the map: a renderer that can read one file
 * outside its three shapes can read any file the process can, and the
 * process is the user. Every case here runs without Electron — the policy
 * was split into serve-paths.ts for exactly that reason.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sep } from 'node:path';

import { mimeFor, resolveAppPath } from '../src/main/serve-paths.js';

const ROOT = sep === '\\' ? 'C:\\repo\\apps\\desktop' : '/repo/apps/desktop';

function rel(resolved: string | null): string | null {
  if (resolved === null) return null;
  return resolved.slice(ROOT.length + 1).split(sep).join('/');
}

describe('resolveAppPath', () => {
  it('maps exactly the three shapes the page is made of', () => {
    assert.equal(rel(resolveAppPath(ROOT, '/')), 'src/renderer/index.html');
    assert.equal(rel(resolveAppPath(ROOT, '/index.html')), 'src/renderer/index.html');
    assert.equal(rel(resolveAppPath(ROOT, '/styles.css')), 'src/renderer/styles.css');
    assert.equal(rel(resolveAppPath(ROOT, '/app/renderer/app.js')), 'dist/web/renderer/app.js');
    assert.equal(rel(resolveAppPath(ROOT, '/app/shared/ipc.js')), 'dist/web/shared/ipc.js');
  });

  it('refuses everything off the map', () => {
    assert.equal(resolveAppPath(ROOT, '/package.json'), null);
    assert.equal(resolveAppPath(ROOT, '/src/main/main.ts'), null);
    assert.equal(resolveAppPath(ROOT, '/app'), null);
    assert.equal(resolveAppPath(ROOT, ''), null);
  });

  it('refuses traversal in every spelling', () => {
    assert.equal(resolveAppPath(ROOT, '/app/../../../infra/.env'), null);
    assert.equal(resolveAppPath(ROOT, '/app/..'), null);
    assert.equal(resolveAppPath(ROOT, '/..'), null);
    assert.equal(resolveAppPath(ROOT, '\\app\\..\\secrets'), null);
    assert.equal(resolveAppPath(ROOT, '/app/a\0b.js'), null);
  });

  it('is case-sensitive about its own prefixes even on a case-folding disk', () => {
    assert.equal(resolveAppPath(ROOT, '/APP/renderer/app.js'), null);
    assert.equal(resolveAppPath(ROOT, '/Index.html'), null);
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
