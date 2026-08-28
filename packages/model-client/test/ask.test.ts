/**
 * The client, against every shape a provider actually produced.
 *
 * Nothing here is invented. Each fake response below was observed on
 * 2026-08-24 across 192 real calls, and each assertion names the field result
 * it comes from. A test suite for a network client is otherwise a suite about
 * what its author imagined a network does.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EgressRefused,
  PermitLedger,
  describeEgress,
  framePrompt,
  grantEgress,
} from '@ledar/contracts';
import type { EvidenceFact, PromptParts } from '@ledar/contracts';

import { ModelUnreachable, TierUnknown, askModel, outboundOf } from '../src/index.js';
import type { CallRecord, Egress, ModelConfig } from '../src/index.js';

const OFFERED: EvidenceFact[] = [
  { id: 'rows_examined', label: 'how many rows', labelKey: 'fact.rows-examined', value: '49148' },
  { id: 'column', label: 'which column', labelKey: 'fact.column', value: 'public.votes.post_id' },
];

const CONFIG: ModelConfig = {
  baseUrl: 'https://api.example.dev/v1',
  apiKey: 'not-a-real-key',
  tiers: {
    // ⑲: the budget leaves room for reasoning, which is spent first.
    answers: { model: 'deepseek-v4-flash', effort: 'low', maxTokens: 2000 },
  },
  prices: { 'deepseek-v4-flash': { in: 0.264, out: 0.792 } },
  priceBasis: 'a price list, read on a date',
};

const PARTS: PromptParts = {
  instruction: 'Answer in the JSON shape.',
  untrusted: [
    { label: 'facts', egressClass: 'customer-system-metadata', content: 'rows_total: 49148' },
  ],
};

const PROMPT = framePrompt(PARTS);

const POLICY = 'consent=test/1 retention=none/1 redaction=fence/1';
const NOW = '2026-08-28T12:00:00.000Z';

/**
 * A permit over the payload this suite actually sends.
 *
 * Built from `outboundOf` rather than by hand, which is the point of that
 * function being exported: the bytes consented to and the bytes sent are one
 * object, not two that agree today.
 */
