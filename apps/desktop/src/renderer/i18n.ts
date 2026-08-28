/**
 * t('key') — the only door fixed UI strings pass through (_doc/21 §4).
 *
 * The key set is the English catalogue's keys, so a missing key is a type
 * error at build time, not a blank label at run time. Parameters use {name}
 * so word order is the translation's decision, not the call site's.
 */

import { en } from './i18n/en.js';

export type MessageKey = keyof typeof en;

/**
 * Whether a string built at run time names a real message.
 *
 * Needed for exactly one thing: option ids arrive over the bridge as strings
 * (they come from `AREA_OPTIONS` in the contract), so the key they map to
 * cannot be checked at compile time the way every other call to `t` is.
 *
 * ⚠️ This is a boundary check, NOT a fallback strategy. Every id the contract
 * offers has a label, and `apps/desktop/test/interview.test.ts` asserts it —
 * so the false branch is unreachable in a correct build. It exists so that an
 * id added to the contract without a label here shows up as the raw id on
 * screen, where somebody sees it, rather than as an empty row nobody notices.
 */
export function isMessageKey(key: string): key is MessageKey {
  return Object.prototype.hasOwnProperty.call(en, key);
}

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text: string = en[key];
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
