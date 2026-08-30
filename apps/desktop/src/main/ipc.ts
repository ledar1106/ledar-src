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

import { app, clipboard, ipcMain } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

import { AreaAnswer, ProfileArea } from '@ledar/contracts';

import { CHANNELS } from '../shared/ipc.js';
import type {
  AppVersion,
  AreaReply,
  AskOutcome,
  AskPreview,
  ConnectOutcome,
  DevPrefill,
  GuideBundle,
  InterviewForm,
  ModelSettings,
  ProfileFacts,
  SaveModelOutcome,
  ScanOutcome,
  SessionHandle,
} from '../shared/ipc.js';
import { askPreview, askSend } from './ask-flow.js';
import { currentSettings, forgetKey, saveSettings } from './model-settings.js';
import { guideBundle, runConnectFlow } from './connect-flow.js';
import { interviewForm } from './interview-form.js';
import { confirmArea, currentFacts, saveProfile } from './profile-flow.js';
import { runScanFlow } from './scan-flow.js';
import { closeSession } from './session.js';
import { APP_ORIGIN } from './serve.js';

/**
 * The replies, keeping only what is unmistakably one.
 *
 * Uses the contract's own parsers rather than checking strings by hand: an
 * area or an answer added to `@ledar/contracts` widens what is accepted here
 * automatically, and a hand-written list would be the third copy of a
 * vocabulary — §4.27 measured what that costs.
 *
 * `picked` is filtered to strings rather than refused outright. The ids are
 * only ever compared against the option list, so a non-string in there cannot
 * match anything; dropping it loses nothing and keeps one badly-typed element
 * from discarding an answer somebody actually gave.
 */
function validReplies(payload: unknown): AreaReply[] {
  if (!Array.isArray(payload)) return [];

  const out: AreaReply[] = [];
  for (const raw of payload) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;

    const area = ProfileArea.safeParse(row['area']);
    const answer = AreaAnswer.safeParse(row['answer']);
    if (!area.success || !answer.success) continue;

    const picked = Array.isArray(row['picked'])
      ? row['picked'].filter((v): v is string => typeof v === 'string')
      : [];

    out.push({ area: area.data, answer: answer.data, picked });
  }
  return out;
}

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
  /** One question at a time. See the `askSend` handler for why. */
  let asking = false;

  ipcMain.handle(CHANNELS.guide, (event): GuideBundle => {
    assertAppWindow(event);
    return guideBundle();
  });

  // Read from Electron rather than imported from a constant here. A constant
  // would be a second place holding the version, and the one thing the
  // handbook asks of a version is that every place holding it agrees.
  ipcMain.handle(CHANNELS.appVersion, (event): AppVersion => {
    assertAppWindow(event);
    return { version: app.getVersion() };
  });

  // Takes nothing, so there is nothing from the renderer to validate. The
  // window asks what the questions are; it does not get to say.
  ipcMain.handle(CHANNELS.interviewForm, (event): InterviewForm => {
    assertAppWindow(event);
    return interviewForm();
  });

  /**
   * The answers arrive, and the map goes back.
   *
   * Everything in the payload is checked here rather than trusted. The
   * renderer is sandboxed and ours, but "ours" is the claim this boundary
   * exists to not rely on — and the shape it sends decides what gets written
   * into a record of somebody's system.
   *
   * ⚠️ A malformed reply is DROPPED, not repaired. Guessing what somebody
   * meant and filing that as a thing they said is the one failure a profile
   * must not have: every later screen reads `stated` as "they told me this".
   */
  ipcMain.handle(CHANNELS.saveProfile, (event, payload: unknown): ProfileFacts | null => {
    assertAppWindow(event);
    return saveProfile(validReplies(payload), new Date().toISOString());
  });

  /**
   * A person agreed with what was shown for one area.
   *
   * 🟥 The only path to `verified` in the product. An area name that is not
   * one of the five is answered with the map unchanged rather than an error:
   * nothing was promoted, and the window has no branch that would do anything
   * different with a throw.
   */
  ipcMain.handle(CHANNELS.confirmArea, (event, area: unknown): ProfileFacts | null => {
    assertAppWindow(event);
    const parsed = ProfileArea.safeParse(area);
    if (!parsed.success) return currentFacts();
    return confirmArea(parsed.data, new Date().toISOString());
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

  // Takes nothing and returns no secret. The window asks where the model is
  // and whether a key exists; it never learns the key.
  ipcMain.handle(CHANNELS.modelSettings, (event): ModelSettings => {
    assertAppWindow(event);
    return currentSettings();
  });

  /**
   * The person typed a key. The only channel by which one is stored.
   *
   * 🟥 Validated here rather than in the preload, like every other payload:
   * the boundary is this side. `saveSettings` refuses anything that is not
   * `https://`, because a key sent over http is a key read on the way.
   */
  ipcMain.handle(
    CHANNELS.saveModelSettings,
    (event, baseUrl: unknown, model: unknown, key: unknown): SaveModelOutcome => {
      assertAppWindow(event);
      return saveSettings(baseUrl, model, key);
    },
  );

  ipcMain.handle(CHANNELS.forgetModelKey, (event): ModelSettings => {
    assertAppWindow(event);
    return forgetKey();
  });

  /**
   * What a question would send. Sends nothing, and says so by being a
   * separate channel from the one that does.
   *
   * 🟥 Two channels rather than one with a flag. A reader auditing this
   * bridge can point at the line that sends; with a `confirm` argument the
   * boundary would live inside a parameter, where nobody looks.
   */
  ipcMain.handle(
    CHANNELS.askPreview,
    async (event, session: unknown, question: unknown): Promise<AskPreview> => {
      assertAppWindow(event);
      if (typeof session !== 'string' || session.length === 0) {
        // The same shape a missing scan produces, because from the window's
        // point of view it is one: there is nothing to look in.
        return { kind: 'unavailable', reason: 'no-scan-yet' };
      }
      return askPreview(session, question);
    },
  );

  /**
   * The person read the disclosure and agreed. The only channel here that
   * sends anything to anybody.
   *
   * Serialised the way `scan` is: a second question in flight would grant a
   * second pair of permits against the same ledger while the first pair was
   * still being spent, and what a person agreed to is one exchange.
   */
  ipcMain.handle(
    CHANNELS.askSend,
    async (
      event,
      session: unknown,
      question: unknown,
      key: unknown,
      value: unknown,
    ): Promise<AskOutcome> => {
      assertAppWindow(event);
      if (typeof session !== 'string' || session.length === 0) {
        return {
          kind: 'unavailable',
          why: 'This session is not open. Connect again.',
          provenance: null,
          detail: null,
          sent: false,
        };
      }
      if (asking) {
        return {
          kind: 'unavailable',
          why: 'A question is already being asked. Wait for it.',
          provenance: null,
          detail: null,
          sent: false,
        };
      }
      asking = true;
      try {
        return await askSend(session, question, key, value);
      } finally {
        asking = false;
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
