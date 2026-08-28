/**
 * G3, first half: what a model is allowed to decide when somebody asks a
 * question about their own system.
 *
 * Ideal §33 is the question this exists for — *"I paid but I do not see my
 * order"* — and `_doc/29` G3 states the mechanism in one line:
 *
 * > *"model KHÔNG viết câu, KHÔNG viết SQL. Nó CHỌN: thực thể nào trong
 * > Profile là đích · đi theo cạnh nào của bản đồ. Sản phẩm chạy truy vấn,
 * > sản phẩm viết câu."*
 *
 * So this file holds the whole of what may come back from a model, and
 * `sealLookup` is the gate that will not let anything else past. It is the
 * third of its family — `sealAnswer` for VS-8, `sealRule` for VS-6 — and it is
 * written in their shape on purpose: a reader who has understood one has
 * understood all three.
 *
 * ## What makes this one different, and why it is the dangerous one
 *
 * The other two are given the thing to reason about. This one CHOOSES A TARGET,
 * and ㉔ measured what that costs: of seven prompt-injection breaches, the one
 * that landed most often was `rule-wrong-table` — a payload that simply asked
 * for a different table than the user named. It won three times in seven, and
 * it never said anything hostile.
 *
 * That failure is invisible in the output. A timeline about the wrong table
 * reads exactly like a timeline about the right one; the numbers are real, the
 * sentences are true, and the answer is about somebody else's question. Prose
 * cannot be checked for it. **A choice from a fixed menu can.**
 *
 * Hence `LookupOffer`: the product computes the menu from the map, hands the
 * model ids, and takes ids back. A subject that was never offered is not a
 * lower-confidence answer to be flagged — it is a refused call. That is the
 * same move `sealAnswer` makes for cited facts, applied to the field where
 * being wrong is silent.
 *
 * ## The one place this DEPARTS from its two siblings, deliberately
 *
 * `sealAnswer` refuses an answer that is both answerable and lists what is
 * missing: *"those are two different answers, and picking one for the reader
 * is not this renderer's job."* Right there, wrong here.
 *
 * `_doc/29` G3 is explicit that a real operational question is nearly always
 * PART database and PART something else:
 *
 * > *"sản phẩm KHÔNG đọc log, KHÔNG đọc trace, KHÔNG đọc Redis (chưa) …
 * > trả lời phần database BIẾT, Admit phần còn lại. Đó là chữ A của LEDAR."*
 *
 * An answerable lookup that names nothing outside itself is therefore the
 * suspicious shape, not the clean one — it claims Postgres holds a whole story
 * that Postgres, structurally, does not. So `outside` travels WITH an
 * answerable lookup, and the renderer prints it beside the timeline rather
 * than under it.
 */

import { z } from 'zod';

import { entitiesIn, pathsFrom, refOf } from './entity-graph.js';
import type { EntityEdge, EntityGraph, EntityRef } from './entity-graph.js';

/**
 * What a Postgres database structurally cannot answer.
 *
 * A closed union, and closed for the reason `MissingAdmission` is: the moment
 * "what we could not see" is free prose, the sentence a reader gets and the
 * thing the product actually did stop being checkable against each other.
 * user-rules@1.2.0 bumped a version to fix exactly that, and the lesson is
 * cheaper to apply than to relearn.
 *
 * Each member is a thing the ideal's own example needs and Postgres does not
 * hold. Read §33's timeline again: *"Stripe sent a webhook at 10:32:15"* and
 * *"the server received it"* are two lines this product cannot produce from a
 * database, and printing them anyway would be the failure the whole product
 * exists to refuse.
 */
export const OutsideKind = z.enum([
  /** What the application wrote to a log. */
  'application_logs',
  /** How long a request took, and which service it crossed. */
  'request_traces',
  /** Sessions, rate limits, queues: state kept outside the database. */
  'cache_or_session_store',
  /** Stripe, a mail provider, another company's API. */
  'external_service',
  /** Whether a password or token was accepted. */
  'credential_check',
  /**
   * The table keeps CURRENT STATE and no history, so what changed and when
   * cannot be read out of it at all.
   *
   * The one that catches people, and worth its own member rather than being
   * folded into "logs": a row saying `status = 'cancelled'` is not evidence
   * about when it was cancelled, and a timeline built as if it were would be
   * inventing the very column the reader most wants.
   */
  'events_not_recorded',
]);
export type OutsideKind = z.infer<typeof OutsideKind>;

export const OUTSIDE_KINDS = OutsideKind.options;

