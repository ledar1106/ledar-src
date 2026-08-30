/**
 * S6: one question, two calls, and a timeline. The main-process side.
 *
 * 🟥 **This is the first place the desktop sends anything anywhere.** Every
 * screen before it reads the person's own database and writes to the person's
 * own disk. So the disclosure here is not a nicety bolted onto an existing
 * feature — it is the feature's boundary, and `askPreview` exists so the
 * boundary is a separate call a reader of the bridge can point at.
 *
 * ## Two calls, one decision
 *
 * N60 split the lookup: a 368-table menu is 511,631 tokens in one call and no
 * model takes it. `askEnvelope` is why the person is still asked once — round
 * two's identifiers are provably a subset of round one's, checked rather than
 * hoped, and `stayedInside` is false the day that stops being true.
 *
 * The PERMIT is still per round, over exact bytes, because `grantEgress`
 * hashes the body and round two's body does not exist until round one has
 * answered. One human decision, two machine permits: those are different
 * things and collapsing either into the other loses something real.
 *
 * ## 🟥 No key is a STATE
 *
 * A packaged build has no model configured — `infra/.env` is a development
 * file and is not in the shipped layout. That is not an error to dress up. The
 * same lesson `saveProfile` learned by returning `ProfileFacts | null`: a
 * person who has not set something up gets told what is missing, not a red box
 * about a failure that did not happen.
 *
 * ⚠️ And it is a real gap rather than a decision. Where a shipped build should
 * keep a key is a security question nobody has answered yet — OS credential
 * store, a proxy that holds it, or the person pasting one into a field. Debt
 * N63. Until then the packaged app says so plainly and asks nothing.
 */

import { randomUUID } from 'node:crypto';

import {
  PermitLedger,
  askEnvelope,
  describeEgress,
  envelopeNote,
  grantEgress,
  graphFrom,
  lookupOffer,
  provenanceNote,
  refOf,
  resolveLookup,
  targetProvenance,
  timelineAimedNowhere,
} from '@ledar/contracts';
import type { LookupOffer } from '@ledar/contracts';
import { connectReadOnly, inspectPrivileges, readSchemaGraph } from '@ledar/connector-postgres';
import { askLookupInTwoRounds, destinationOf, outboundOf } from '@ledar/model-client';
import type { CallRecord, ModelConfig } from '@ledar/model-client';
import { runTrace } from '@ledar/tracer';

import type { AskOutcome, AskPreview, SessionHandle } from '../shared/ipc.js';
import { dsnFor } from './session.js';

/** The same list every other flow reads. */
const SCHEMAS = ['public'];

const TIER = 'rules';
const POLICY = 'consent=desktop-ask/1 retention=none/1 redaction=fence/1';
const TIMEOUT_MS = 180_000;
const PERMIT_TTL_MS = 180_000;

/** Longest question accepted. Anything past this is not a question. */
const MAX_QUESTION = 2000;

/**
 * The model configuration, or null when this build has none.
 *
 * Read from the environment and nowhere else. A file path would be a guess
 * about where this process is running from, and the packaged app runs from a
 * directory with no repository anywhere near it — so the honest answer there
 * is null, arrived at by the same code path rather than by a special case.
 */
export function modelConfig(): ModelConfig | null {
  const baseUrl = process.env['AI_BASE_URL']?.trim();
  const apiKey = process.env['AI_API_KEY']?.trim();
  if (!baseUrl || !apiKey) return null;
  // Tiers are product configuration rather than a secret, but they live in
  // `infra/` and are not in the shipped layout either. Written out here so the
  // desktop needs no file at all: one tier, the one this screen uses.
  //
  // ⚠️ A second copy of a value that also lives in `infra/ai-tiers.json`, and
  // that is debt N57's shape. It is taken deliberately and narrowly — the
  // model NAME is the only field duplicated, and `ask-flow.test.ts` asserts
  // the two agree, so a tier changed there without changing this goes red.
  return {
    baseUrl,
    apiKey,
    tiers: { [TIER]: { model: 'qwen3.8-27b', effort: 'low', maxTokens: 2000 } },
  };
}

/**
 * Opens the database the handle names and reads its map.
 *
 * Re-proves read-only first, for the reason `scan-flow` gives at length: the
 * handle was issued because the database refused a write in front of us, and
 * that was a measurement of a moment. This screen sends table names to a third
 * party, so the premise being current matters more here, not less.
 */
