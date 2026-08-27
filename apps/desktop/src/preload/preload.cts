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
 * gets exactly the five calls the contract names.
 */

import type { ConnectOutcome, DevPrefill, GuideBundle, LedarBridge } from '../shared/ipc.js';

import electron = require('electron');

const { contextBridge, ipcRenderer } = electron;

const api: LedarBridge = {
  guide: (): Promise<GuideBundle> => ipcRenderer.invoke('ledar:guide'),
  connect: (dsn: string): Promise<ConnectOutcome> =>
    ipcRenderer.invoke('ledar:connect', String(dsn)),
  copyText: (text: string): Promise<boolean> =>
    ipcRenderer.invoke('ledar:copy-text', String(text)),
  devPrefill: (): Promise<DevPrefill> => ipcRenderer.invoke('ledar:dev-prefill'),
  devReport: (line: string): void => {
    ipcRenderer.send('ledar:dev-report', String(line));
  },
};

contextBridge.exposeInMainWorld('ledar', api);
