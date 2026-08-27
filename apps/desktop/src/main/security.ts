/**
 * What the window is not allowed to become.
 *
 * The Sol audit on _doc/17 set these as week-one acceptance criteria, not
 * hardening to bolt on later: an Electron shell has the run of the machine,
 * so the renderer inside it is treated as a guest, not as the house. The
 * window preferences (context isolation, sandbox, no node integration) live
 * where the window is created; this file is everything that has to hold for
 * ANY web contents the app might ever create, registered once before the
 * first one exists.
 *
 * Deny is the default in every handler. Each allowance, when one arrives,
 * has to be written here by name — the same allowlist habit as serve.ts and
 * the publish gate.
 */

import { app } from 'electron';

import { APP_ORIGIN } from './serve.js';

export function hardenAllWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    // No page this app shows opens windows. A popup is how a renderer
    // escapes its CSP and its origin in one move.
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    // The app is one document. In-app anchors and reloads stay inside the
    // origin; everything else — including a dragged-in file — is refused.
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
    });

    // <webview> embeds a second, weaker renderer. Nothing here needs one.
    contents.on('will-attach-webview', (event) => event.preventDefault());

    // Camera, geolocation, notifications, clipboard-read: nothing in this
    // product asks the browser for any of it. Copying goes through the main
    // process (ipc.ts), so even clipboard-write is not needed here.
    contents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false);
    });
    contents.session.setPermissionCheckHandler(() => false);
  });
}
