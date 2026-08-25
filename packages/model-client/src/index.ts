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
  sealAnswer,
  type EvidenceFact,
  type ModelStepState,
  type SealedAnswer,
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
 * Asks one model one question, and records what it cost either way.
 *
 * Never throws for a provider fault. A model being down is a thing the report
 * says a sentence about (`model.unavailable`), not an exception that takes the
 * scan with it — the rule packs already produced everything a reader needs,
 * and D.5 exists because losing that to a timeout would be absurd.
 *
 * It DOES throw for a caller fault — an unknown tier, an endpoint that would
 * put the key on the wire in clear. Those are bugs here, not weather.
 */
export async function askModel(
  config: ModelConfig,
  tierName: string,
  prompt: SealedPrompt,
  offered: readonly EvidenceFact[],
  record: (call: CallRecord) => void,
  options: AskOptions = {},
): Promise<Asked> {
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

  const doFetch = options.fetchImpl ?? fetch;
  const started = Date.now();

  let status: number | null = null;
  let inTok: number | null = null;
  let outTok: number | null = null;
  let content = '';
  let finish: string | null = null;
  let why: string | null = null;

  try {
    const res = await doFetch(`${base}/chat/completions`, {
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
      body: JSON.stringify({
        model: tier.model,
        max_tokens: tier.maxTokens,
        reasoning_effort: tier.effort,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt.text }],
      }),
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

  let answer: SealedAnswer;
  try {
    answer = sealAnswer(parsed, offered);
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
  return { state: 'answered', answer };
}
