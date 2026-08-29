/**
 * N60: the menu did not fit, so the choice became two.
 *
 * Measured on a real 368-table schema before any of this was written:
 *
 * ```text
 *   the SUBJECTS block alone      368 lines ·    13,294 bytes ≈   3,324 tokens
 *   the ROUTES block alone     24,174 lines · 2,031,303 bytes ≈ 507,826 tokens
 * ```
 *
 * G3 could not be asked at all on a schema that size. What every test below
 * protects is the property that makes two rounds worth their extra call: round
 * two is shown ONE subject's routes, and it is shown them because the offer it
 * is sealed against contains nothing else.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LookupRefused,
  PermitLedger,
  describeEgress,
  framePrompt,
  grantEgress,
  graphFrom,
  lookupOffer,
  lookupPromptParts,
  narrowOffer,
  subjectPromptParts,
  subjectsOnly,
} from '@ledar/contracts';
import type { GraphSource, LookupOffer, PromptParts, SealedPrompt } from '@ledar/contracts';

import { askLookupInTwoRounds, outboundOf } from '../src/index.js';
import type { CallRecord, Egress, ModelConfig } from '../src/index.js';

const CONFIG: ModelConfig = {
  baseUrl: 'https://api.example.dev/v1',
  apiKey: 'not-a-real-key',
  tiers: { rules: { model: 'deepseek-v4-flash', effort: 'low', maxTokens: 2000 } },
};

const POLICY = 'consent=test/1 retention=none/1 redaction=fence/1';
const NOW = '2026-08-28T12:00:00.000Z';

/**
 * Three tables and two foreign keys, so there is more than one subject to
 * choose wrongly between — a one-subject fixture would make every narrowing
 * assertion below true by having nothing to exclude.
 */
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

const OFFER = lookupOffer(graphFrom(SOURCE));
const QUESTION = 'A customer paid and has no rental. Where should I look?';

function subjectIdOf(offer: LookupOffer, table: string): string {
  return offer.subjects.find((s) => s.entity.table === table)!.id;
}

/**
 * A permit over the exact bytes of whichever round is asking.
 *
 * 🟥 Built per round, which is the whole reason `askLookupInTwoRounds` takes a
 * factory rather than a permit: `grantEgress` hashes the body, and round two's
 * body does not exist until round one has answered.
 */
function granter(seen: { round: number; bodyHash: string }[]) {
  return (round: 1 | 2, parts: PromptParts, prompt: SealedPrompt): Egress => {
    const outbound = outboundOf(CONFIG, CONFIG.tiers['rules']!, prompt);
    seen.push({ round, bodyHash: outbound.body });
    return {
      permit: grantEgress({
        // 🟥 The real parts, not a synthesis from the sealed text. Built from
        // `{ instruction: prompt.text, untrusted: [] }` the disclosure comes
        // out `product-constant`, and `checkEgress` then refuses the very
        // permit this function just granted. That is how the signature came
        // to pass both.
        disclosure: describeEgress(parts, outbound.destination),
        body: outbound.body,
        policy: POLICY,
        now: NOW,
        ttlMs: 60_000,
        id: `permit-round-${round}`,
      }),
      ledger: new PermitLedger(),
      policy: POLICY,
      dataClass: 'customer-system-metadata',
      now: NOW,
    };
  };
}

/** A fetch that answers each call from a queue and records what it was sent. */
function scripted(replies: readonly unknown[]) {
  const sent: string[] = [];
  let at = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    sent.push(String(init.body));
    const reply = replies[at] ?? replies[replies.length - 1];
    at += 1;
    if (reply === null) throw new Error('the provider did not answer');
    return {
      status: 200,
      ok: true,
      json: async () => ({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(reply) } }],
        usage: { prompt_tokens: 400, completion_tokens: 60 },
      }),
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { impl, sent, calls: (): number => at };
}

