/**
 * Nothing about somebody's system leaves without a permit over the exact bytes.
 *
 * `_doc/27` Module 4 names the red test, and it is the first one below:
 *
 * > *"Cấp permit rồi thay ĐÚNG MỘT định danh schema, hoặc đổi destination.
 * > Nếu hàm network được gọi → module thất bại. Không permit cũng phải cho
 * > cùng kết quả từ chối."*
 *
 * So these tests are about the five things a permit binds, and each one is a
 * way for a permit to be NEARLY right. A gate that only refuses obvious
 * nonsense is a gate that passes everything real.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EgressRefused,
  PermitLedger,
  checkEgress,
  describeEgress,
  grantEgress,
  hashBody,
} from '../src/egress-permit.js';
import type { PromptParts } from '../src/untrusted.js';

const WHERE = 'https://api.example.dev/v1/chat/completions';
const POLICY = 'consent=x/1 retention=none/1 redaction=fence/1';
const NOW = '2026-08-28T12:00:00.000Z';

function parts(over: Partial<PromptParts> = {}): PromptParts {
  return {
    instruction: 'Answer using ONLY this JSON shape.',
    untrusted: [
      {
        label: 'facts from the scan',
        egressClass: 'customer-system-metadata',
        content: 'f1 — where: public.rental.customer_id\nf2 — orphans: 3',
      },
      {
        label: 'question asked by the user',
        egressClass: 'customer-system-metadata',
        content: 'why is this row missing?',
      },
    ],
    ...over,
  };
}

/**
 * A body shaped like the one model-client sends.
 *
 * It carries the prompt text, which is what makes `grantEgress`'s identifier
 * check meaningful: in the real path the body CONTAINS the blocks the
 * disclosure was derived from, so the two can only disagree if something
 * rebuilt the payload after the screen was shown.
 */
function body(promptText = 'public.rental.customer_id and public.customer'): string {
  return JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ content: promptText }] });
}

function permitFor(bodyText = body(), over: Record<string, unknown> = {}) {
  return grantEgress({
    disclosure: describeEgress(parts(), WHERE, ['public.rental']),
    body: bodyText,
    policy: POLICY,
    now: NOW,
    ttlMs: 60_000,
    id: 'permit-1',
    ...over,
  });
}

const actualOf = (bodyText: string) => ({
  body: bodyText,
  destination: WHERE,
  dataClass: 'customer-system-metadata' as const,
  policy: POLICY,
});

describe('describeEgress — what a person is shown', () => {
  it('lists every block, its class and its size', () => {
    const d = describeEgress(parts(), WHERE);
    assert.equal(d.blocks.length, 2);
    assert.deepEqual(
      d.blocks.map((b) => b.label),
      ['facts from the scan', 'question asked by the user'],
    );
    assert.equal(d.bytes, d.blocks.reduce((n, b) => n + b.bytes, 0));
  });

  it('takes the STRICTEST class in the payload, not the commonest', () => {
    const d = describeEgress(
      parts({
        untrusted: [
          { label: 'ours', egressClass: 'product-constant', content: 'a' },
          { label: 'theirs', egressClass: 'customer-system-metadata', content: 'b' },
        ],
      }),
      WHERE,
    );
    assert.equal(d.dataClass, 'customer-system-metadata');
  });

  it('🟥 refuses outright to describe anything never-leaves', () => {
    // There is no consent screen for this class. Offering one would turn a
    // boundary into a prompt, and a person cannot be asked to approve what
    // the rule that produced it said may not travel.
    assert.throws(
      () =>
        describeEgress(
          parts({
            untrusted: [
              { label: 'a sampled row', egressClass: 'never-leaves', content: 'x' },
            ],
          }),
          WHERE,
        ),
      (e: unknown) => e instanceof EgressRefused && /never-leaves/.test(e.message),
    );
  });

  it('🟥 reports only identifiers that are really in the payload', () => {
    // Derived, not taken on the caller's word. A screen that under-lists gets
    // consent for something the person was not told about.
    const d = describeEgress(parts(), WHERE, [
      'public.rental',
      'public.somewhere_else',
      '',
    ]);
    assert.deepEqual([...d.identifiers], ['public.rental']);
  });
});

