/**
 * The main-process side of the preload bridge.
 *
 * Every handler starts by asking who is calling. Hard rule 7 says loopback
 * is not authentication; the same reasoning applies one layer up — being
 * inside this Electron app is not authentication either. The caller must be
 * the top frame of the app's own origin, checked per message, so a
 * compromised iframe or a stray webContents cannot reach the database
 * through channels meant for the window.
 *
 * Payloads from the renderer are validated here as untrusted input. The
 * renderer is sandboxed and ours, but "ours" is exactly the claim this
 * boundary exists to not rely on.
 */

import { clipboard, ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

import { CHANNELS } from '../shared/ipc.js';
import type {
  ConnectOutcome,
  DevPrefill,
  GuideBundle,
  ScanOutcome,
  SessionHandle,
} from '../shared/ipc.js';
import { guideBundle, runConnectFlow } from './connect-flow.js';
import { runScanFlow } from './scan-flow.js';
import { closeSession } from './session.js';
import { APP_ORIGIN } from './serve.js';

/** Longest text the copy button will place on the clipboard. */
const MAX_COPY_LENGTH = 200_000;

/** Longest smoke-report line worth printing. */
const MAX_REPORT_LENGTH = 500;

function fromAppWindow(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  const frame = event.senderFrame;
  if (frame === null || frame !== event.sender.mainFrame) return false;
  return frame.url === `${APP_ORIGIN}/` || frame.url.startsWith(`${APP_ORIGIN}/`);
}

function assertAppWindow(event: IpcMainInvokeEvent): void {
  if (!fromAppWindow(event)) {
    // The refusal names no channel and carries no detail on purpose.
    throw new Error('refused: caller is not the application window');
  }
}

export function registerIpc(opts: {
  devPrefill: DevPrefill;
  onDevReport: (line: string) => void;
}): void {
  // One connection attempt at a time. The button disables in the renderer,
  // but the renderer's discipline is not this boundary's to assume.
  let connecting = false;

  // Likewise for the scan, which is the expensive one: it is somebody else's
  // database paying for it, and two concurrent scans would spend two budgets
  // while the window shows one.
  let scanning = false;

  /**
   * The session this window is currently working in, if any.
   *
   * Tracked here because this is the layer that knows a window has one
   * conversation at a time. A person who connects a second time has moved on
   * from the first database, and the credential for it should not stay in
   * memory just because nothing thought to drop it — the connection between
   * "the renderer forgot that handle" and "this process forgot that DSN" has
   * to be made by something, and the renderer is not something this boundary
   * gets to rely on.
   */
  let issued: SessionHandle | null = null;

  ipcMain.handle(CHANNELS.guide, (event): GuideBundle => {
    assertAppWindow(event);
    return guideBundle();
  });

  ipcMain.handle(
    CHANNELS.connect,
    async (event, dsn: unknown): Promise<ConnectOutcome> => {
      assertAppWindow(event);
      if (connecting) {
        return {
          kind: 'connect_error',
          message: 'A connection attempt is already running. Wait for it to finish.',
        };
      }
      connecting = true;
      try {
        const outcome = await runConnectFlow(dsn);
        if (outcome.kind === 'read_only_enforced') {
          // The new handle first, then forget the old one. In that order: the
          // flow has already minted the new session by the time this runs, so
          // closing before assigning would leave a window where a throw drops
          // the reference to a session nothing can close any more.
          //
          // A FAILED connect leaves the previous session alone on purpose. The
          // database that was proved is still proved; a mistyped second DSN is
          // not evidence about the first, and dropping it would log the person
          // out of a connection nothing went wrong with.
          const previous = issued;
          issued = outcome.handle;
          if (previous !== null) closeSession(previous);
        }
        return outcome;
      } finally {
        connecting = false;
      }
    },
  );

  ipcMain.handle(
    CHANNELS.scan,
    async (event, session: unknown): Promise<ScanOutcome> => {
      // Checked here, on this message. Not once at registration and not on the
      // connect that came before it — the frame that is allowed to ask is a
      // fact about the caller of THIS call, and a check that happened earlier
      // is a check on a caller that may no longer be the one speaking.
      assertAppWindow(event);
      if (scanning) {
        return {
          kind: 'scan_error',
          message: 'A scan is already running. Wait for it to finish.',
          // Nothing ran, so no run was opened and there is no recording to
          // report on. Empty is the answer; a sentence here would be about a
          // history that was never touched.
          historyLines: [],
        };
      }
      scanning = true;
      try {
        // The handle, and only ever the handle. There is no channel on this
        // bridge that carries a connection string back INTO the main process
        // after the first connect, which is the whole reason `session.ts`
        // exists — see its header.
        return await runScanFlow(session);
      } finally {
        scanning = false;
      }
    },
  );

  ipcMain.handle(CHANNELS.copyText, (event, text: unknown): boolean => {
    assertAppWindow(event);
    if (typeof text !== 'string' || text.length === 0 || text.length > MAX_COPY_LENGTH) {
      return false;
    }
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle(CHANNELS.devPrefill, (event): DevPrefill => {
    assertAppWindow(event);
    return opts.devPrefill;
  });

  ipcMain.on(CHANNELS.devReport, (event, line: unknown) => {
    if (!fromAppWindow(event)) return;
    // Reports exist only while the smoke run does.
    if (opts.devPrefill === null) return;
    if (typeof line !== 'string') return;
    opts.onDevReport(line.slice(0, MAX_REPORT_LENGTH));
  });
}
