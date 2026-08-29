/**
 * The part that talks to a model — HS-D D.1.
 *
 * Separate package for the same reason `connector-postgres` is one: this is
 * where network I/O happens, and the discipline it enforces was decided next
 * door in `@ledar/contracts` where it can be tested with nothing running.
 * `NOTICE` calls that one *"the part that touches your database"*. This is the
 * part that talks to somebody else's.
 *
 * ## Every rule here was measured, not guessed
 *
 * Four behaviours, four field results, all from 2026-08-24:
 *
 * ```text
 * ⑲  max_tokens is spent on REASONING FIRST. glm-4.7-flash used 406 of a
 *     600-token budget thinking, hit the cap, and returned empty content —
 *     HTTP 200, billed in full, not one word. So a tier states a budget that
 *     leaves room for thinking nobody asked for.
 *
 * ⑲  a 200 with empty content is a FAILURE, and the worst-shaped one, because
 *     every client reads 200 as success. It maps to D.5's `unavailable`.
 *
 * ⑲  a failed call still COSTS MONEY. Tokens are recorded whatever happened.
 *     Recording them only on success under-reports spending, which is the one
 *     direction a cost table must never be wrong in.
 *
 * ⑱  /models publishes limits that the gateway does not enforce —
 *     `max_output_tokens: 4096` against a real default of 32768. So nothing
 *     here reads a limit from the provider. The tier says what to ask for.
 * ```
 *
 * ## Two types it cannot be used without
 *
 * `SealedPrompt` in, `SealedAnswer` out. Neither can be produced by an object
 * literal, so this client cannot be handed a prompt somebody assembled in a
 * hurry, and cannot hand back an answer nobody checked against the evidence.
 * The fence and the schema are not options this file could forget.
 *
 * ## Why recording is a required argument
 *
 * `record` is not optional and has no default. D.4's whole acceptance
 * criterion is *measure from day one*, and a recorder that can be omitted is a
 * recorder that will be omitted on the call site written at speed. Making it
 * an argument means a call that does not record does not compile.
 */

import {
  checkEgress,
  framePrompt,
  lookupPromptParts,
  mergeOutside,
  narrowOffer,
  sealAnswer,
  sealLookup,
  subjectPromptParts,
  subjectsOnly,
  type EgressClass,
  type EgressPermit,
  type EvidenceFact,
  type ModelStepState,
  type LookupOffer,
  type PermitLedger,
  type SealedAnswer,
  type SealedLookup,
  type PromptParts,
  type SealedPrompt,
} from '@ledar/contracts';

/**
 * What one tier promises: which model, how hard it thinks, how much it may say.
 *
 * A tier is named for the CONSEQUENCE of the call site, not for speed or
 * price, because model names change and consequences do not. `answers` is a
 * reply a reader sees beside the evidence it came from; `decides` is output
 * that becomes something which runs later, unread.
 */
export type TierConfig = {
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh';
  /**
   * The output budget, INCLUDING room for reasoning.
   *
   * Not "what the answer needs". Field result ⑲: reasoning tokens are spent
   * against this first, and a budget sized for the answer alone comes back
   * empty and bills in full. Never read from `/models` — ⑱ measured that
   * catalogue saying 4096 against a real ceiling of 131072.
   */
  maxTokens: number;
};

export type ModelConfig = {
  /** Origin only, e.g. `https://api.example.dev/v1`. */
  baseUrl: string;
  apiKey: string;
  tiers: Record<string, TierConfig>;
  /**
   * USD per million tokens, by model id, if known.
   *
   * Optional, and its absence is a real answer rather than a gap: without a
   * price there is no cost, and `llm_call` refuses a cost that has no basis.
   */
  prices?: Record<string, { in: number; out: number }>;
  /** Where those prices came from and when. Required whenever `prices` is. */
  priceBasis?: string;
};

/** What `askModel` reports back, in the vocabulary the report already speaks. */
export type Asked =
  | { state: Extract<ModelStepState, 'answered'>; answer: SealedAnswer }
  | { state: Extract<ModelStepState, 'unavailable'>; why: string };

/** What `askLookup` reports back. Same two states, a different sealed thing. */
export type Looked =
  | { state: Extract<ModelStepState, 'answered'>; lookup: SealedLookup }
  | { state: Extract<ModelStepState, 'unavailable'>; why: string };

