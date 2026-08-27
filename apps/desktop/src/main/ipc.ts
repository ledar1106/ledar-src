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
import type { ConnectOutcome, DevPrefill, GuideBundle } from '../shared/ipc.js';
import { guideBundle, runConnectFlow } from './connect-flow.js';
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
        return await runConnectFlow(dsn);
      } finally {
        connecting = false;
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