describe('grantEgress', () => {
  it('hashes the body it was given, not one it was told about', () => {
    const text = body('public.rental and nothing else');
    const p = permitFor(text);
    assert.equal(p.bodyHash, hashBody(text));
  });

  it('🟥 refuses when the disclosure names something the body does not carry', () => {
    // The screen and the payload drifting apart, which is a person agreeing
    // to a different thing.
    assert.throws(
      () =>
        grantEgress({
          disclosure: {
            destination: WHERE,
            dataClass: 'customer-system-metadata',
            blocks: [],
            bytes: 0,
            identifiers: ['public.not_in_the_body'],
          },
          body: body(),
          policy: POLICY,
          now: NOW,
          ttlMs: 1000,
          id: 'p',
        }),
      (e: unknown) => e instanceof EgressRefused && /not in the payload/.test(e.message),
    );
  });

  it('refuses a permit with no life', () => {
    assert.throws(() => permitFor(body(), { ttlMs: 0 }), EgressRefused);
  });
});

describe('checkEgress refuses', () => {
  it('🟥 one changed schema identifier — the red test from _doc/27', () => {
    const p = permitFor(body('public.rental and public.customer'));
    assert.throws(
      () => checkEgress(p, actualOf(body('public.payment and public.customer')), NOW),
      (e: unknown) =>
        e instanceof EgressRefused && /not the one this permit was granted over/.test(e.message),
    );
  });

  it('🟥 one changed BYTE, anywhere', () => {
    const p = permitFor(body('public.rental'));
    assert.throws(() => checkEgress(p, actualOf(body('public.renta1')), NOW), EgressRefused);
  });

  it('🟥 a different destination', () => {
    const p = permitFor();
    assert.throws(
      () =>
        checkEgress(
          p,
          { ...actualOf(body()), destination: 'https://elsewhere.example/v1/chat/completions' },
          NOW,
        ),
      (e: unknown) => e instanceof EgressRefused && /going to/.test(e.message),
    );
  });

  it('a different data class', () => {
    const p = permitFor();
    assert.throws(
      () => checkEgress(p, { ...actualOf(body()), dataClass: 'product-constant' }, NOW),
      EgressRefused,
    );
  });

  it('a different policy version', () => {
    // Consent given under one retention rule is not consent under another.
    const p = permitFor();
    assert.throws(
      () =>
        checkEgress(p, { ...actualOf(body()), policy: 'consent=x/2 retention=none/1' }, NOW),
      (e: unknown) => e instanceof EgressRefused && /policy/.test(e.message),
    );
  });

  it('a permit that has expired', () => {
    const p = permitFor(body(), { ttlMs: 1000 });
    assert.throws(
      () => checkEgress(p, actualOf(body()), '2026-08-28T12:00:02.000Z'),
      (e: unknown) => e instanceof EgressRefused && /expired/.test(e.message),
    );
  });

  it('lets the exact payload through, at the moment it was granted', () => {
    const p = permitFor();
    assert.doesNotThrow(() => checkEgress(p, actualOf(body()), NOW));
  });
});

describe('PermitLedger — one grant is one send', () => {
  it('🟥 refuses the second use of the same permit', () => {
    // A permit that could be replayed makes one "yes" cover every call after
    // it, which is the difference between consent and a switch.
    const ledger = new PermitLedger();
    const p = permitFor();
    ledger.spend(p);
    assert.throws(() => ledger.spend(p), (e: unknown) => e instanceof EgressRefused);
  });

  it('two permits over identical bytes are still two permits', () => {
    const ledger = new PermitLedger();
    ledger.spend(permitFor(body(), { id: 'a' }));
    assert.doesNotThrow(() => ledger.spend(permitFor(body(), { id: 'b' })));
    assert.equal(ledger.size, 2);
  });

  it('forgetting drops the lot, for a session that ended', () => {
    const ledger = new PermitLedger();
    ledger.spend(permitFor());
    ledger.forget();
    assert.equal(ledger.size, 0);
  });
});