/** The shape the private transport hands back, before either wrapper names it. */
type SealedCall<T> =
  | { state: Extract<ModelStepState, 'answered'>; value: T }
  | { state: Extract<ModelStepState, 'unavailable'>; why: string };

/**
 * One call's cost record, in the shape `@ledar/store` writes.
 *
 * Structurally typed rather than imported, deliberately: this package has no
 * dependency on the store, the way the store has none on contracts. The store
 * test compares vocabularies; here the shape is small enough that a mismatch
 * fails at the call site, which is the only place both are in scope.
 */
export type CallRecord = {
  runId: number | null;
  tier: string;
  model: string;
  outcome: 'ok' | 'failed' | 'refused';
  cacheHit: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  costMicros: number | null;
  priceBasis: string | null;
  note: string | null;
};

export class ModelUnreachable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnreachable';
  }
}

export class TierUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TierUnknown';
  }
}

export type AskOptions = {
  /** Which run this belongs to, or null when it happens outside one. */
  runId?: number | null;
  /** How long the provider gets. */
  timeoutMs?: number;
  /** Injected for tests. Production passes nothing. */
  fetchImpl?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The exact bytes and the exact URL, built once.
 *
 * Exported because a permit is granted over these and checked against these,
 * and if the caller had to guess at them the guarantee would be that two
 * pieces of code agree today. `askModel` calls this and so does whoever asks
 * a person for consent, so there is one description of what leaves.
 *
 * 🟥 Changing anything in here changes every hash. That is not a hazard to
 * work around — it is the mechanism: a payload nobody agreed to cannot match
 * a permit somebody granted.
 */
export function outboundOf(
  config: ModelConfig,
  tier: TierConfig,
  prompt: SealedPrompt,
): { body: string; destination: string } {
  const base = config.baseUrl.replace(/\/+$/, '');
  return {
    destination: `${base}/chat/completions`,
    body: JSON.stringify({
      model: tier.model,
      max_tokens: tier.maxTokens,
      reasoning_effort: tier.effort,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt.text }],
    }),
  };
}

/**
 * Everything the egress gate needs, and it is REQUIRED.
 *
 * A required parameter rather than an option, so a call site that has not
 * thought about consent does not compile. `_doc/27` puts the gate in this
 * file for exactly this reason: at each caller it becomes the gate that
 * exists and that the real path forgets to call — AGENTS §4.3.
 */
export type Egress = {
  readonly permit: EgressPermit;
  /** Holds which permits are spent. One per session. */
  readonly ledger: PermitLedger;
  /** Consent, retention and redaction versions, as the permit recorded them. */
  readonly policy: string;
  readonly dataClass: EgressClass;
  /** ISO. Passed in rather than read from a clock, so expiry is testable. */
  readonly now: string;
};

function costOf(
  config: ModelConfig,
  model: string,
  inTok: number | null,
  outTok: number | null,
): { micros: number | null; basis: string | null } {
  const price = config.prices?.[model];
  if (!price || !config.priceBasis || inTok === null || outTok === null) {
    // Null is the honest answer. `llm_call` refuses a cost with no basis, and
    // it is right to: a number nobody can re-derive gets quoted as measured.
    return { micros: null, basis: null };
  }
  return {
    micros: Math.round(inTok * price.in + outTok * price.out),
    basis: config.priceBasis,
  };
}

/**
 * One call, recorded either way, and sealed by whatever the caller must seal by.
 *
 * 🟥 NOT EXPORTED, and that is the whole reason it takes `seal` as an
 * argument. The rule this package lives under is that it cannot hand back
 * output nobody checked; a public function with a pluggable seal would let a
 * caller pass something that checks nothing. Private, it is the opposite: the
 * two exported wrappers below each supply a real seal, and there is no third
 * way in.
 *
 * It exists because G3 needs a second kind of sealed answer — a CHOICE from a
 * menu rather than a reply about facts — and the alternative was a second copy
 * of the transport, the cost table and the six failure shapes ⑲ measured.
 *
 * Never throws for a provider fault. A model being down is a thing the report
 * says a sentence about (`model.unavailable`), not an exception that takes the
 * scan with it — the rule packs already produced everything a reader needs,
 * and D.5 exists because losing that to a timeout would be absurd.
 *
 * It DOES throw for a caller fault — an unknown tier, an endpoint that would
 * put the key on the wire in clear, a permit that does not match. Those are
 * bugs here, not weather.
 */
