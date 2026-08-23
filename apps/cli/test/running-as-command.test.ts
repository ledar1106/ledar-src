/**
 * N25, second half — the `realpathSync` branch nothing had ever executed.
 *
 * Every CLI entry point ends with `if (runningAsCommand(import.meta.url))`.
 * Get it wrong in the false direction and the command does nothing and says
 * nothing, which is worse than a crash; get it wrong in the true direction
 * and importing the module to read one helper runs the whole program against
 * the operator's real history.
 *
 * The fast path — `resolve(entry) === self` — is exercised by every suite
 * that spawns a command, which is most of them. The fallback is not. It only
 * runs when the two paths are different spellings of the same file, and no
 * test had ever produced that situation, so the branch that catches a shim on
 * PATH or a checkout behind a symlink had never once run.
 *
 * It can be reached now because `entry` is a parameter. It used to be read
 * from `process.argv[1]` inside the function, which meant the only way to
 * test the branch was to arrange a symlinked checkout and re-run the whole
 * suite from inside it.
 *
 * There were also two copies of the function, in `export-evidence.ts` and
 * `diff.ts`. The second was written later and had already lost the comment
 * explaining why `realpathSync` is there at all.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

import { runningAsCommand } from '../src/paths.js';

const SELF_URL = new URL('../src/paths.ts', import.meta.url).href;
const SELF = fileURLToPath(SELF_URL);
const SRC = dirname(SELF);

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

describe('the path a command is recognised by', () => {
  it('says yes when the entry point IS the file, spelled the same way', () => {
    assert.equal(runningAsCommand(SELF_URL, SELF), true);
  });

  it('says yes for a relative spelling of the same file', () => {
    // `resolve` settles this one without touching the filesystem, which is
    // why it is the fast path.
    const cwdRelative = SELF.replace(`${resolve('.')}\\`, '').replace(`${resolve('.')}/`, '');
    assert.equal(runningAsCommand(SELF_URL, cwdRelative), true);
  });

  it('says no for a different file', () => {
    assert.equal(runningAsCommand(SELF_URL, join(SRC, 'scan.ts')), false);
  });

  it('says no when nothing was passed at all', () => {
    // `process.argv[1]` is undefined when Node is given code rather than a
    // file. A module loaded that way is not the program.
    assert.equal(runningAsCommand(SELF_URL, undefined), false);
  });

  it('🟥 says yes through a symlinked directory — the branch nothing had run', () => {
    // A junction on Windows, a directory symlink elsewhere. Both are creatable
    // without elevation, which is what lets this test run on either and not
    // become a skip — and a skip is what left this branch unchecked in the
    // first place.
    const base = mkdtempSync(join(tmpdir(), 'ledar-link-'));
    dirs.push(base);
    const link = join(base, 'src');
    try {
      symlinkSync(SRC, link, 'junction');
    } catch {
      // If the platform refuses even a junction there is nothing honest to
      // assert, and pretending otherwise is how a branch stays unmeasured.
      assert.fail(
        'could not create a directory link, so the realpath branch is still unproven here',
      );
    }

    const throughLink = join(link, 'paths.ts');
    // The premise: the two strings really are different, so the fast path
    // cannot be what answers. Without this the test would still pass if
    // `resolve` happened to collapse the link.
    assert.notEqual(resolve(throughLink), SELF);
    assert.equal(runningAsCommand(SELF_URL, throughLink), true);
  });

  it('says no for a path that does not exist, instead of throwing', () => {
    // `realpathSync` throws on a missing path. A CLI that crashes while
    // deciding whether it is a CLI fails before it can say anything useful.
    assert.equal(runningAsCommand(SELF_URL, join(SRC, 'no-such-file.ts')), false);
  });
});
