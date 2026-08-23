/**
 * N25 — the branches that no suite could reach, and what they are for.
 *
 * Two test helpers decide where a child process should put its files by
 * looking at `process.platform`. Both have three branches, and on any one
 * machine exactly one of them can ever run. Two thirds of each helper was
 * therefore unchecked — not lightly checked, **unchecked** — and the debt was
 * still open after CI started running on Linux, because the two suites that
 * call those helpers skip without a fixture database.
 *
 * Running the branches would be easy and would prove almost nothing. What
 * makes them worth having is that each one has to **agree with the product**:
 * a redirect that sets `XDG_DATA_HOME` is only useful if `dataDir` reads
 * `XDG_DATA_HOME` on that platform. The two are written in different files by
 * different reasoning, and the day they stop agreeing, every assertion that
 * depends on redirecting a child's data directory quietly starts checking a
 * directory the child never used.
 *
 * So these tests do not ask "did the branch execute". They ask the product,
 * for each platform in turn: given this redirect, where would you put the
 * file — and is that inside the directory the test meant?
 *
 * The two helpers stay separate on purpose. `packRedirectFor` is about where
 * an Evidence Pack lands, `historyRedirectFor` about where a scan history
 * lands, and they are allowed to stop agreeing with each other. Only their
 * agreement with `dataDir` is mandatory, so only that is asserted here.
 */

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { dataDir, ledarDir } from '../src/paths.js';
import { packRedirectFor } from './export-evidence.test.js';
import { historyDirFor, historyRedirectFor } from './scan-default-history.test.js';

/** Every platform the product claims to place files on. */
const PLATFORMS: readonly NodeJS.Platform[] = ['win32', 'darwin', 'linux'];

/**
 * The home directory a child would report, given a redirect.
 *
 * Not invented: `os.homedir()` reads `USERPROFILE` on Windows and `HOME`
 * everywhere else, and a spawned child inherits exactly the variables the
 * redirect sets. Deriving it this way is what actually happens, so a test
 * that hard-coded `base` instead would pass even for a redirect that never
 * moved the child's home at all.
 */
function homeFrom(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  assert.ok(home, `the ${platform} redirect sets no home variable`);
  return home;
}

/**
 * Containment, with both sides spelled the same way.
 *
 * `dataDir` builds its answer with `node:path`, which uses the HOST's
 * separator whatever platform it was asked about — so on Windows,
 * `dataDir('darwin', …, '/tmp/probe')` comes back as
 * `\tmp\probe\Library\Application Support`. That is not a defect: the
 * platform argument exists so a test can ask, and production never passes a
 * foreign one. It does mean a raw prefix comparison is holding two spellings
 * of the same path against each other and calling them different — which is
 * exactly what this function did on its first run.
 */
function isInside(parent: string, child: string): boolean {
  const flat = (x: string): string => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const p = flat(parent);
  const c = flat(child);
  return c === p || c.startsWith(`${p}/`);
}

describe('the Evidence Pack redirect agrees with the product, on every platform', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: dataDir lands inside the directory the redirect named`, () => {
      const base = platform === 'win32' ? 'C:\\tmp\\probe' : '/tmp/probe';
      const env = packRedirectFor(base, platform);
      const landed = dataDir(platform, env, homeFrom(env, platform));

      assert.ok(
        isInside(base, landed),
        `${platform}: redirect ${JSON.stringify(env)} sends dataDir to ${landed}, ` +
          `which is not under ${base}`,
      );
    });
  }

  it('macOS is the one that reads no variable, and the redirect knows it', () => {
    // Worth its own assertion because it is the branch most likely to be
    // "fixed" by adding an XDG variable that macOS does not read. `dataDir`
    // says so in a comment; this says so in a way that fails.
    const env = packRedirectFor('/tmp/probe', 'darwin');
    assert.deepEqual(Object.keys(env).sort(), ['HOME']);
    assert.equal(
      dataDir('darwin', env, '/tmp/probe'),
      join('/tmp/probe', 'Library', 'Application Support'),
    );
  });

  it('Linux prefers XDG_DATA_HOME, and the redirect sets it', () => {
    const env = packRedirectFor('/tmp/probe', 'linux');
    assert.equal(env.XDG_DATA_HOME, '/tmp/probe');
    assert.equal(dataDir('linux', env, '/somewhere/else'), '/tmp/probe');
  });
});

describe('the scan-history redirect agrees with the product, on every platform', () => {
  for (const platform of PLATFORMS) {
    it(`${platform}: ledarDir lands exactly where the suite expects`, () => {
      const base = platform === 'win32' ? 'C:\\tmp\\probe' : '/tmp/probe';
      const env = historyRedirectFor(base, platform);
      const landed = ledarDir(platform, env, homeFrom(env, platform));

      // Not "inside base" — exactly the path the suite asserts against. That
      // suite reads `expectedLedarDir` and compares it to a path the child
      // printed, so a disagreement here is a suite comparing two strings that
      // were never about the same directory.
      assert.equal(landed, historyDirFor(base, platform));
    });
  }
});