async function callAndSeal<T>(
  config: ModelConfig,
  tierName: string,
  prompt: SealedPrompt,
  record: (call: CallRecord) => void,
  egress: Egress,
  seal: (parsed: unknown) => T,
  options: AskOptions = {},
): Promise<SealedCall<T>> {
  const tier = config.tiers[tierName];
  if (!tier) {
    // The client validates the tier, not the store. `llm_call.tier` is free
    // text on purpose: a history records what happened, including a tier
    // nobody should have accepted. Refusing belongs here, where the config is.
    throw new TierUnknown(
      `No tier called ${JSON.stringify(tierName)}. Configured: ` +
        `${Object.keys(config.tiers).join(', ') || '(none)'}. A tier is a ` +
        `promise about cost and consequence; there is no default for one.`,
    );
  }

  const base = config.baseUrl.replace(/\/+$/, '');
  const isLocal = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(base);
  if (!/^https:\/\//i.test(base) && !isLocal) {
    throw new ModelUnreachable(
      `Refusing to send an API key to ${base}: not https, and not localhost. ` +
        `The Authorization header would cross the wire in clear text.`,
    );
  }

  // ---- the egress gate ----------------------------------------------------
  //
  // 🟥 Everything below this block is network. Everything above it is not, and
  // that is why the check sits exactly here: after the payload is final and
  // before a byte moves. `_doc/27` Module 4 — *"Permit lệch phải thất bại
  // TRƯỚC network."*
  //
  // It THROWS rather than returning `unavailable`. A missing or mismatched
  // permit is a fault in the caller, like an unknown tier or a plaintext
  // endpoint above; the `unavailable` path is for weather. And it does not
  // write a `CallRecord`: that table measures spend, and a call that never
  // happened has no spend to report. Whoever wants an audit trail of refusals
  // keeps one where refusals are the subject.
  const outbound = outboundOf(config, tier, prompt);
  checkEgress(
    egress.permit,
    {
      body: outbound.body,
      destination: outbound.destination,
      dataClass: egress.dataClass,
      policy: egress.policy,
    },
    egress.now,
  );
  // Spent here, not by the caller. A permit marked used by whoever remembered
  // to is a permit that can be replayed by whoever did not — and it is spent
  // BEFORE the request, so a call that fails mid-flight still burns it. One
  // grant is one attempt; retrying is a new decision by a person.
  egress.ledger.spend(egress.permit);

  const doFetch = options.fetchImpl ?? fetch;
  const started = Date.now();

  let status: number | null = null;
  let inTok: number | null = null;
  let outTok: number | null = null;
  let content = '';
  let finish: string | null = null;
  let why: string | null = null;

  try {
    // The URL and the body are the ones the permit was checked against, not
    // rebuilt here. Building them twice would mean the thing checked and the
    // thing sent are two objects that happen to agree.
    const res = await doFetch(outbound.destination, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
      },
      // A 3xx would re-send the Authorization header to whoever answers next,
      // and whether it survives a cross-origin hop is a runtime detail rather
      // than a guarantee this file may lean on.
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      body: outbound.body,
    });
    status = res.status;

    if (status >= 300 && status < 400) {
      why = `the endpoint answered ${status}, a redirect, which was not followed`;
    } else if (!res.ok) {
      why = `the endpoint answered ${status}: ${(await res.text().catch(() => '')).slice(0, 200)}`;
    } else {
      const body = (await res.json()) as {
        choices?: { finish_reason?: string; message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      inTok = body.usage?.prompt_tokens ?? null;
      outTok = body.usage?.completion_tokens ?? null;
      finish = body.choices?.[0]?.finish_reason ?? null;
      content = body.choices?.[0]?.message?.content ?? '';
      if (content.trim() === '') {
        // ⑲: a 200 with nothing in it. Billed in full, and the shape every
        // client reads as success. Named here so it can never be one.
        why =
          `the endpoint answered 200 with no content (finish_reason=` +
          `${finish ?? '?'}). It was billed for ${outTok ?? '?'} output tokens ` +
          `and said nothing`;
      }
    }
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }

  const ms = Date.now() - started;
  const priced = costOf(config, tier.model, inTok, outTok);

  const finishCall = (outcome: CallRecord['outcome'], note: string | null): void => {
    record({
      runId: options.runId ?? null,
      tier: tierName,
      model: tier.model,
      outcome,
      cacheHit: false,
      // ⑲: recorded whatever happened. A failed call still cost money, and a
      // cost table that under-reports on failure is worse than none because
      // the total looks reassuring.
      promptTokens: inTok,
      completionTokens: outTok,
      costMicros: priced.micros,
      priceBasis: priced.basis,
      note,
    });
  };

  if (why !== null) {
    finishCall('failed', `${why} · ${ms}ms`);
    return { state: 'unavailable', why };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const note = `the endpoint answered 200 with content that is not JSON · ${ms}ms`;
    finishCall('failed', note);
    return { state: 'unavailable', why: note };
  }

  let value: T;
  try {
    value = seal(parsed);
  } catch (err) {
    // A model that returns the wrong shape has failed the call. Salvaging part
    // of it is how a reader ends up with half an answer nobody checked — and
    // ㉒ measured a model doing exactly what an attacker asked, which is the
    // shape this refusal turns into silence.
    const note = `${err instanceof Error ? err.message : String(err)} · ${ms}ms`;
    finishCall('failed', note.slice(0, 400));
    return { state: 'unavailable', why: note };
  }

  finishCall('ok', null);
  return { state: 'answered', value };
}