async function bothRounds(replies: readonly unknown[]) {
  const calls: CallRecord[] = [];
  const permits: { round: number; bodyHash: string }[] = [];
  const net = scripted(replies);
  const out = await askLookupInTwoRounds(
    CONFIG,
    'rules',
    QUESTION,
    OFFER,
    (c) => calls.push(c),
    granter(permits),
    { fetchImpl: net.impl },
  );
  return { out, calls, permits, sent: net.sent, rounds: net.calls() };
}

describe('N60 — round one is shown subjects and no routes', () => {
  it('🟥 the first prompt contains no route ids at all', () => {
    // The WHOLE offer, because the hints are derived from its paths. The
    // subjects-only offer is what the answer is sealed against, which is a
    // different job — see the test below, which is the one that pins it.
    const text = framePrompt(subjectPromptParts(QUESTION, OFFER)).text;
    // The route ids are `s1.p1` and so on. Not one may appear: if any did,
    // the block that is 507,826 tokens on a real schema would be back.
    assert.equal(/\bs\d+\.p\d+\b/.test(text), false);
    // And the subjects ARE there, with the hint that stops round one choosing
    // from bare names.
    assert.match(text, /public\.customer/);
    assert.match(text, /links to/);
  });

  it('🟥 handed the stripped offer instead, it silently loses every hint', () => {
    // This is not a test of a thing that should happen — it is the trap,
    // written down. `askLookupInTwoRounds` passed `subjectsOnly(offer)` here
    // in its first version, which reads as the obvious choice and produced
    // subjects with no hints at all: measured at 31,146 bytes on the real
    // schema, justified in a comment, and never actually sent.
    //
    // It fails quietly by construction — the prompt is still well-formed and
    // the model still answers — so the only thing that can catch it is an
    // assertion that the two calls differ.
    const stripped = framePrompt(subjectPromptParts(QUESTION, subjectsOnly(OFFER))).text;
    assert.equal(/links to/.test(stripped), false);
    assert.ok(
      stripped.length < framePrompt(subjectPromptParts(QUESTION, OFFER)).text.length,
      'the stripped prompt is not smaller, so the hints were never in either',
    );
  });

  it('🟥 SENDS the hints, not just computes them', async () => {
    // The two tests above check `subjectPromptParts`. Neither checks what
    // `askLookupInTwoRounds` actually puts on the wire, and the bug it is
    // guarding against lived in exactly that gap: the caller passed the
    // stripped offer, the prompt builder did its job on the wrong input, and
    // both direct tests stayed green. Assert the payload.
    const customer = subjectIdOf(OFFER, 'customer');
    const chosen = OFFER.paths.filter((p) => p.id.startsWith(`${customer}.`));
    const { sent } = await bothRounds([
      { answerable: true, subject: customer, follow: [], outside: [] },
      { answerable: true, subject: customer, follow: [chosen[0]!.id], outside: [] },
    ]);
    assert.match(sent[0]!, /links to/);
  });

  it('is sealed against a menu with no routes, so `follow` cannot be filled', async () => {
    // The instruction asks for an empty `follow`; the gate is what enforces
    // it. Asking politely and checking are different things, and only one of
    // them survives a payload.
    const { out, rounds } = await bothRounds([
      { answerable: true, subject: subjectIdOf(OFFER, 'customer'), follow: ['s1.p1'], outside: [] },
    ]);
    assert.equal(out.state, 'unavailable');
    assert.match(out.state === 'unavailable' ? out.why : '', /never offered/);
    assert.equal(rounds, 1, 'a refused first round must not lead to a second call');
  });
});

