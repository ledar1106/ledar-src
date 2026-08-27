/**
 * The bridge as the renderer sees it: one global, typed by the shared
 * contract. preload.cts is what actually puts it there.
 */

import type { LedarBridge } from '../shared/ipc.js';

declare global {
  interface Window {
    ledar: LedarBridge;
  }
}

export {};