/**
 * VS-8: asks about a finding, and returns an answer checked against the facts
 * it was offered.
 */
export async function askModel(
  config: ModelConfig,
  tierName: string,
  prompt: SealedPrompt,
  offered: readonly EvidenceFact[],
  record: (call: CallRecord) => void,
  egress: Egress,
  options: AskOptions = {},
): Promise<Asked> {
  const out = await callAndSeal(
    config,
    tierName,
    prompt,
    record,
    egress,
    (parsed) => sealAnswer(parsed, offered),
    options,
  );
  return out.state === 'answered' ? { state: 'answered', answer: out.value } : out;
}

/**
 * G3: asks WHERE to look, and returns a choice checked against the menu.
 *
 * The model writes no sentence and no SQL here; it picks ids. `sealLookup`
 * refuses anything that was not offered, which is the only detectable form of
 * the failure ㉔ measured — an answer that is fluent, true, and about somebody
 * else's question.
 *
 * A separate function rather than a flag on `askModel`, because the two seal
 * against different things and a caller must not be able to get the wrong one
 * by passing the wrong argument.
 */
export async function askLookup(
  config: ModelConfig,
  tierName: string,
  prompt: SealedPrompt,
  offer: LookupOffer,
  record: (call: CallRecord) => void,
  egress: Egress,
  options: AskOptions = {},
): Promise<Looked> {
  const out = await callAndSeal(
    config,
    tierName,
    prompt,
    record,
    egress,
    (parsed) => sealLookup(parsed, offer),
    options,
  );
  return out.state === 'answered' ? { state: 'answered', lookup: out.value } : out;
}

/**
 * What the caller must supply for EACH round: a permit over that round's
 * exact bytes.
 *
 * 🟥 A factory, not a permit. `grantEgress` hashes the body, and the two
 * rounds send two different bodies — the second one cannot even be built
 * until the first has answered. A single permit reused across both would
 * either fail `checkEgress` on the second call or, if the hash were dropped
 * to make it work, would be a permit that authorised bytes nobody had seen.
 * The awkwardness of this signature is the permit doing its job.
 *
 * ⚠️ It hands over BOTH the parts and the sealed prompt, and the first version
 * passed only the prompt. `describeEgress` reads the parts to work out the
 * data class, so with the sealed text alone every caller would build a
 * disclosure saying `product-constant` — and `checkEgress` would refuse its
 * own permit at the moment of sending. A test found it; a caller would have
 * found it too, and later.
 */
export type GrantForRound = (round: 1 | 2, parts: PromptParts, prompt: SealedPrompt) => Egress;

/**
 * Choose a subject, then choose routes from that subject's routes alone.
 *
 * ## Why this is two calls
 *
 * N60, measured on a 368-table schema: the SUBJECTS block is 3,324 tokens and
 * the ROUTES block is 507,826. No model takes the second number, so G3 did not
 * run on a real-sized schema at all — and 99.6% of those routes leave subjects
 * the question is not about. Narrowed to one subject the worst case is 2,826
 * tokens.
 *
 * Two cheaper shapes were costed and both died on the numbers: `declared`
 * edges only saves 2.9% (97% of that schema's edges are foreign keys), and
 * one-hop routes only fits but drops 54% of the map, including the
 * `customer → rental → payment` chain that is ideal §33's own example.
 *
 * ## 🟥 What two rounds cost, said plainly
 *
 * Two calls, two prices, two latencies, and **a second place to be wrong**. A
 * subject chosen badly in round one cannot be recovered in round two — round
 * two is only shown that subject's routes, by construction. That is a real
 * loss against the single call, which at least let one decision see
 * everything. It buys the only thing that matters more: on a real schema the
 * single call cannot be made at all.
 */
