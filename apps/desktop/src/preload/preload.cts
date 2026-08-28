/**
 * The bridge, and the whole bridge.
 *
 * This file runs sandboxed: it cannot require other files, so the channel
 * names are written out as literals here and typed against the shared
 * contract — `LedarBridge` keeps the shapes honest at compile time, and
 * apps/desktop/test/preload-channels.test.ts keeps the literals matching
 * `CHANNELS` so the two cannot drift apart in silence.
 *
 * Nothing here interprets anything. Arguments are coerced to strings and
 * passed on; validation lives in ipc.ts on the main side, where the
 * boundary actually is. What matters in this file is what is absent:
 * no Node globals leak, no ipcRenderer handle leaks, and the renderer
 * gets exactly the calls the contract names and no others.
 *
 * `scan` takes the session handle the connect outcome carried back, never a
 * connection string. That is not this file's decision to make — there is no
 * channel here that would accept one — but it is the shape a reader of this
 * page should be able to confirm at a glance: after the first connect, the
 * only thing this bridge can say about a database is its handle.
 */

import type {
  ConnectOutcome,
  DevPrefill,
  AreaReply,
  GuideBundle,
  InterviewForm,
  LedarBridge,
  ProfileArea,
  ProfileFacts,
  ScanOutcome,
  SessionHandle,
} from '../shared/ipc.js';

import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

const api: LedarBridge = {
  guide: (): Promise<GuideBundle> => ipcRenderer.invoke('ledar:guide'),
  connect: (dsn: string): Promise<ConnectOutcome> =>
    ipcRenderer.invoke('ledar:connect', String(dsn)),
  scan: (session: SessionHandle): Promise<ScanOutcome> =>
    ipcRenderer.invoke('ledar:scan', String(session)),
  copyText: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('ledar:copy-text', String(text)),
  interviewForm: (): Promise<InterviewForm> => ipcRenderer.invoke('ledar:interview-form'),
  // Passed on as-is. Validation lives in main/ipc.ts, where the boundary is —
  // this file coerces the shapes it can (a string) and never inspects the rest.
  saveProfile: (replies: readonly AreaReply[]): Promise<ProfileFacts> =>
    ipcRenderer.invoke('ledar:save-profile', replies),
  confirmArea: (area: ProfileArea): Promise<ProfileFacts> =>
    ipcRenderer.invoke('ledar:confirm-area', String(area)),
  devPrefill: (): Promise<DevPrefill> => ipcRenderer.invoke('ledar:dev-prefill'),
  devReport: (line: string): void => {
    ipcRenderer.send('ledar:dev-report', String(line));
  },
};

contextBridge.exposeInMainWorld('ledar', api);
