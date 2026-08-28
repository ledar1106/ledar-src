/**
 * G3's model step, end to end, with a fake provider.
 *
 * The chain: a question and a menu go out under a permit, a model answers with
 * ids, and what comes back is a CHOICE checked against the menu it was
 * offered. Nothing here writes a sentence and nothing writes SQL.
 *
 * The tests that matter are the ones where the model answers plausibly and
 * wrongly. ㉔ measured the shape: `rule-wrong-table` won 3 of 7 by asking for a
 * different table than the user named, and said nothing hostile doing it. Its
 * output is fluent, true, and about somebody else's question — undetectable in
 * prose, and a failed call here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PermitLedger,
  describeEgress,
  framePrompt,
  grantEgress,
  graphFrom,
  lookupOffer,
  lookupPromptParts,
  resolveLookup,
} from '@ledar/contracts';
import type { GraphSource, LookupOffer } from '@ledar/contracts';

import { askLookup, outboundOf } from '../src/index.js';
import type { CallRecord, Egress, ModelConfig } from '../src/index.js';

const CONFIG: ModelConfig = {
  baseUrl: 'https://api.example.dev/v1',
  apiKey: 'not-a-real-key',
  tiers: {
    // The `rules` tier, and this is its first call site. ㉔ chose qwen for the
    // gate whose output BECOMES something that runs; a lookup is exactly that.
    rules: { model: 'qwen3.8-27b', effort: 'medium', maxTokens: 2000 },
  },
};

const SOURCE: GraphSource = {
  tables: [
    { schema: 'public', table: 'customer' },
    { schema: 'public', table: 'rental' },
    { schema: 'public', table: 'payment' },
  ],
  columns: [],
  constraints: [
    {
      schema: 'public',
      table: 'rental',
      columns: ['customer_id'],
      referencedSchema: 'public',
      referencedTable: 'customer',
      referencedColumns: ['customer_id'],
      kind: 'foreign_key',
    },
    {
      schema: 'public',
      table: 'payment',
      columns: ['rental_id'],
      referencedSchema: 'public',
      referencedTable: 'rental',
      referencedColumns: ['rental_id'],
      kind: 'foreign_key',
    },
  ],
};

const OFFER: LookupOffer = lookupOffer(graphFrom(SOURCE));
const QUESTION = 'I paid but I do not see my order';
const PARTS = lookupPromptParts(QUESTION, OFFER);
const PROMPT = framePrompt(PARTS);
const POLICY = 'consent=test/1 retention=none/1 redaction=fence/1';
const NOW = '2026-08-28T12:00:00.000Z';

function egress(): Egress {
  const outbound = outboundOf(CONFIG, CONFIG.tiers['rules']!, PROMPT);
  return {
    permit: grantEgress({
      disclosure: describeEgress(PARTS, outbound.destination, ['public.customer']),
      body: outbound.body,
      policy: POLICY,
      now: NOW,
      ttlMs: 60_000,
      id: `permit-${Math.random()}`,
    }),
    ledger: new PermitLedger(),
    policy: POLICY,
    dataClass: 'customer-system-metadata',
    now: NOW,
  };
}

function replies(content: unknown) {
  const seen: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    seen.push(String(init.body));
    return {
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 300, completion_tokens: 40 },
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

async function ask(content: unknown) {
  const calls: CallRecord[] = [];
  const { impl, seen } = replies(content);
  const out = await askLookup(CONFIG, 'rules', PROMPT, OFFER, (c) => calls.push(c), egress(), {
    fetchImpl: impl,
  });
  return { out, calls, seen };
}

const CUSTOMER = OFFER.subjects.find((s) => s.entity.table === 'customer')!;
const TO_PAYMENT = OFFER.paths.find(
  (p) => p.id.startsWith(`${CUSTOMER.id}.`) && p.to === 'public.payment',
)!;

describe('the prompt a lookup sends', () => {
  it('shows the ids the seal will accept, bound to what each one means', () => {
    // The menu the model sees and the menu the seal checks come off ONE
    // offer. Built in two places they would be two sets that agree until
    // somebody changed one.
    //
    // 🟥 The whole MAPPING is asserted, not the id alone. The first version
    // checked `text.includes(s.id)` and survived a mutation that replaced the
    // subject lines with bare table names — because `s1` is a substring of the
    // route id `s1.p1`, which was still there. An `includes` on a short id is
    // satisfied by any longer id containing it, so it was passing for a reason
    // that had nothing to do with what it claimed to check.
    for (const s of OFFER.subjects) {
      assert.ok(
        PROMPT.text.includes(`${s.id} = public.${s.entity.table}`),
        `the prompt does not bind ${s.id} to a table`,
      );
    }
    for (const p of OFFER.paths) {
      assert.ok(PROMPT.text.includes(`${p.id} = from `), `the prompt does not bind ${p.id}`);
    }
  });

  it('puts the question and the menu INSIDE the fence, both as the customer’s', () => {
    assert.equal(PROMPT.blocks, 3);
    for (const b of PARTS.untrusted) {
      assert.equal(b.egressClass, 'customer-system-metadata');
    }
  });

  it('names the closed vocabulary of what a database cannot know', () => {
    assert.ok(PROMPT.text.includes('application_logs'));
    assert.ok(PROMPT.text.includes('events_not_recorded'));
  });
});

describe('a model that chooses inside the menu', () => {
  it('comes back as a sealed choice that resolves against the map', async () => {
    const { out, calls } = await ask({
      answerable: true,
      subject: CUSTOMER.id,
      follow: [TO_PAYMENT.id],
      outside: ['external_service'],
    });

    assert.equal(out.state, 'answered');
    if (out.state !== 'answered') return;

    const resolved = resolveLookup(out.lookup, OFFER);
    assert.ok(resolved);
    assert.equal(resolved.subject.entity.table, 'customer');
    assert.equal(resolved.routes[0]?.to, 'public.payment');
    assert.equal(calls[0]?.outcome, 'ok');
  });

  it('keeps what it said is outside the database', async () => {
    const { out } = await ask({
      answerable: true,
      subject: CUSTOMER.id,
      follow: [],
      outside: ['external_service', 'application_logs'],
    });
    assert.equal(out.state, 'answered');
    if (out.state !== 'answered') return;
    assert.deepEqual([...out.lookup.outside], ['external_service', 'application_logs']);
  });
});

describe('a model that answers plausibly and wrongly', () => {
  it('🟥 names a table instead of an id — the ㉔ failure, and a failed call', async () => {
    // Fluent, well-formed, and about a table the menu never offered. This is
    // the one shape a reader cannot catch, so it has to fail here.
    const { out, calls } = await ask({
      answerable: true,
      subject: 'public.secrets',
      follow: [],
      outside: [],
    });
    assert.equal(out.state, 'unavailable');
    assert.equal(calls[0]?.outcome, 'failed');
    if (out.state === 'unavailable') assert.match(out.why, /never\s+offered/);
  });

  it('🟥 follows a route nobody offered', async () => {
    const { out } = await ask({
      answerable: true,
      subject: CUSTOMER.id,
      follow: ['s9.p9'],
      outside: [],
    });
    assert.equal(out.state, 'unavailable');
  });

  it('🟥 hands back SQL alongside its choice', async () => {
    // The moment a field like this is accepted, the product is no longer the
    // thing that writes queries, whatever the call site does with it.
    const { out } = await ask({
      answerable: true,
      subject: CUSTOMER.id,
      follow: [],
      outside: [],
      sql: 'SELECT * FROM public.customer',
    });
    assert.equal(out.state, 'unavailable');
  });

  it('says the database can answer and names nowhere to look', async () => {
    const { out } = await ask({
      answerable: true,
      subject: null,
      follow: [],
      outside: [],
    });
    assert.equal(out.state, 'unavailable');
  });

  it('refuses without naming the gap', async () => {
    const { out } = await ask({
      answerable: false,
      subject: null,
      follow: [],
      outside: [],
    });
    assert.equal(out.state, 'unavailable');
  });

  it('🟩 a refusal that DOES name the gap is a real answer, not a failure', async () => {
    const { out, calls } = await ask({
      answerable: false,
      subject: null,
      follow: [],
      outside: ['credential_check', 'cache_or_session_store'],
    });
    assert.equal(out.state, 'answered');
    assert.equal(calls[0]?.outcome, 'ok');
    if (out.state === 'answered') assert.equal(resolveLookup(out.lookup, OFFER), null);
  });
});

describe('the egress gate applies here too', () => {
  it('🟥 the menu is under the permit — one changed id and nothing is sent', async () => {
    const { impl, seen } = replies({ answerable: true, subject: CUSTOMER.id, follow: [], outside: [] });
    const outbound = outboundOf(CONFIG, CONFIG.tiers['rules']!, PROMPT);
    const tampered = outbound.body.replace('public.customer', 'public.secrets');
    assert.notEqual(tampered, outbound.body);

    const bad: Egress = {
      ...egress(),
      permit: grantEgress({
        disclosure: describeEgress(PARTS, outbound.destination),
        body: tampered,
        policy: POLICY,
        now: NOW,
        ttlMs: 60_000,
        id: 'tampered',
      }),
    };

    await assert.rejects(
      askLookup(CONFIG, 'rules', PROMPT, OFFER, () => {}, bad, { fetchImpl: impl }),
      /not the one this permit was granted over/,
    );
    // `_doc/27`'s red test: the network function must not have been called.
    assert.equal(seen.length, 0);
  });
});
