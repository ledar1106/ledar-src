/**
 * Where the model credentials live, and who is allowed to see them.
 *
 * ## 🟥 The key is NOT in the package, and cannot be
 *
 * The obvious answer to N63 is to ship a key inside the app, encrypted. It
 * does not work, and this was measured rather than argued: `LEDAR.msix` opens
 * with three lines of Python — it is a zip — and `resources/app/main.js` is
 * 639,396 bytes of plain, readable JavaScript with the comments still in it.
 * Anything encrypted in there needs something to decrypt it, and that
 * something is in there too. Obfuscation makes the extraction take fifteen
 * minutes instead of three.
 *
 * So the key comes from the person using the app. Bring-your-own-key: they
 * hold an account with a provider, they paste the key once, and it never
 * leaves this machine except to that provider.
 *
 * ## Where it is kept
 *
 * `safeStorage`, which on Windows is DPAPI: the operating system encrypts it
 * against THIS user on THIS machine. Copying the file to another machine
 * yields nothing. That is a real protection and the difference from the
 * shipped-key idea is the whole point — the decryption key belongs to
 * Windows, not to anything LEDAR distributes.
 *
 * ⚠️ `cipherOf().isEncryptionAvailable()` can be false — a Linux box with no
 * keyring, a service account. When it is, this refuses to store the key
 * rather than writing it in the clear. A product whose value is that it does
 * not take your data does not get to leave a credential lying in a file
 * because the tidy path was unavailable.
 *
 * ## 🟥 The renderer never receives the key
 *
 * `ModelSettings` carries `hasKey: boolean` and no key. The window needs to
 * know whether one is set so it can ask for one; it never needs the value.
 * Handing it over would put a credential in a browser context for no reason
 * anybody could state, and "the renderer is ours" is exactly the claim the
 * preload boundary exists to not rely on (AGENTS hard rule 7).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createRequire } from 'node:module';

import { ledarDir } from '@ledar/store';

/**
 * The thing that encrypts. A seam, and not only for testing.
 *
 * 🟥 `electron` is reached LAZILY through `createRequire` rather than by a
 * top-level import. `ask-flow.ts` imports this module, and `ask-flow.ts` has
 * pure functions the suite tests under plain node — where `import
 * { safeStorage } from 'electron'` is a module error before a single
 * assertion runs. One import turned six passing tests into a file that would
 * not load.
 *
 * Naming the dependency also makes the rule below CHECKABLE: a test can hand
 * over a cipher that reports encryption unavailable and watch this refuse,
 * without needing a machine with no keyring on it.
 */
export type Cipher = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
};

let injected: Cipher | null = null;

/** For tests. Pass null to go back to the operating system's own. */
export function useCipher(cipher: Cipher | null): void {
  injected = cipher;
}

function cipherOf(): Cipher {
  if (injected !== null) return injected;
  const require = createRequire(import.meta.url);
  return (require('electron') as { safeStorage: Cipher }).safeStorage;
}

/**
 * What ships as the default, so somebody has ONE field to fill.
 *
 * ⚠️ A recommendation, not a requirement, and the screen says so. Any endpoint
 * speaking the OpenAI `/chat/completions` shape works — that is what
 * `outboundOf` builds — so a person with a key from somewhere else changes
 * two fields and carries on.
 *
 * The model name has to match what THAT provider serves. It is the field most
 * likely to be wrong after somebody swaps the base URL, which is why it is on
 * the screen at all rather than hidden.
 */
export const DEFAULT_BASE_URL = 'https://api.clfaigateway.dev/v1';
export const DEFAULT_MODEL = 'qwen3.8-27b';

/** What the window is allowed to know. No key. */
export type ModelSettings = {
  readonly baseUrl: string;
  readonly model: string;
  /** Whether a key is stored. Never the key itself. */
  readonly hasKey: boolean;
  /**
   * False when the OS cannot encrypt, so the screen can say why it will not
   * take a key rather than appearing to accept one and losing it.
   */
  readonly canStoreKey: boolean;
};

type OnDisk = {
  baseUrl?: string;
  model?: string;
  /** DPAPI ciphertext, base64. Never plaintext — see `saveSettings`. */
  keyCipher?: string;
};