export async function askLookupInTwoRounds(
  config: ModelConfig,
  tierName: string,
  question: string,
  offer: LookupOffer,
  record: (call: CallRecord) => void,
  grant: GrantForRound,
  options: AskOptions = {},
): Promise<Looked> {
  // 🟥 The FULL offer builds the prompt; the subjects-only offer is what the
  // answer is sealed against. Those are two different jobs and passing the
  // narrowed one to both looks tidier and is wrong: the hints — "links to
  // payment, rental; 9 routes" — are derived from `offer.paths`, so with the
  // stripped offer they came out empty and round one chose from bare table
  // names. Measured, justified, and silently not sent. A test found it.
  const firstParts = subjectPromptParts(question, offer);
  const first = framePrompt(firstParts);
  const round1 = await askLookup(
    config,
    tierName,
    first,
    // Sealed against the SUBJECTS-only menu, so `follow` is refused rather
    // than asked not to be filled in: the offer has no paths, so any id there
    // is an id that was never offered.
    subjectsOnly(offer),
    record,
    grant(1, firstParts, first),
    options,
  );
  if (round1.state !== 'answered') return round1;

  // A round that decided the database cannot answer has finished. Asking it to
  // pick routes anyway would be this product overriding an admission it just
  // asked for.
  //
  // ⚠️ `!answerable` here is UNREACHABLE, and that is worth writing down rather
  // than leaving for the next reader to rediscover. A mutation run removed it
  // and nothing went red, which normally means a check nobody has checked —
  // but here it means something stronger: `round1.lookup` is a `SealedLookup`,
  // and `sealLookup` already refuses `answerable: false` with a subject
  // attached. So the two clauses cannot disagree, and the second alone decides.
  //
  // Kept because it states the intent at the place the decision is made. A
  // reader of this line should not have to know the seal's rules to see why a
  // refusal stops here.
  if (!round1.lookup.answerable || round1.lookup.subject === null) return round1;

  const narrowed = narrowOffer(offer, round1.lookup.subject);
  const secondParts = lookupPromptParts(question, narrowed);
  const second = framePrompt(secondParts);
  const round2 = await askLookup(
    config,
    tierName,
    second,
    narrowed,
    record,
    grant(2, secondParts, second),
    options,
  );
  if (round2.state !== 'answered') return round2;

  // 🟥 Round two is allowed to change its mind, and saying so is not the same
  // as failing. Looking at the actual routes it may see that none of them
  // reaches the question — and the merge below would then produce
  // `answerable: false` with round one's subject still attached, which
  // `sealLookup` refuses outright as *"two different answers"*. Correctly:
  // that pairing IS incoherent. But turning a considered refusal into a dead
  // call would throw away the one thing a refusal carries, which is what it
  // says is outside, from BOTH rounds.
  if (!round2.lookup.answerable) {
    return {
      state: 'answered',
      lookup: sealLookup(
        {
          answerable: false,
          subject: null,
          follow: [],
          outside: mergeOutside(round1.lookup.outside, round2.lookup.outside),
        },
        narrowed,
      ),
    };
  }

  // 🟥 Re-sealed rather than returned, because the value that leaves here is
  // not what either round said on its own: the subject is round one's and the
  // admissions are the union of both. Building that object and handing it out
  // as if it had been checked would be a `SealedLookup` nobody sealed — the
  // exact hole the brand exists to make impossible.
  const merged = sealLookup(
    {
      answerable: round2.lookup.answerable,
      // ⚠️ Round one's, and — like the `!answerable` clause above — a mutation
      // run showed this cannot differ from round two's. The narrowed offer
      // holds exactly one subject; `sealLookup` refuses any other id and
      // refuses `answerable: true` with none; and this line is only reached
      // when round two is answerable. So round two's subject IS round one's,
      // provably rather than usually.
      //
      // Round one's is still what is read, because round one is the round
      // that chose. Reading round two's would be depending on an echo.
      subject: round1.lookup.subject,
      follow: round2.lookup.follow,
      outside: mergeOutside(round1.lookup.outside, round2.lookup.outside),
    },
    narrowed,
  );
  return { state: 'answered', lookup: merged };
}