function egressFor(
  over: Partial<{ body: string; destination: string; config: ModelConfig }> = {},
): Egress {
  const config = over.config ?? CONFIG;
  const outbound = outboundOf(config, config.tiers['answers']!, PROMPT);
  const disclosure = describeEgress(PARTS, over.destination ?? outbound.destination);
  return {
    permit: grantEgress({
      disclosure,
      body: over.body ?? outbound.body,
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

/** A fetch that returns one canned response and remembers what it was sent. */
function fakeFetch(response: {
  status?: number;
  json?: unknown;
  text?: string;
  throws?: string;
}) {
  const seen: {
    url: string;
    body: Record<string, unknown>;
    /** The bytes exactly as handed over, for the egress gate's byte identity. */
    raw: string;
    headers: unknown;
    redirect: RequestInit['redirect'];
  }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    seen.push({
      url: String(url),
      body: JSON.parse(String(init.body)),
      raw: String(init.body),
      headers: init.headers,
      redirect: init.redirect,
    });
    if (response.throws) throw new Error(response.throws);
    const status = response.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => response.json,
      text: async () => response.text ?? '',
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const answered = (content: unknown, usage = { prompt_tokens: 400, completion_tokens: 260 }) => ({
  json: {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }],
    usage,
  },
});

async function ask(response: Parameters<typeof fakeFetch>[0]) {
  const calls: CallRecord[] = [];
  const { impl, seen } = fakeFetch(response);
  const out = await askModel(CONFIG, 'answers', PROMPT, OFFERED, (c) => calls.push(c), egressFor(), {
    fetchImpl: impl,
  });
  return { out, calls, seen };
}

describe('a model that answers', () => {
  it('returns a sealed answer and records what it cost', async () => {
    const { out, calls } = await ask(
      answered({ answerable: true, facts: ['column'], missing: [] }),
    );
    assert.equal(out.state, 'answered');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.outcome, 'ok');
    assert.equal(calls[0]?.promptTokens, 400);
    assert.equal(calls[0]?.completionTokens, 260);
    // 400 * 0.264 + 260 * 0.792 = 105.6 + 205.92 = 311.52 -> 312
    assert.equal(calls[0]?.costMicros, 312);
    assert.equal(calls[0]?.priceBasis, 'a price list, read on a date');
  });

  it('asks for what the TIER says, never for what a provider publishes', async () => {
    // ⑱: /models said max_output_tokens 4096 against a real ceiling of
    // 131072. Nothing here reads a limit from the provider.
    const { seen } = await ask(answered({ answerable: true, facts: ['column'], missing: [] }));
    assert.equal(seen[0]?.body['max_tokens'], 2000);
    assert.equal(seen[0]?.body['model'], 'deepseek-v4-flash');
    assert.equal(seen[0]?.body['reasoning_effort'], 'low');
    assert.deepEqual(seen[0]?.body['response_format'], { type: 'json_object' });
  });
});

describe('the shapes a provider really produced', () => {
  it('treats 200 with empty content as a failure, not a success', async () => {
    // ⑲, and the worst-shaped failure there is: HTTP 200, billed in full,
    // not one word. Every client reads 200 as success.
    const { out, calls } = await ask({
      json: {
        choices: [{ finish_reason: 'length', message: { content: '' } }],
        usage: { prompt_tokens: 505, completion_tokens: 2000 },
      },
    });
    assert.equal(out.state, 'unavailable');
    assert.match(String((out as { why: string }).why), /200 with no content/);
    assert.equal(calls[0]?.outcome, 'failed');
  });

  it('records the tokens a FAILED call burned', async () => {
    // ⑲ again, and the direction a cost table must never be wrong in. My own
    // tool got this wrong once and under-reported spending.
    const { calls } = await ask({
      json: {
        choices: [{ finish_reason: 'length', message: { content: '' } }],
        usage: { prompt_tokens: 505, completion_tokens: 2000 },
      },
    });
    assert.equal(calls[0]?.completionTokens, 2000);
    assert.ok((calls[0]?.costMicros ?? 0) > 0, 'a call that burned 2000 tokens cost nothing');
  });

  it('survives a 503 without taking the scan down', async () => {
    // A provider being down is a sentence the report says, not an exception.
    // The rule packs already produced everything a reader needs.
    const { out, calls } = await ask({ status: 503, text: '{"error":{"message":"unavailable"}}' });
    assert.equal(out.state, 'unavailable');
    assert.equal(calls[0]?.outcome, 'failed');
    assert.equal(calls[0]?.promptTokens, null, 'a 503 reported no usage to record');
  });

  it('does not follow a redirect, and TELLS fetch not to', async () => {
    // 🟥 The second assertion exists because a mutation proved the first one
    // could not fail. Flipping `redirect: 'manual'` to `'follow'` left this
    // test green: the fake returns a 302 whatever it is asked, so checking
    // the outcome checks the fake, not the client.
    //
    // What matters is the instruction on the way OUT — following a 302 would
    // re-send the Authorization header to whoever answers next, and that
    // happens inside fetch where no assertion about the response can see it.
    const { out, seen } = await ask({ status: 302 });
    assert.equal(seen[0]?.redirect, 'manual', 'the client agreed to follow redirects');
    assert.equal(out.state, 'unavailable');
    assert.match(String((out as { why: string }).why), /redirect/);
  });

  it('survives a timeout', async () => {
    const { out, calls } = await ask({ throws: 'The operation was aborted due to timeout' });
    assert.equal(out.state, 'unavailable');
    assert.equal(calls[0]?.outcome, 'failed');
  });

  it('refuses content that is not JSON', async () => {
    const { out, calls } = await ask({
      json: { choices: [{ message: { content: 'Sure! Here is what I found…' } }], usage: {} },
    });
    assert.equal(out.state, 'unavailable');
    assert.equal(calls[0]?.outcome, 'failed');
  });
});

describe('an answer that does not survive the schema', () => {
  it('refuses a fact nobody offered, and records the failure', async () => {
    // ㉒ measured a model doing exactly what an attacker told it. This is the
    // refusal that turns that into silence rather than into a sentence.
    const { out, calls } = await ask(
      answered({ answerable: true, facts: ['user_email'], missing: [] }),
    );
    assert.equal(out.state, 'unavailable');
    assert.equal(calls[0]?.outcome, 'failed');
    assert.match(String(calls[0]?.note), /user_email/);
  });

  it('refuses prose smuggled beside the fields', async () => {
    const { out } = await ask(
      answered({
        answerable: true,
        facts: ['column'],
        missing: [],
        explanation: 'this looks like a data-entry error',
      }),
    );
    assert.equal(out.state, 'unavailable');
  });
});

describe('faults that belong to the caller, not the weather', () => {
  it('throws on a tier nobody configured', async () => {
    // The client validates the tier; the store does not. A history records
    // what happened, including a tier that should have been refused.
    await assert.rejects(
      () =>
        // The tier is checked before the egress gate, so any permit reaches
        // this throw. Passing a real one keeps the test about the tier.
        askModel(CONFIG, 'decides', PROMPT, OFFERED, () => {}, egressFor(), {
          fetchImpl: fakeFetch(answered({ answerable: true, facts: ['column'], missing: [] })).impl,
        }),
      TierUnknown,
    );
  });

  it('refuses to put the key on a plain-http wire', async () => {
    await assert.rejects(
      () =>
        askModel(
          { ...CONFIG, baseUrl: 'http://models.example.dev/v1' },
          'answers',
          PROMPT,
          OFFERED,
          () => {},
          egressFor(),
          { fetchImpl: fakeFetch(answered({ answerable: true, facts: [], missing: [] })).impl },
        ),
      ModelUnreachable,
    );
  });

  it('allows plain http to localhost, which is where a fake endpoint lives', async () => {
    const calls: CallRecord[] = [];
    const local = { ...CONFIG, baseUrl: 'http://127.0.0.1:8080/v1' };
    const out = await askModel(
      local,
      'answers',
      PROMPT,
      OFFERED,
      (c) => calls.push(c),
      // A different baseUrl is a different destination, so it needs its own
      // permit. That it does is the destination binding working.
      egressFor({ config: local }),
      { fetchImpl: fakeFetch(answered({ answerable: true, facts: ['column'], missing: [] })).impl },
    );
    assert.equal(out.state, 'answered');
  });
});

describe('the egress gate — _doc/27 Module 4', () => {
  /**
   * The red test, written as `_doc/27` states it:
   *
   * > *"Cấp permit rồi thay ĐÚNG MỘT định danh schema, hoặc đổi destination.
   * > Nếu hàm network được gọi → module thất bại."*
   *
   * So every assertion here is about `seen.calls`, not about the return
   * value. A gate that refuses AFTER the request has gone is not a gate, and
   * a test that only checks the thrown error cannot tell the difference.
   */
  function watched() {
    const { impl, seen } = fakeFetch(
      answered({ answerable: true, facts: ['column'], missing: [] }),
    );
    return { impl, seen };
  }

  it('🟥 one changed identifier in the payload — nothing reaches the network', async () => {
    const { impl, seen } = watched();
    // A permit granted over a DIFFERENT payload: same shape, one table name
    // apart. This is the shape ㉔ measured a model producing.
    const elsewhere = outboundOf(CONFIG, CONFIG.tiers['answers']!, PROMPT).body.replace(
      'rows_total',
      'rows_totai',
    );
    await assert.rejects(
      askModel(CONFIG, 'answers', PROMPT, OFFERED, () => {}, egressFor({ body: elsewhere }), {
        fetchImpl: impl,
      }),
      EgressRefused,
    );
    assert.equal(seen.length, 0, 'the request went out despite a mismatched permit');
  });

  it('🟥 a different destination — nothing reaches the network', async () => {
    const { impl, seen } = watched();
    await assert.rejects(
      askModel(
        CONFIG,
        'answers',
        PROMPT,
        OFFERED,
        () => {},
        egressFor({ destination: 'https://elsewhere.example/v1/chat/completions' }),
        { fetchImpl: impl },
      ),
      EgressRefused,
    );
    assert.equal(seen.length, 0);
  });

  it('🟥 a permit already spent — nothing reaches the network', async () => {
    // One grant is one send. Replaying would make a person's single "yes"
    // cover every call after it.
    const egress = egressFor();
    const first = watched();
    await askModel(CONFIG, 'answers', PROMPT, OFFERED, () => {}, egress, {
      fetchImpl: first.impl,
    });
    assert.equal(first.seen.length, 1);

    const second = watched();
    await assert.rejects(
      askModel(CONFIG, 'answers', PROMPT, OFFERED, () => {}, egress, {
        fetchImpl: second.impl,
      }),
      EgressRefused,
    );
    assert.equal(second.seen.length, 0);
  });

  it('🟥 an expired permit — nothing reaches the network', async () => {
    const { impl, seen } = watched();
    await assert.rejects(
      askModel(
        CONFIG,
        'answers',
        PROMPT,
        OFFERED,
        () => {},
        { ...egressFor(), now: '2026-08-28T13:00:00.000Z' },
        { fetchImpl: impl },
      ),
      EgressRefused,
    );
    assert.equal(seen.length, 0);
  });

  it('🟥 a policy the permit was not granted under — nothing reaches the network', async () => {
    const { impl, seen } = watched();
    await assert.rejects(
      askModel(
        CONFIG,
        'answers',
        PROMPT,
        OFFERED,
        () => {},
        { ...egressFor(), policy: 'consent=test/2 retention=forever/1' },
        { fetchImpl: impl },
      ),
      EgressRefused,
    );
    assert.equal(seen.length, 0);
  });

  it('🟥 a refused call writes no cost row, because it cost nothing', async () => {
    // `llm_call` measures spend. A call that never happened has none, and a
    // zero-token row would have to be excluded from every sum afterwards.
    const { impl } = watched();
    const calls: CallRecord[] = [];
    await assert.rejects(
      askModel(
        CONFIG,
        'answers',
        PROMPT,
        OFFERED,
        (c) => calls.push(c),
        egressFor({ destination: 'https://elsewhere.example/v1/chat/completions' }),
        { fetchImpl: impl },
      ),
      EgressRefused,
    );
    assert.deepEqual(calls, []);
  });

  it('the exact payload it was granted over does go', async () => {
    const { impl, seen } = watched();
    const out = await askModel(CONFIG, 'answers', PROMPT, OFFERED, () => {}, egressFor(), {
      fetchImpl: impl,
    });
    assert.equal(out.state, 'answered');
    assert.equal(seen.length, 1);
  });

  it('🟥 the bytes checked are the bytes sent', async () => {
    // Not "a body equal to" — the SAME string. Building the payload twice,
    // once to check and once to send, would make the guarantee "two pieces of
    // code agree today".
    const { impl, seen } = watched();
    await askModel(CONFIG, 'answers', PROMPT, OFFERED, () => {}, egressFor(), {
      fetchImpl: impl,
    });
    assert.equal(seen[0]?.raw, outboundOf(CONFIG, CONFIG.tiers['answers']!, PROMPT).body);
  });
});

describe('what is recorded when nobody can price it', () => {
  it('records no cost rather than a zero', async () => {
    // `llm_call` refuses a cost with no basis, and it is right to: a number
    // nobody can re-derive gets quoted later as measured.
    const calls: CallRecord[] = [];
    // Built by omission rather than by `undefined`, because
    // `exactOptionalPropertyTypes` is on and the two are not the same thing —
    // which is the point of having it on.
    const unpriced = { baseUrl: CONFIG.baseUrl, apiKey: CONFIG.apiKey, tiers: CONFIG.tiers };
    await askModel(
      unpriced,
      'answers',
      PROMPT,
      OFFERED,
      (c) => calls.push(c),
      egressFor({ config: unpriced }),
      { fetchImpl: fakeFetch(answered({ answerable: true, facts: ['column'], missing: [] })).impl },
    );
    assert.equal(calls[0]?.costMicros, null);
    assert.equal(calls[0]?.priceBasis, null);
    assert.equal(calls[0]?.promptTokens, 400, 'the tokens are still facts');
  });
});

describe('every path records exactly one call', () => {
  it('records once, whatever happened', async () => {
    // D.4 measures from day one, and "day one" includes the paths nobody
    // expects to take. A path that forgets to record is a bill with no line.
    for (const response of [
      answered({ answerable: true, facts: ['column'], missing: [] }),
      { json: { choices: [{ message: { content: '' } }], usage: {} } },
      { status: 503, text: 'down' },
      { status: 302 },
      { throws: 'aborted' },
      { json: { choices: [{ message: { content: 'not json' } }], usage: {} } },
      answered({ answerable: true, facts: ['nope'], missing: [] }),
    ]) {
      const { calls } = await ask(response);
      assert.equal(calls.length, 1, `a path recorded ${calls.length} calls`);
    }
  });
});