/**
 * Where the settings live.
 *
 * `LEDAR_MODEL_SETTINGS` points it somewhere disposable, exactly as
 * `LEDAR_HISTORY_DB` does for the scan history — the default path is reached
 * only in a real run, so a test never writes over somebody's stored key.
 */
function settingsFile(): string {
  const named = process.env['LEDAR_MODEL_SETTINGS']?.trim();
  return named !== undefined && named.length > 0 ? named : join(ledarDir(), 'model.json');
}

function readFile(): OnDisk {
  const path = settingsFile();
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as OnDisk;
  } catch {
    // A settings file that will not parse is treated as absent. The person is
    // then asked for a key again, which is recoverable; throwing here would
    // make a corrupt file into an app that cannot start.
    return {};
  }
}

/** What the window may be told. */
export function currentSettings(): ModelSettings {
  const disk = readFile();
  return {
    baseUrl: disk.baseUrl?.trim() || DEFAULT_BASE_URL,
    model: disk.model?.trim() || DEFAULT_MODEL,
    hasKey: typeof disk.keyCipher === 'string' && disk.keyCipher.length > 0,
    canStoreKey: cipherOf().isEncryptionAvailable(),
  };
}

/** The stored key, decrypted, for the main process alone. Null when there is none. */
export function storedKey(): string | null {
  const cipher = readFile().keyCipher;
  if (typeof cipher !== 'string' || cipher.length === 0) return null;
  try {
    const plain = cipherOf().decryptString(Buffer.from(cipher, 'base64'));
    return plain.length > 0 ? plain : null;
  } catch {
    // Written by another user or on another machine — DPAPI refuses, and that
    // refusal is the protection working. Treated as "no key" so the person is
    // asked for one rather than shown a decryption error they cannot act on.
    return null;
  }
}

export type SaveOutcome =
  | { kind: 'saved'; settings: ModelSettings }
  | { kind: 'cannot-encrypt' }
  | { kind: 'rejected'; why: string };

/**
 * Stores what the person typed. The only writer.
 *
 * 🟥 Refuses rather than falling back to plaintext when the OS cannot
 * encrypt. There is no honest version of "we could not protect this, so we
 * wrote it down".
 */
export function saveSettings(
  rawBaseUrl: unknown,
  rawModel: unknown,
  rawKey: unknown,
): SaveOutcome {
  const baseUrl = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : '';
  const model = typeof rawModel === 'string' ? rawModel.trim() : '';
  const key = typeof rawKey === 'string' ? rawKey.trim() : '';

  // 🟥 https only. A key sent over http is a key read by anybody on the way,
  // and this is the one field where being permissive costs the person their
  // credential rather than their convenience.
  if (!/^https:\/\/[^\s]+$/.test(baseUrl)) {
    return { kind: 'rejected', why: 'The address must start with https:// .' };
  }
  if (model.length === 0 || model.length > 200) {
    return { kind: 'rejected', why: 'Name the model this provider serves.' };
  }

  const disk = readFile();
  const next: OnDisk = { baseUrl, model };

  if (key.length > 0) {
    if (!cipherOf().isEncryptionAvailable()) return { kind: 'cannot-encrypt' };
    next.keyCipher = cipherOf().encryptString(key).toString('base64');
  } else if (typeof disk.keyCipher === 'string') {
    // An empty key field means "leave the key alone", not "delete it". A
    // person changing the model name should not silently lose their
    // credential — `forgetKey` is the deliberate way to remove it.
    next.keyCipher = disk.keyCipher;
  }

  const path = settingsFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { kind: 'saved', settings: currentSettings() };
}

/** Removes the stored key and keeps the rest. Deliberate, never a side effect. */
export function forgetKey(): ModelSettings {
  const disk = readFile();
  // Built by assignment rather than a literal: `exactOptionalPropertyTypes`
  // draws a line between "absent" and "present and undefined", and writing
  // `{ baseUrl: undefined }` would put the second into the file.
  const next: OnDisk = {};
  if (disk.baseUrl !== undefined) next.baseUrl = disk.baseUrl;
  if (disk.model !== undefined) next.model = disk.model;
  const path = settingsFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return currentSettings();
}
