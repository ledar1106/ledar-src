/**
 * t('key') — the only door fixed UI strings pass through (_doc/21 §4).
 *
 * The key set is the English catalogue's keys, so a missing key is a type
 * error at build time, not a blank label at run time. Parameters use {name}
 * so word order is the translation's decision, not the call site's.
 */

import { en } from './i18n/en.js';

export type MessageKey = keyof typeof en;

export function t(key: MessageKey, params?: Record<string, string | number>): string {
  let text: string = en[key];
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
