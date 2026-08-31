/**
 * The LEDAR desktop shell — FE slice 1.
 *
 * One window, one conversation, one screen wired to a real database: S2
 * "Connect safely". The window renders; this process owns everything with
 * consequences. Database work goes through @ledar/connector-postgres — the
 * same calls `npm run check:db` makes — via connect-flow.ts, which is the
 * file that will move behind the engine's HTTP boundary when the engine
 * grows a connect route. The renderer reaches all of it only through the
 * typed bridge in preload.cts.
 *
 * Window preferences are the non-negotiables from the _doc/17 audit:
 * sandbox on, context isolation on, node integration off, one preload,
 * local content only (serve.ts), and every escape hatch a web page might
 * use is closed in security.ts before any web contents exist.
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserWindow, app, protocol } from 'electron';

import { devPrefill } from './dev.js';
import { registerIpc } from './ipc.js';
import { hardenAllWebContents } from './security.js';
import { APP_ORIGIN, registerAppProtocol } from './serve.js';
import type { Layout } from './serve.js';
import { forgetObservations } from './profile-flow.js';
import { closeAllSessions } from './session.js';

/**
 * The two builds, and the single fact that tells them apart.
 *
 * `app.isPackaged` is Electron's own answer to "was this launched as
 * `electron <dir>` or as an installed executable". It is deliberately the
 * only input here: the alternative — probing the disk for whichever tree
 * happens to exist — would answer correctly on the development machine for
 * the same reason it would be useless there, and the MSIX handbook's second
 * conclusion is that a check which uses the build machine as evidence
 * proves nothing about anyone else's.
 *
 * ```text
 *              main entry                          package root
 * dev          apps/desktop/dist/node/main/main.js  apps/desktop
 * packaged     resources/app/main.js                resources/app
 * ```
 *
 * In the packaged tree the main process is ONE bundled file with its preload
 * and its `ui/` directory beside it, so the root is simply the directory the
 * bundle is in. That flatness is not tidiness: bundling is what removes the
 * need for `--conditions=ledar-built`, which is the condition Windows strips
 * out of `NODE_OPTIONS` in a packaged app. See infra/pack-msix/build.mjs.
 */
const LAYOUT: Layout = app.isPackaged ? 'packaged' : 'dev';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = LAYOUT === 'packaged' ? HERE : resolve(HERE, '..', '..', '..');
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const PRELOAD =
  LAYOUT === 'packaged'
    ? join(HERE, 'preload.cjs')
    : join(HERE, '..', 'preload', 'preload.cjs');

// Must run before app ready; a scheme registered later is not "standard"
// and the window would fall back to an opaque origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true } },
]);

// The window's icon, dev mode only. The packaged build does not need this:
// rcedit stamps the same .ico into LEDAR.exe at pack time, and Windows takes
// the taskbar/titlebar icon from the executable. In dev the executable is
// electron.exe, so without this line every `npm run desktop` window wears
// Electron's atom — which is exactly what the Licensor saw.
const DEV_ICON =
  LAYOUT === 'dev' ? join(REPO_ROOT, 'infra', 'pack-msix', 'assets', 'ledar.ico') : undefined;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    title: 'LEDAR',
    ...(DEV_ICON ? { icon: DEV_ICON } : {}),
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  void win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  hardenAllWebContents();

  const prefill = devPrefill(app.isPackaged, REPO_ROOT);
  registerIpc({
    devPrefill: prefill,
    onDevReport: (line) => {
      // The one line the smoke run exists to produce. Never a DSN, never a
      // secret — the renderer only ever reports verdict kind and headline.
      console.log(`[dev-smoke] ${line}`);
      if (prefill?.exitWhenProven === true) {
        setTimeout(() => app.quit(), 200);
      }
    },
  });

  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win !== undefined) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('window-all-closed', () => {
    // Windows-first product (_doc/17 §7); no macOS dock-lingering behaviour.
    app.quit();
  });

  // Every credential this process is holding, dropped before it exits.
  //
  // `will-quit` rather than `window-all-closed` because it is the one event on
  // the common path out: it fires for the menu, for the last window closing,
  // for `app.quit()` called from the smoke run, and for the OS asking the app
  // to stop. Hooking the window event instead would miss the quits that never
  // had a window to close.
  //
  // What this genuinely buys is the interval between the last window going
  // away and the process actually ending. A killed process needs no help —
  // its memory goes with it — but a process that lingers with a DSN in a Map
  // is a process that can still be attached to and dumped.
  app.on('will-quit', () => {
    closeAllSessions();
    // 🟥 The same argument, one step further in. What this holds is not a
    // credential but it is a description of somebody's private system — a
    // database fingerprint, five answers they gave, and the map of how their
    // tables connect. A process lingering with that in a module variable is a
    // process that can be attached to and dumped, exactly as above.
    //
    // Added 2026-08-28 because `profile-flow` already CLAIMED this in a
    // comment — "cleared by `forgetObservations` when a session closes" — and
    // nothing called it. The claim was written first and the call never
    // followed, so the state outlived every window for as long as the app ran.
    forgetObservations();
  });

  void app.whenReady().then(() => {
    registerAppProtocol(PACKAGE_ROOT, LAYOUT);
    createWindow();
  });
}