/** One table the model may aim at, with the id it must use to name it. */
export type OfferedSubject = {
  /** Stable within one offer. What comes back is compared against this. */
  readonly id: string;
  readonly entity: EntityRef;
};

/** One route the model may ask to follow, already computed from the map. */
export type OfferedPath = {
  readonly id: string;
  /** `schema.table` this route starts at. */
  readonly from: string;
  /** `schema.table` it arrives at. */
  readonly to: string;
  /** The edges, in order. The product walks these; the model never names one. */
  readonly path: readonly EntityEdge[];
};

/**
 * The menu. Built by the product, sent to the model, and checked against.
 *
 * One object rather than two lists built at two call sites, because the whole
 * guarantee is that the thing offered and the thing checked are the same
 * thing. Two builders that agree today are two builders, and this repository
 * has written down what that costs more than once.
 */
export type LookupOffer = {
  readonly subjects: readonly OfferedSubject[];
  readonly paths: readonly OfferedPath[];
};

/**
 * The whole of what a model may return. `.strict()` for the same reason its
 * siblings are: an extra key is a model answering a question nobody asked.
 */
export const BoundedLookup = z
  .object({
    /** Whether the database can be aimed at this question at all. */
    answerable: z.boolean(),
    /** Which offered subject. An id, never a table name. */
    subject: z.union([z.string(), z.null()]),
    /** Which offered routes to walk out from it. Ids, never edges. */
    follow: z.array(z.string()),
    /** What this question needs that a database does not hold. */
    outside: z.array(OutsideKind),
  })
  .strict();
export type BoundedLookup = z.infer<typeof BoundedLookup>;

export class LookupRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LookupRefused';
  }
}

declare const LOOKUP_SEAL: unique symbol;

/**
 * A lookup that has been checked against the menu it will run on.
 *
 * Branded, like `SealedAnswer` and `SealedRule`, so nothing downstream can
 * accept a plain object however tired whoever wrote the call site was. The
 * plan builder takes only this type.
 */
export type SealedLookup = BoundedLookup & {
  readonly [LOOKUP_SEAL]: 'checked against the menu it was offered';
};

/**
 * Builds the menu from the map.
 *
 * `subjects` is every table the map knows, because a person may ask about any
 * of them. `paths` is what `pathsFrom` already computes for each subject,
 * which is the point of reusing it rather than walking the graph again here:
 * the routes the model may choose are exactly the routes the product knows how
 * to walk, by construction rather than by agreement.
 *
 * Ids are `s1`, `p1`… rather than table names. Not obfuscation — the model is
 * told which table each id is. It is so that a subject the model returns is
 * either an id that exists or a string that does not, with no third case where
 * something table-shaped arrives and a reader has to judge whether it is one
 * of ours. `sealRule` learned this the expensive way: it compares against a
 * catalogue precisely because a hijacked rule naming `public.secrets` must
 * fail before a query is built, not while one is running.
 */
export function lookupOffer(graph: EntityGraph, hops = 2): LookupOffer {
  const subjects: OfferedSubject[] = [];
  const paths: OfferedPath[] = [];

  for (const [i, name] of entitiesIn(graph).entries()) {
    const split = splitEntity(name);
    if (split === null) continue;
    const id = `s${i + 1}`;
    subjects.push({ id, entity: split });

    for (const [j, route] of pathsFrom(graph, split, hops).entries()) {
      paths.push({
        id: `${id}.p${j + 1}`,
        from: name,
        to: route.to,
        path: route.path,
      });
    }
  }

  return { subjects, paths };
}

/** `schema.table` back into its halves, or null for anything else. */
function splitEntity(name: string): EntityRef | null {
  const at = name.indexOf('.');
  if (at <= 0 || at === name.length - 1) return null;
  const schema = name.slice(0, at);
  const table = name.slice(at + 1);
  if (table.includes('.')) return null;
  return { schema, table };
}

/**
 * Checks one lookup against the menu it was offered, or throws.
 *
 * Every refusal below names a shape that would otherwise reach a reader as a
 * confident, well-formed, wrong answer. None of them is a style preference.
 */
