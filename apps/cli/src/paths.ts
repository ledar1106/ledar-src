/**
 * Where this product is allowed to put a file on somebody's machine.
 *
 * One copy, deliberately. There were two: `historyFile()` in `scan.ts` and
 * `dataDir()` in `export-evidence.ts`, character for character the same three
 * platform branches. They were written a slice apart and neither knew about
 * the other, which is how the redaction rule came to exist in three versions
 * that agreed until they did not.
 *
 * What made this pair worse than an ordinary duplicate is that the two copies
 * ended up guarded unevenly: the export side gained property tests, and the
 * scan side had none, because every scan test sets `LEDAR_HISTORY_DB` and
 * never reaches the default. The unguarded copy is the one that would have
 * drifted, and nothing would have said so.
 *
 * The rule itself: never the working directory. A file that lands wherever
 * the terminal happened to be standing is a file that gets committed by
 * accident, and both of the things placed by this module — a scan history and
 * an Evidence Pack — are records of somebody's database.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The platform's own directory for application data.
 *
 * The three arguments exist so the rule can be asked what a Mac would answer
 * from a machine that is not a Mac. Their defaults are the real values, so
 * every call site in the product reads as if they were not there.
 */
export function dataDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === 'win32') {
    return env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    // No variable moves this one. macOS has no XDG convention, and a
    // LOCALAPPDATA on a Mac is somebody's cross-platform toolchain rather than
    // a statement about where their data should go. Moving it means moving
    // `HOME`, which is worth knowing before writing a test that tries.
    return join(home, 'Library', 'Application Support');
  }
  return env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
}

/** Everything this product writes lives under one directory, named once. */
export function ledarDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  return join(dataDir(platform, env, home), 'ledar');
}

/**
 * Whether this module is being run as a command rather than imported.
 *
 * Every CLI entry point needs it, because the alternative — calling `main()`
 * unconditionally at module load — means a test that imports the module to
 * ask what one of its helpers returns instead RUNS the command: opens the
 * operator's real history, writes a real file into their real data
 * directory. The exact accident those helpers exist to describe.
 *
 * There were two copies of this, in `export-evidence.ts` and in `diff.ts`,
 * and the second was mine. Identical logic, except the copy had lost the
 * comment explaining why `realpathSync` is there — which is how a duplicate
 * decays into something nobody dares touch.
 *
 * `selfUrl` is the caller's `import.meta.url`; `entry` is what the runtime
 * was pointed at. `entry` is a parameter rather than read here so the
 * symlink branch below can be reached by a test, which it could not be for as
 * long as both values came from the process.
 */
export function runningAsCommand(
  selfUrl: string,
  entry: string | undefined = process.argv[1],
): boolean {
  if (entry === undefined) return false;

  const self = fileURLToPath(selfUrl);
  if (resolve(entry) === self) return true;

  // A shim on PATH, or a checkout reached through a symlinked directory: the
  // same file spelled differently. `realpathSync` also settles the case of a
  // Windows drive letter, which a string comparison does not.
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}
