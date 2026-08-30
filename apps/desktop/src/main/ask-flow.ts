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
 * ## 🟥 No key is a STATE, and now it is an INVITATION
 *
 * A packaged build ships with no key and cannot: `LEDAR.msix` is a zip whose
 * `main.js` is 639,396 bytes of readable JavaScript, so anything encrypted in
 * there travels with whatever decrypts it. `model-settings.ts` says the rest.
 *
 * So the key is the person's own, typed once and kept by the operating
 * system. Having none is still a STATE rather than an error — the same lesson
 * `saveProfile` learned by returning `ProfileFacts | null` — but the screen
 * can now do something about it instead of only reporting it.
 *
 * ⚠️ Debt N63 is NARROWED by this, not closed. Bring-your-own-key serves the
 * people an open-source Postgres tool reaches first, who can get a key in five
 * minutes. It does not serve `CLAUDE.md` §3's reader — somebody who does not
 * understand backends and is accountable for one — and telling them to go and
 * buy an API key is handing them a developer's errand. That reader is served
 * by a proxy holding the key, and that is still unbuilt.
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
import { looksLikeSecret } from '../shared/key-shape.js';
import { currentSettings, storedKey } from './model-settings.js';
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
 * The model configuration, or null when nobody has provided a key.
 *
 * Three fields, and all three are the person's: where to send, which model,
 * and the credential. Bring-your-own-key means bring-your-own-provider, so a
 * hardcoded model name would fail against every provider but the one this
 * repository happens to use.
 */
