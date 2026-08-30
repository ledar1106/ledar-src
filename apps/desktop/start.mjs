/**
 * Opens the LEDAR window from a source checkout.
 *
 *     npm run desktop
 *
 * ## Why this file exists, and why it is HERE rather than under infra/
 *
 * Measured 2026-08-31 by cloning the public repository into an empty
 * directory and running `npm ci` as a stranger would. It installed cleanly —
 * 47 packages, 5 seconds — `npm run typecheck` passed, and `npm test:offline`
 * ran 675 tests green. And there was no way whatsoever to open the window:
 *
 *     the launcher lived in infra/, which never leaves the private repo
 *     package.public.json had no `desktop` script at all
 *     electron's binary was not downloaded (see below)
 *     the README said there was no product code in the repository
 *
 * Four separate reasons, any one of them enough. So the launcher moved here,
 * where `apps/desktop/**` already ships, and `infra/run-desktop.mjs` now calls
 * this same function rather than carrying a second copy. A launcher the
 * private repo never runs is a launcher nobody checks.
 *
 * ## The condition, and why it is opt-IN
 *
 * Every `packages/*` declares `"main": "src/index.ts"` so the repo runs from
 * source and `npm test` exercises the working tree. Electron's main process is
 * plain Node with no TypeScript loader, so it cannot follow that. The break is
 * INSIDE the package graph — `packages/store/dist/index.js` imports
 * `@ledar/contracts` by bare specifier, which resolves to `src/index.ts` —
 * so importing a dist path from the desktop does not avoid it.
 *
 * The packages therefore carry a conditional `exports` map:
 *
 *     default        -> ./src/index.ts     tsx, tests, the CLI: unchanged
 *     ledar-built    -> ./dist/index.js    plain Node, i.e. Electron
 *
 * The obvious inverse — dist by default, source behind a flag — was measured
 * and rejected: tsx does not honour a `tsx` condition, so it would take the
 * default too, and `npm test` would start testing the last BUILD instead of
 * the working tree. A stale dist then makes the suite pass while the source is
 * broken, and nothing says so. Inverted, the worst case is loud: forget the
 * condition and the app fails to start with a module error naming the file.
 *
 * ⚠️ This is the DEVELOPMENT path. A packaged build does not come through
 * here: Windows strips `NODE_OPTIONS`, so `infra/pack-msix/build.mjs` bundles
 * the main process with esbuild and there is no resolution left to get wrong
 * at run time. Editing this file changes development only.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

/**
 * 🟥 Electron 44 has NO `postinstall`.
 *
 * It exposes `install-electron` as a bin instead, so `npm ci` installs the
 * JavaScript wrapper and leaves `dist/electron.exe` absent. Measured on a
 * clean clone: `npm ci` finished in 5 seconds having downloaded no binary at
 * all, and reported success.
 *
 * That is not a broken machine and not a proxy — it is how this version
 * ships, so it happens to everyone. A checkout where `npm ci` "worked" and
 * the app cannot start is the exact shape of failure this repository keeps
 * writing down, so the launcher fixes it rather than explaining it.
 */
function electronBinary() {
  const entry = require.resolve('electron');
  const pkgDir = dirname(entry);
  const binary = join(pkgDir, 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (existsSync(binary)) return require('electron');

  console.log('');
  console.log('  Electron is installed but its binary was never downloaded.');
  console.log('  Electron 44 has no postinstall step, so `npm ci` does not fetch it.');
  console.log('  Fetching it now, once (about 100 MB)...');
  console.log('');

  const install = spawn(process.execPath, [join(pkgDir, 'install.js')], {
    stdio: 'inherit',
    cwd: pkgDir,
  });
  return new Promise((resolve, reject) => {
    install.on('exit', (code) => {
      if (code === 0 && existsSync(binary)) {
        resolve(require('electron'));
        return;
      }
      // Named, not swallowed. Somebody offline or behind a proxy needs to see
      // which step failed, not a window that never appears.
      reject(
        new Error(
          'Could not download the Electron binary. Run it directly to see why:\n' +
            `    node "${join(pkgDir, 'install.js')}"`,
        ),
      );
    });
  });
}

/**
 * Starts the window and resolves with its exit code.
 *
 * `extraEnv` is how `infra/run-desktop.mjs` adds a development model key. A
 * public checkout passes nothing, which is the shipping behaviour: no key,
 * and the screen asks for one.
 */
export async function launch(extraEnv = {}, argv = []) {
  const electron = await electronBinary();

  const child = spawn(electron, ['apps/desktop', ...argv], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...extraEnv,
      // Appended, not replaced: a developer may already be passing something,
      // and clobbering their flags to add ours is the kind of helpfulness that
      // costs an afternoon.
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=ledar-built`.trim(),
    },
  });

  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      // Signals are not exit codes. Reporting a killed process as exit 0 is
      // how a smoke run comes to read as a pass.
      resolve(signal !== null ? 1 : (code ?? 0));
    });
  });
}

// Run directly — `npm run desktop` in a public checkout.
if (process.argv[1] !== undefined && import.meta.url.endsWith('start.mjs')) {
  const invokedDirectly = process.argv[1].replace(/\\/g, '/').endsWith('apps/desktop/start.mjs');
  if (invokedDirectly) {
    process.exit(await launch({}, process.argv.slice(2)));
  }
}