describe('N60 — round two sees one subject and only its routes', () => {
  it('🟥 the second prompt offers no route belonging to another subject', async () => {
    const customer = subjectIdOf(OFFER, 'customer');
    const rental = subjectIdOf(OFFER, 'rental');
    const chosen = OFFER.paths.filter((p) => p.id.startsWith(`${customer}.`));
    const { sent, rounds } = await bothRounds([
      { answerable: true, subject: customer, follow: [], outside: [] },
      { answerable: true, subject: customer, follow: [chosen[0]!.id], outside: [] },
    ]);
    assert.equal(rounds, 2);

    const second = sent[1]!;
    // 🟥 Matched against the ids the offer actually holds, not scraped with a
    // pattern. The first version used /\b(s\d+)\.p\d+\b/ and found nothing:
    // in a JSON body a newline is the two characters `\` and `n`, so the
    // character before `s1` is a word character and `\b` never matches. It
    // reported "the second round was shown no routes at all" about a payload
    // that was full of them.
    for (const p of chosen) {
      assert.ok(second.includes(p.id), `the second round was not shown ${p.id}`);
    }
    // And not one route belonging to anybody else.
    for (const p of OFFER.paths.filter((q) => !q.id.startsWith(`${customer}.`))) {
      assert.equal(second.includes(p.id), false, `${p.id} leaked into round two`);
    }
    assert.equal(second.includes(`${rental}.p`), false);
  });

  it('round two must restate the subject, and is refused when it does not', async () => {
    // 🟥 Written the other way round from how it started. The first version
    // asserted that omitting `subject` in round two was tolerated, because
    // round two is only being asked about routes and a model in that position
    // plausibly leaves it out. It is not tolerated: round two's own
    // `sealLookup` refuses `answerable: true` with nothing to look at, before
    // anything here merges.
    //
    // That makes "take round one's subject" and "take round two's" the same
    // program — by construction, not by luck. The narrowed offer holds exactly
    // one subject, the seal refuses any other and refuses null-with-answerable,
    // so at the merge round two's subject can only be round one's. Round one's
    // is still what the code reads: it is the round that chose.
    const customer = subjectIdOf(OFFER, 'customer');
    const chosen = OFFER.paths.filter((p) => p.id.startsWith(`${customer}.`));
    const { out } = await bothRounds([
      { answerable: true, subject: customer, follow: [], outside: [] },
      { answerable: true, subject: null, follow: [chosen[0]!.id], outside: [] },
    ]);
    assert.equal(out.state, 'unavailable');
    assert.match(out.state === 'unavailable' ? out.why : '', /names nothing to look at/);
  });

  it('refuses a route from another subject, at the seal rather than later', async () => {
    // 🟩 Against the WHOLE menu this passes `sealLookup` and is caught one
    // layer later by `resolveLookup`, on its way to building a query. Against
    // the narrowed menu the other subject's routes are not in the offer, so
    // the same mistake stops at the earlier gate. A narrower menu is a
    // stricter seal, and this is the assertion that says so.
    const customer = subjectIdOf(OFFER, 'customer');
    const rental = subjectIdOf(OFFER, 'rental');
    const strayed = OFFER.paths.find((p) => p.id.startsWith(`${rental}.`))!;
    const { out } = await bothRounds([
      { answerable: true, subject: customer, follow: [], outside: [] },
      { answerable: true, subject: customer, follow: [strayed.id], outside: [] },
    ]);
    assert.equal(out.state, 'unavailable');
    assert.match(out.state === 'unavailable' ? out.why : '', /never offered/);
  });

  it('keeps round one’s subject, and the union of what both rounds admitted', async () => {
    const customer = subjectIdOf(OFFER, 'customer');
    const chosen = OFFER.paths.filter((p) => p.id.startsWith(`${customer}.`));
    const { out } = await bothRounds([
      { answerable: true, subject: customer, follow: [], outside: ['external_service'] },
      { answerable: true, subject: customer, follow: [chosen[0]!.id], outside: ['application_logs'] },
    ]);
    assert.equal(out.state, 'answered');
    if (out.state !== 'answered') return;
    assert.equal(out.lookup.subject, customer);
    // 🟥 Both, and this is the assertion that matters most on this line. Round
    // one sees the question with no joins in front of it and is the round most
    // likely to notice the mail provider; round two is reading a list of
    // routes and may forget. Taking only round two would drop an admission
    // that had already been made — the Admit half of ideal §1, lost to
    // plumbing rather than to a payload.
    assert.deepEqual([...out.lookup.outside].sort(), ['application_logs', 'external_service']);
  });
});