export function modelConfig(): ModelConfig | null {
  const settings = currentSettings();
  // 🟥 The environment first, and ONLY for development. `infra/run-desktop.mjs`
  // puts a key there; a packaged build has none, and reading a file path
  // instead would be a guess about where the process is running.
  //
  // A person's stored key beats it when both exist — this is their app, and
  // a variable in a shell they did not set should not override what they
  // typed into a screen.
  const key = storedKey() ?? process.env['AI_API_KEY']?.trim() ?? null;
  const baseUrl = settings.hasKey
    ? settings.baseUrl
    : (process.env['AI_BASE_URL']?.trim() ?? settings.baseUrl);
  if (key === null || key.length === 0) return null;

  return {
    baseUrl,
    apiKey: key,
    // The model comes from settings too, because bring-your-own-key means
    // bring-your-own-provider: a key from somewhere else serves different
    // model names, and a hardcoded one would fail on every provider but ours.
    tiers: { [TIER]: { model: settings.model, effort: 'low', maxTokens: 2000 } },
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

/**
 * What a person is told when the choice could not be used.
 *
 * 🟥 Written from the gate's refusal rather than passing it on. One of
 * `sealLookup`'s sentences reached a real screen reading *"…VS-7 measured what
 * discounted hedging costs · 10745ms"* — a field-result reference and a
 * latency figure, shown to somebody who does not understand backends and is
 * accountable for one. Those sentences are written to be read in a failing
 * test, and they are good at that.
 *
 * Every branch says the same three things in the reader's terms: what came
 * back, why this product will not act on it, and that nothing about their data
 * follows from it. Six sentences rather than one, because the six refusals
 * lead a reader somewhere different and one sentence for all of them is the
 * same as no sentence.
 *
 * ⚠️ The default is deliberately vague. An unrecognised refusal means a rule
 * fired that this function has not been taught, and inventing a specific
 * explanation for it would be worse than admitting the gap. The exact words
 * are still carried, in `detail`.
 */
export function readerSentenceFor(gate: string): string {
  const nothingFollows =
    'Nothing was looked at, and nothing about your data follows from this.';
  if (/names no gap/.test(gate)) {
    return (
      'The answer that came back said your database cannot help with this, ' +
      'and would not say what it would take instead. A refusal with no gap ' +
      `named is not something this product will pass on. ${nothingFollows}`
    );
  }
  if (/never\s+offered/.test(gate)) {
    return (
      'The answer that came back pointed at something that is not in your ' +
      `database. It was refused before any query was built. ${nothingFollows}`
    );
  }
  if (/more than once/.test(gate)) {
    return (
      'The answer that came back asked to follow the same trail twice, which ' +
      `would have counted the same rows twice. ${nothingFollows}`
    );
  }
  if (/names nothing to look at/.test(gate)) {
    return (
      'The answer that came back promised your database could help and then ' +
      `named nowhere to look. ${nothingFollows}`
    );
  }
  if (/two different answers/.test(gate)) {
    return (
      'The answer that came back said your database cannot help and picked ' +
      `somewhere to look anyway. Those are two different answers. ${nothingFollows}`
    );
  }
  if (/shape it was asked for/.test(gate)) {
    return `The answer that came back was not readable at all. ${nothingFollows}`;
  }
  return (
    'The answer that came back could not be used, and this product will not ' +
    `guess at what it meant. ${nothingFollows}`
  );
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

  // 🟥 Before anything else, including before the map is read. A credential in
  // the question box is the worst payload this screen can carry: it would
  // leave the machine inside something the disclosure calls "your question".
  // It happened once, to somebody who knew what the two boxes were for.
  if (looksLikeSecret(question)) {
    return {
      kind: 'refused',
      why:
        'That looks like an API key rather than a question. Nothing was sent. ' +
        'If you meant to save a key, ask a question and LEDAR will offer the ' +
        'field for it — and a key never belongs in the same box as a question, ' +
        'because a question is what gets sent to the model.',
    };
  }

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
  if (question === null) {
    return { kind: 'unavailable', why: 'That is not a question.', provenance: null, detail: null };
  }
  // Checked again here, and not only in `askPreview`. This is the function
  // that sends; a guard that lives only on the path before it is a guard the
  // sending path does not have.
  if (looksLikeSecret(question)) {
    return {
      kind: 'unavailable',
      why: 'That looks like an API key rather than a question. Nothing was sent.',
      provenance: null,
      detail: null,
    };
  }

  const config = modelConfig();
  if (config === null) {
    return { kind: 'unavailable', why: 'No model is configured in this build.', provenance: null, detail: null };
  }
  const tier = config.tiers[TIER];
  if (tier === undefined) return { kind: 'unavailable', why: 'No model is configured.', provenance: null, detail: null };

  const key = typeof rawKey === 'string' && rawKey.length > 0 && rawKey.length < 128 ? rawKey : null;
  const value =
    typeof rawValue === 'string' && rawValue.length > 0 && rawValue.length < 256 ? rawValue : null;
  if (key === null || value === null) {
    return { kind: 'unavailable', why: 'Which row this is about was not given.', provenance: null, detail: null };
  }

  const dsn = dsnFor(handle);
  if (dsn === null) return { kind: 'unavailable', why: 'This session is not open. Connect again.', provenance: null, detail: null };

  const client = await connectReadOnly({ dsn });
  try {
    const verdict = await inspectPrivileges(client, SCHEMAS);
    if (verdict.kind !== 'read_only_enforced') {
      return { kind: 'unavailable', why: 'This login can write to the database now. Nothing was sent.', provenance: null, detail: null };
    }
    const offer = lookupOffer(graphFrom(await readSchemaGraph(client, SCHEMAS)));

    // 🟥 Re-checked here, not trusted from the preview. The preview ran against
    // a map read at some earlier moment, and between then and now a migration
    // could have added a route whose endpoint is not a subject. One decision
    // covering two calls is only sound while this holds.
    const envelope = askEnvelope(question, offer, destinationOf(config));
    if (!envelope.stayedInside) return { kind: 'unavailable', why: envelopeNote(envelope), provenance: null, detail: null };

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
      // 🟥 The gate's sentence goes to `detail`; the person reads one of ours.
      return {
        kind: 'unavailable',
        why: readerSentenceFor(out.why),
        provenance: null,
        detail: out.why,
      };
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
      return { kind: 'unavailable', why, provenance, detail: null };
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
