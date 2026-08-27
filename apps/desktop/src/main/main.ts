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
import { closeAllSessions } from './session.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // .../dist/node/main
const PACKAGE_ROOT = resolve(HERE, '..', '..', '..'); // .../apps/desktop
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..');
const PRELOAD = join(HERE, '..', 'preload', 'preload.cjs');

// Must run before app ready; a scheme registered later is not "standard"
// and the window would fall back to an opaque origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true } },
]);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 640,
    title: 'LEDAR',
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
  });

  void app.whenReady().then(() => {
    registerAppProtocol(PACKAGE_ROOT);
    createWindow();
  });
}
