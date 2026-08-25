/**
 * What one call to a model cost, and what it cost it on — HS-D D.4.
 *
 * The acceptance criterion is *"đo từ ngày đầu"* — measured from day one — and
 * day one is now, before any call exists. That ordering is the feature. A cost
 * table added after the bills start arriving can only describe spending from
 * the day somebody noticed, and the interesting spending is always earlier.
 *
 * ## Why a cost may not be stored without its basis
 *
 * `costMicros` is a number derived from a price list, and price lists change.
 * A row saying `cost = 412` with nothing saying which prices produced it is a
 * number nobody can re-derive, check, or correct — and it will be read years
 * later as though it were measured. It is not measured; the **tokens** are
 * measured. So the rule, enforced in the DDL rather than remembered here:
 *
 * > a cost may be absent, but a cost may not be present without `priceBasis`.
 *
 * This is the same failure the retirement message had, written down in
 * `AGENTS.md` §4.9 ③: a stored answer whose reasoning has expired is worse
 * than no answer, because it looks exactly like a good one.
 *
 * ## Why null is not zero, again
 *
 * The whole product turns on *zero because it is clean* not reading like *zero
 * because nothing was visible*, and the same split lands here:
 *
 * ```text
 * tokens NULL       nothing was sent, so there is nothing to count
 * tokens 0          nothing was sent AND we know why — a cache hit
 * cost   NULL       either nothing was sent, or no price list covered it
 * cost   0          it was sent and it was free
 * ```
 *
 * ## Why `tier` and `model` are free text
 *
 * Every other closed vocabulary in this system is a CHECK constraint with a
 * tripwire against `@ledar/contracts`. These two are deliberately not, and it
 * is worth saying why so nobody "fixes" it: **the tier list belongs to D.1's
 * configuration, and D.1 does not exist.** Freezing a list of tiers here would
 * be putting a fence around a decision nobody has made yet. Validating a tier
 * against the config is the client's job, at the moment it reads the config;
 * this table's job is to record what actually happened, including a tier the
 * client should not have accepted.
 */

import { z } from 'zod';

/**
 * How one call ended.
 *
 * `refused` is the one that would be easy to leave out and is the reason this
 * is a vocabulary rather than a boolean. A run with no calls in it is
 * ambiguous — nothing needed asking, or everything was declined at the
 * boundary — and those are different facts about a product that promises to
 * say what it did not do.
 */
export const LlmCallOutcome = z.enum([
  /** A model answered, or the cache did. */
  'ok',
  /** The provider errored, timed out, or returned nothing usable. */
  'failed',
  /** This product declined to send it. See `untrusted.ts`. */
  'refused',
]);
export type LlmCallOutcome = z.infer<typeof LlmCallOutcome>;

/** The values, for callers that iterate rather than validate. */
export const LLM_CALL_OUTCOMES = LlmCallOutcome.options;

export const LlmCall = z.object({
  /**
   * Which scan this call belonged to, if any.
   *
   * Nullable because not every call happens inside a scan — onboarding (VS-6)
   * asks before there is anything to scan. A cost record that could only exist
   * inside a run would silently omit the calls that happen first.
   */
  runId: z.number().int().positive().nullable(),

  /** ISO-8601. */
  at: z.string().min(1),

  /** The tier that was asked for. Free text; see the header. */
  tier: z.string().min(1),

  /** What actually answered, as the provider named it. Free text. */
  model: z.string().min(1),

  outcome: LlmCallOutcome,

  /** Whether this was served without contacting anyone. */
  cacheHit: z.boolean(),

  /** Null means nothing was sent, not that nothing was counted. */
  promptTokens: z.number().int().nonnegative().nullable(),
  completionTokens: z.number().int().nonnegative().nullable(),

  /**
   * Millionths of a unit of currency, so no float rounds anybody's bill.
   *
   * Null is a real answer: either nothing was sent, or no price list covered
   * this model. Storing 0 for "we do not know" is the mistake `reltuples` made
   * for row counts, and this project has already paid for that one.
   */
  costMicros: z.number().int().nonnegative().nullable(),

  /**
   * Which price list produced `costMicros` — a version, a date, a name.
   *
   * Required whenever a cost is present. Not a courtesy: without it the cost
   * cannot be re-derived, and an unre-derivable number in a history is a
   * number that will be quoted as measured.
   */
  priceBasis: z.string().min(1).nullable(),

  /** Why it failed or was refused, in one sentence. */
  note: z.string().nullable(),
});
export type LlmCall = z.infer<typeof LlmCall>;
