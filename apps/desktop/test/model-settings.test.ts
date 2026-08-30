/**
 * Where the key is kept, and what happens when it cannot be.
 *
 * 🟥 The obvious answer to N63 was a key shipped inside the app, encrypted.
 * Measured instead of argued: `LEDAR.msix` opens with three lines of Python —
 * it is a zip — and `resources/app/main.js` is 639,396 bytes of readable
 * JavaScript with its comments intact. Anything encrypted in there travels
 * with whatever decrypts it.
 *
 * So the key is the person's, and the operating system holds the means to
 * read it back. These tests are about the two rules that makes possible: the
 * renderer never sees a key, and nothing is written in the clear.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  currentSettings,
  forgetKey,
  saveSettings,
  storedKey,
  useCipher,
} from '../src/main/model-settings.js';
import type { Cipher } from '../src/main/model-settings.js';

/**
 * A stand-in for DPAPI that is reversible and obviously not encryption.
 *
 * Deliberately trivial: this file tests WHERE things go and WHAT is refused,
 * not the strength of an operating system's cipher, and a fake that looked
 * cryptographic would invite somebody to read these tests as evidence about
 * the real one.
 */
function fakeCipher(available = true): Cipher {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`sealed:${plain}`, 'utf8'),
    decryptString: (cipher) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('sealed:')) throw new Error('not ours');
      return text.slice('sealed:'.length);
    },
  };
}

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledar-model-'));
  process.env['LEDAR_MODEL_SETTINGS'] = join(dir, 'model.json');
});

beforeEach(() => {
  useCipher(fakeCipher());
  rmSync(join(dir, 'model.json'), { force: true });
});

after(() => {
  useCipher(null);
  delete process.env['LEDAR_MODEL_SETTINGS'];
  rmSync(dir, { recursive: true, force: true });
});

describe('before anybody has typed anything', () => {
  it('offers a default so there is ONE field to fill', () => {
    const s = currentSettings();
    assert.equal(s.baseUrl, DEFAULT_BASE_URL);
    assert.equal(s.model, DEFAULT_MODEL);
    assert.equal(s.hasKey, false);
    assert.equal(storedKey(), null);
  });
});

describe('the key', () => {
  it('🟥 is never written in the clear', () => {
    // 🟥 The stand-in is deliberately NOT key-shaped. An earlier version used
    // `sk-…`, and `check-secrets.py` refused the commit — correctly, because
    // that gate cannot tell a plausible fake from a real credential and the
    // only safe side to be wrong on is the refusing one. What this test needs
    // is a distinctive string, not a realistic one.
    saveSettings(DEFAULT_BASE_URL, DEFAULT_MODEL, 'not-a-key-only-a-test-value');
    const raw = readFileSync(join(dir, 'model.json'), 'utf8');
    // The one assertion this file exists for. If it ever fails, a credential
    // is sitting in a file in somebody's profile.
    assert.equal(raw.includes('not-a-key-only-a-test-value'), false);
    assert.match(raw, /keyCipher/);
    // …and it comes back for the main process, which is the point of storing it.
    assert.equal(storedKey(), 'not-a-key-only-a-test-value');
  });

  it('🟥 is REFUSED rather than written when the OS cannot encrypt', () => {
    // There is no honest version of "we could not protect this, so we wrote
    // it down". A Linux box with no keyring reaches exactly this.
    useCipher(fakeCipher(false));
    const out = saveSettings(DEFAULT_BASE_URL, DEFAULT_MODEL, 'not-a-key-only-a-test-value');
    assert.equal(out.kind, 'cannot-encrypt');
    assert.equal(storedKey(), null);
    assert.equal(currentSettings().canStoreKey, false);
  });

  it('🟥 reads as absent when another machine wrote it', () => {
    // DPAPI refuses a blob from a different user or machine, and that refusal
    // IS the protection. Treated as "no key" so the person is asked for one
    // rather than shown a decryption error they cannot act on.
    saveSettings(DEFAULT_BASE_URL, DEFAULT_MODEL, 'not-a-key-only-a-test-value');
    useCipher({
      ...fakeCipher(),
      decryptString: () => {
        throw new Error('DPAPI: the data is invalid');
      },
    });
    assert.equal(storedKey(), null);
  });

  it('survives a change of model name', () => {
    // An empty key field means "leave it alone", not "delete it". Somebody
    // correcting a model name must not silently lose their credential.
    saveSettings(DEFAULT_BASE_URL, DEFAULT_MODEL, 'not-a-key-only-a-test-value');
    const out = saveSettings(DEFAULT_BASE_URL, 'some-other-model', '');
    assert.equal(out.kind, 'saved');
    assert.equal(storedKey(), 'not-a-key-only-a-test-value');
    assert.equal(currentSettings().model, 'some-other-model');
  });

  it('goes only when somebody asks it to go', () => {
    saveSettings(DEFAULT_BASE_URL, DEFAULT_MODEL, 'not-a-key-only-a-test-value');
    const s = forgetKey();
    assert.equal(s.hasKey, false);
    assert.equal(storedKey(), null);
    // And nothing else went with it.
    assert.equal(s.baseUrl, DEFAULT_BASE_URL);
  });
});

describe('what will not be accepted', () => {
  it('🟥 refuses http, because a key on http is a key somebody else reads', () => {
    const out = saveSettings('http://api.example.dev/v1', DEFAULT_MODEL, 'not-a-key-only-a-test-value');
    assert.equal(out.kind, 'rejected');
    assert.equal(storedKey(), null);
  });

  it('refuses an address that is not one', () => {
    for (const bad of ['', 'api.example.dev', 'ftp://x', 'https:// has a space']) {
      assert.equal(saveSettings(bad, DEFAULT_MODEL, 'not-a-key-only-a-test-value').kind, 'rejected', bad);
    }
  });

  it('refuses an empty model name', () => {
    // Bring-your-own-key means bring-your-own-provider, and a provider serves
    // model names of its own. An empty one fails at the far end with a message
    // about somebody else's API.
    assert.equal(saveSettings(DEFAULT_BASE_URL, '', 'not-a-key-only-a-test-value').kind, 'rejected');
  });
});