async function offerFor(
  handle: SessionHandle,
): Promise<{ ok: true; offer: LookupOffer; dsn: string } | { ok: false; why: string }> {
  const dsn = dsnFor(handle);
  if (dsn === null) return { ok: false, why: 'This session is not open. Connect again.' };

  const client = await connectReadOnly({ dsn });
  try {
    const verdict = await inspectPrivileges(client, SCHEMAS);
    if (verdict.kind !== 'read_only_enforced') {
      return { ok: false, why: 'This login can write to the database now. Nothing was sent.' };
    }
    const offer = lookupOffer(graphFrom(await readSchemaGraph(client, SCHEMAS)));
    return { ok: true, offer, dsn };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * The database's own sentence, made readable without being rewritten.
 *
 * Two things are done to it and no more:
 *
 * ① **`t0.` and friends are stripped.** Those aliases are this product's
 *    invention — `walkRoute` numbers the joined tables `t0`, `t1`… — so a
 *    reader shown `column t0.customer_id does not exist` is being shown our
 *    noise inside Postgres's words. Removing it is removing ours, not theirs.
 * ② **a full stop is added when there is none.** Postgres does not end its
 *    messages with one, and the sentence this is embedded in continues
 *    afterwards. On screen it read `…does not exist Nothing was counted…`
 *
 * 🟥 Nothing else. The wording stays the database's, because the database is
 * the one that refused and paraphrasing it would put this product's guess
 * where an authority's answer was.
 */
export function readableDbError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.length === 0) return 'the database refused the query.';
  const withoutAliases = raw.replace(/\bt\d+\./g, '');
  return /[.!?]$/.test(withoutAliases) ? withoutAliases : `${withoutAliases}.`;
}

/** A question, or nothing. Validated here because here is the boundary. */
function cleanQuestion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const q = raw.trim();
  if (q.length === 0 || q.length > MAX_QUESTION) return null;
  return q;
}

/**
 * What this question would send. Sends nothing.
 *
 * 🟥 It builds the same prompts the send path builds, from the same functions.
 * A preview assembled separately would be a description of a call nobody
 * makes, which is the failure mode `lookupPromptParts` living beside
 * `sealLookup` exists to prevent one layer down.
 */
export async function askPreview(
  handle: SessionHandle,
  rawQuestion: unknown,
): Promise<AskPreview> {
  const question = cleanQuestion(rawQuestion);
  if (question === null) return { kind: 'unavailable', reason: 'no-scan-yet' };

  const config = modelConfig();
  if (config === null) return { kind: 'unavailable', reason: 'no-model-configured' };

  const found = await offerFor(handle).catch(() => ({ ok: false as const, why: '' }));
  if (!found.ok) return { kind: 'unavailable', reason: 'no-scan-yet' };
  // A map with no subjects is a database whose tables have no relationships
  // this product could find. There is nothing to aim at, and offering a send
  // button would be offering to send a question with an empty menu.
  if (found.offer.subjects.length === 0) return { kind: 'unavailable', reason: 'no-scan-yet' };

  if (config.tiers[TIER] === undefined) {
    return { kind: 'unavailable', reason: 'no-model-configured' };
  }

  const envelope = askEnvelope(question, found.offer, destinationOf(config));
  if (!envelope.stayedInside) {
    return { kind: 'refused', why: envelopeNote(envelope) };
  }
  return {
    kind: 'ready',
    destination: envelope.destination,
    identifiers: envelope.identifiers,
    firstBytes: envelope.firstBytes,
    secondBytesAtWorst: envelope.secondBytesAtWorst,
    questionBytes: envelope.questionBytes,
    note: envelopeNote(envelope),
  };
}

/**
 * The person agreed. This is the only function here that sends anything.
 *
 * The subject row — which customer, which order — comes from the window
 * because only the person knows which one they are asking about. It is bound
 * as a parameter by the tracer and never interpolated; this side checks only
 * that it is a string of sane length.
 */