export function sealLookup(raw: unknown, offer: LookupOffer): SealedLookup {
  const parsed = BoundedLookup.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LookupRefused(
      `The model did not return the shape it was asked for: ` +
        `${issue?.path.join('.') || '(root)'} — ${issue?.message ?? 'wrong shape'}. ` +
        `An unparseable choice is a failed call, not a partial one.`,
    );
  }
  const lookup = parsed.data;

  const subjectIds = new Set(offer.subjects.map((s) => s.id));
  const pathIds = new Set(offer.paths.map((p) => p.id));

  // 🟥 The one ㉔ measured. `rule-wrong-table` won 3 of 7 by naming a table
  // nobody asked about, and the output of that is indistinguishable from a
  // correct answer. Here it cannot be built at all.
  if (lookup.subject !== null && !subjectIds.has(lookup.subject)) {
    throw new LookupRefused(
      `The choice aims at ${JSON.stringify(lookup.subject)}, which was never ` +
        `offered. The subjects available were: ${[...subjectIds].join(', ') || '(none)'}. ` +
        `Aiming at something nobody offered is how an answer comes back true ` +
        `about the wrong system, and it is the only form of that this product ` +
        `can detect exactly.`,
    );
  }

  const strayed = lookup.follow.filter((f) => !pathIds.has(f));
  if (strayed.length > 0) {
    throw new LookupRefused(
      `The choice follows ${strayed.map((s) => JSON.stringify(s)).join(', ')}, ` +
        `which ${strayed.length === 1 ? 'was' : 'were'} never offered. Routes ` +
        `come from the map this product built; one that did not is a route ` +
        `through a relationship nobody measured.`,
    );
  }

  // `indexOf`, not `Set.add`. The first version of this line was
  // `filter((f) => !seen.add(f))`, and `Set.add` returns the SET — always
  // truthy — so the negation was always false and the check below could never
  // fire. It read correctly and did nothing, which is the shape §4 keeps
  // writing down; the test beside it is what found the difference.
  const twice = lookup.follow.filter((f, i) => lookup.follow.indexOf(f) !== i);
  if (twice.length > 0) {
    // Not tidiness. A route walked twice counts its rows twice, and a timeline
    // that double-counts is wrong in the direction a reader cannot see.
    throw new LookupRefused(
      `The choice follows ${twice.map((t) => JSON.stringify(t)).join(', ')} ` +
        `more than once. Walking one route twice counts the same rows twice, ` +
        `and the total is the part of a timeline a reader checks least.`,
    );
  }

  if (lookup.answerable && lookup.subject === null) {
    throw new LookupRefused(
      `The choice says the database can answer and names nothing to look at. ` +
        `That is a promise with no target behind it — the shape this whole ` +
        `product exists to refuse.`,
    );
  }

  if (!lookup.answerable && lookup.outside.length === 0) {
    throw new LookupRefused(
      `The choice says the database cannot answer and will not say what is ` +
        `outside it. A refusal that names no gap is the hedging a reader ` +
        `discounts, and VS-7 measured what discounted hedging costs.`,
    );
  }

  if (!lookup.answerable && (lookup.subject !== null || lookup.follow.length > 0)) {
    throw new LookupRefused(
      `The choice says the database cannot answer and still picks somewhere ` +
        `to look. Those are two different answers, and deciding which one the ` +
        `reader gets is not this gate's job.`,
    );
  }

  // 🟥 Deliberately ABSENT: a refusal for "answerable AND outside is
  // non-empty". `sealAnswer` refuses that pairing; here it is the normal case.
  // A question like "the customer paid and has no order" is answerable ABOUT
  // THE ROWS and silent about the webhook, and G3's instruction is to give the
  // database half and admit the rest. See this file's header.

  return lookup as SealedLookup;
}

/**
 * The subject and routes a sealed lookup picked, resolved back to the map.
 *
 * Takes `SealedLookup` rather than `BoundedLookup`, so there is no way to
 * resolve a choice that was not checked. Returns null for a lookup that
 * refused to aim anywhere, which is a real answer and not a failure.
 */
export function resolveLookup(
  lookup: SealedLookup,
  offer: LookupOffer,
): { subject: OfferedSubject; routes: readonly OfferedPath[] } | null {
  if (!lookup.answerable || lookup.subject === null) return null;
  const subject = offer.subjects.find((s) => s.id === lookup.subject);
  if (subject === undefined) return null;

  const wanted = new Set(lookup.follow);
  const routes = offer.paths.filter((p) => wanted.has(p.id));

  // Every route has to start where the subject is. A route from somewhere else
  // is a route through a table the question was not about, and it arrives here
  // only if the offer was built wrong — which is worth finding loudly rather
  // than rendering a timeline that wanders.
  const from = refOf(subject.entity);
  const wrong = routes.filter((r) => r.from !== from);
  if (wrong.length > 0) {
    throw new LookupRefused(
      `Routes ${wrong.map((w) => JSON.stringify(w.id)).join(', ')} do not ` +
        `start at ${from}. The menu and the subject disagree, which means the ` +
        `offer was built from one map and checked against another.`,
    );
  }

  return { subject, routes };
}
