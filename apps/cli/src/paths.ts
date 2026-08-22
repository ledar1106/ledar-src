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

import { homedir } from 'node:os';
import { join } from 'node:path';

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