export async function askSend(
  handle: SessionHandle,
  rawQuestion: unknown,
  rawKey: unknown,
  rawValue: unknown,
): Promise<AskOutcome> {
  const question = cleanQuestion(rawQuestion);
  if (question === null) return { kind: 'unavailable', why: 'That is not a question.', provenance: null };

  const config = modelConfig();
  if (config === null) {
    return { kind: 'unavailable', why: 'No model is configured in this build.', provenance: null };
  }
  const tier = config.tiers[TIER];
  if (tier === undefined) return { kind: 'unavailable', why: 'No model is configured.', provenance: null };

  const key = typeof rawKey === 'string' && rawKey.length > 0 && rawKey.length < 128 ? rawKey : null;
  const value =
    typeof rawValue === 'string' && rawValue.length > 0 && rawValue.length < 256 ? rawValue : null;
  if (key === null || value === null) {
    return { kind: 'unavailable', why: 'Which row this is about was not given.', provenance: null };
  }

  const dsn = dsnFor(handle);
  if (dsn === null) return { kind: 'unavailable', why: 'This session is not open. Connect again.', provenance: null };

  const client = await connectReadOnly({ dsn });
  try {
    const verdict = await inspectPrivileges(client, SCHEMAS);
    if (verdict.kind !== 'read_only_enforced') {
      return { kind: 'unavailable', why: 'This login can write to the database now. Nothing was sent.', provenance: null };
    }
    const offer = lookupOffer(graphFrom(await readSchemaGraph(client, SCHEMAS)));

    // 🟥 Re-checked here, not trusted from the preview. The preview ran against
    // a map read at some earlier moment, and between then and now a migration
    // could have added a route whose endpoint is not a subject. One decision
    // covering two calls is only sound while this holds.
    const envelope = askEnvelope(question, offer, destinationOf(config));
    if (!envelope.stayedInside) return { kind: 'unavailable', why: envelopeNote(envelope), provenance: null };

    const calls: CallRecord[] = [];
    const now = new Date().toISOString();
    const ledger = new PermitLedger();
    const names = [...new Set(offer.subjects.map((s) => refOf(s.entity)))];

    const out = await askLookupInTwoRounds(
      config,
      TIER,
      question,
      offer,
      (rec) => calls.push(rec),
      (round, parts, prompt) => {
        const outbound = outboundOf(config, tier, prompt);
        return {
          permit: grantEgress({
            disclosure: describeEgress(parts, outbound.destination, names),
            body: outbound.body,
            policy: POLICY,
            now,
            ttlMs: PERMIT_TTL_MS,
            id: randomUUID(),
          }),
          ledger,
          policy: POLICY,
          dataClass: 'customer-system-metadata',
          now,
        };
      },
      { timeoutMs: TIMEOUT_MS },
    );

    const costMicros = calls.reduce<number | null>(
      (a, c) => (a === null || c.costMicros === null ? null : a + c.costMicros),
      0,
    );

    if (out.state !== 'answered') {
      return { kind: 'unavailable', why: out.why, provenance: null };
    }

    // N62, computed BEFORE the walk. Computed from the raw question, never the
    // framed prompt: the fence wraps the question in text of ours, and
    // searching that would report the product's own words back as something
    // the person wrote.
    //
    // 🟥 Before, and not after, because the walk can fail BECAUSE of what this
    // note explains. ㉜'s payload steered a real run to `public.staff`, which
    // has no `customer_id`; Postgres refused, the trace threw, and the note
    // computed underneath it never existed. The one sentence written to
    // explain a steered target was silenced by the steering working.
    const resolved = resolveLookup(out.lookup, offer);
    const aimedAt = resolved === null ? null : refOf(resolved.subject.entity);
    const provenance =
      aimedAt === null ? null : provenanceNote(targetProvenance(question, aimedAt, offer));

    let timeline;
    try {
      timeline = await runTrace(client, {
        lookup: out.lookup,
        offer,
        subject: { column: key, value: /^\d+$/.test(value) ? Number(value) : value },
      });
    } catch (err) {
      // 🟥 A sentence, not the database's. `column t0.customer_id does not
      // exist` names an alias this product invented and a column the reader
      // never chose; it went to the screen once and meant nothing to anybody.
      // What it MEANS is that the answer was aimed at a table where that
      // column is not — which is a fact about the aim, and the provenance
      // note beside it says where the aim came from.
      const why =
        aimedAt === null
          ? readableDbError(err)
          : `This was aimed at ${aimedAt}, and asking there for ${key} did not ` +
            `work: ${readableDbError(err)} Nothing was counted, and nothing about your ` +
            `data follows from that.`;
      return { kind: 'unavailable', why, provenance };
    }

    return {
      kind: 'answered',
      timeline,
      provenance,
      aimedNowhere: timelineAimedNowhere(timeline),
      costMicros,
      calls: calls.length,
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}