describe('N60 — a first round that ends the question ends it', () => {
  it('does not ask for routes when the database cannot be aimed at all', async () => {
    const { out, rounds } = await bothRounds([
      { answerable: false, subject: null, follow: [], outside: ['external_service'] },
    ]);
    assert.equal(rounds, 1);
    assert.equal(out.state, 'answered');
    if (out.state !== 'answered') return;
    assert.equal(out.lookup.answerable, false);
    assert.deepEqual([...out.lookup.outside], ['external_service']);
  });

  it('🟥 lets round two change its mind, and keeps what BOTH rounds admitted', async () => {
    // Round two is the first round to see the actual joins, so it is the one
    // that can discover no route reaches the question. Merged naively that
    // becomes `answerable: false` with round one's subject still attached,
    // which `sealLookup` refuses as two different answers — turning a
    // considered refusal into a dead call and losing the admissions with it.
    const customer = subjectIdOf(OFFER, 'customer');
    const { out, rounds } = await bothRounds([
      { answerable: true, subject: customer, follow: [], outside: ['external_service'] },
      { answerable: false, subject: null, follow: [], outside: ['application_logs'] },
    ]);
    assert.equal(rounds, 2);
    assert.equal(out.state, 'answered');
    if (out.state !== 'answered') return;
    assert.equal(out.lookup.answerable, false);
    assert.equal(out.lookup.subject, null);
    assert.deepEqual([...out.lookup.outside].sort(), ['application_logs', 'external_service']);
  });

  it('does not ask a second time when the first call never answered', async () => {
    const { out, rounds } = await bothRounds([null]);
    assert.equal(rounds, 1);
    assert.equal(out.state, 'unavailable');
  });
});

describe('N60 — one permit per round, over that round’s own bytes', () => {
  it('🟥 grants twice, and the two bodies are different', async () => {
    const customer = subjectIdOf(OFFER, 'customer');
    const chosen = OFFER.paths.filter((p) => p.id.startsWith(`${customer}.`));
    const { permits } = await bothRounds([
      { answerable: true, subject: customer, follow: [], outside: [] },
      { answerable: true, subject: customer, follow: [chosen[0]!.id], outside: [] },
    ]);
    assert.deepEqual(permits.map((p) => p.round), [1, 2]);
    // If one permit could cover both, it would be authorising bytes nobody
    // had seen when it was granted — round two's prompt does not exist until
    // round one has answered.
    assert.notEqual(permits[0]!.bodyHash, permits[1]!.bodyHash);
  });
});

describe('N60 — narrowing itself', () => {
  it('keeps route ids unchanged across rounds', () => {
    const customer = subjectIdOf(OFFER, 'customer');
    const narrowed = narrowOffer(OFFER, customer);
    // Renumbering per round would make two rounds' transcripts describe
    // different maps in the same words.
    for (const p of narrowed.paths) {
      assert.ok(OFFER.paths.some((q) => q.id === p.id && q.to === p.to));
    }
    assert.deepEqual(narrowed.subjects.map((s) => s.id), [customer]);
  });

  it('🟥 refuses to narrow to a subject that was never offered', () => {
    // An empty second-round menu would ask a model to choose from nothing,
    // and a model asked to choose from nothing answers something.
    assert.throws(() => narrowOffer(OFFER, 's999'), LookupRefused);
  });

  it('makes the second prompt smaller than the whole menu', () => {
    const customer = subjectIdOf(OFFER, 'customer');
    const whole = framePrompt(lookupPromptParts(QUESTION, OFFER)).text.length;
    const narrow = framePrompt(lookupPromptParts(QUESTION, narrowOffer(OFFER, customer))).text.length;
    assert.ok(narrow < whole, `narrowed ${narrow} is not smaller than whole ${whole}`);
  });
});
