/**
 * The gate that decides where a question is allowed to point.
 *
 * G3 lets a model choose a target. ㉔ measured what that costs: the payload
 * that landed most often was `rule-wrong-table`, which simply asked for a
 * different table than the user named, won 3 of 7, and said nothing hostile
 * doing it. Its output is a true, fluent, well-formed answer about somebody
 * else's question — the one failure shape a reader cannot detect.
 *
 * So the tests that matter here are not "does a good choice pass". They are
 * the refusals, and above all the one at the bottom of `subject`: a target
 * that was never offered must be a FAILED CALL, not a flagged one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BoundedLookup,
  LookupRefused,
  OUTSIDE_KINDS,
  lookupOffer,
  resolveLookup,
  sealLookup,
} from '../src/bounded-lookup.js';
import type { LookupOffer } from '../src/bounded-lookup.js';
import type { EntityEdge, EntityGraph } from '../src/entity-graph.js';

/**
 * Pagila's shape, small enough to reason about by hand.
 *
 *   customer ← rental → payment
 *
 * Two declared edges, so `pathsFrom` finds `rental` at one hop from
 * `customer` and `payment` at two.
 */
function edge(
  fromTable: string,
  toTable: string,
  via: string,
  tier: EntityEdge['tier'] = 'declared',
): EntityEdge {
  const base = {
    from: { schema: 'public', table: fromTable },
    to: { schema: 'public', table: toTable },
    via,
    why: `declared foreign key on ${fromTable}.${via}`,
  };
  const join = { from: [via], to: [via] };
  if (tier === 'measured') return { ...base, tier, matched: { of: 100, found: 98 }, join };
  if (tier === 'guessed') return { ...base, tier, matched: null, join: null };
  return { ...base, tier, matched: null, join };
}

const GRAPH: EntityGraph = {
  edges: [
    edge('rental', 'customer', 'customer_id'),
    edge('payment', 'rental', 'rental_id'),
  ],
};

/** A lookup body with everything valid, so each test breaks exactly one thing. */
function good(offer: LookupOffer, over: Partial<BoundedLookup> = {}): unknown {
  const customer = offer.subjects.find((s) => s.entity.table === 'customer')!;
  const route = offer.paths.find((p) => p.id.startsWith(`${customer.id}.`))!;
  return {
    answerable: true,
    subject: customer.id,
    follow: [route.id],
    outside: ['application_logs'],
    ...over,
  };
}

describe('lookupOffer', () => {
  const offer = lookupOffer(GRAPH);

  it('offers every table the map knows, and nothing else', () => {
    const tables = offer.subjects.map((s) => `${s.entity.schema}.${s.entity.table}`).sort();
    assert.deepEqual(tables, ['public.customer', 'public.payment', 'public.rental']);
  });

  it('every offered route starts at the subject whose id it carries', () => {
    // The invariant `resolveLookup` throws on. Asserted here on the BUILDER so
    // the throw stays a guard against a corrupted offer rather than the only
    // thing standing between a wandering timeline and a reader.
    for (const path of offer.paths) {
      const owner = offer.subjects.find((s) => path.id.startsWith(`${s.id}.`));
      assert.ok(owner, `${path.id} belongs to no subject`);
      assert.equal(path.from, `${owner!.entity.schema}.${owner!.entity.table}`);
    }
  });

  it('reaches two hops, so a question can cross the table in the middle', () => {
    // §33's whole example is customer → … → payment. One hop would offer
    // rental and stop, and the question a person actually asks would be
    // unreachable while the menu still looked complete.
    const customer = offer.subjects.find((s) => s.entity.table === 'customer')!;
    const reached = offer.paths
      .filter((p) => p.id.startsWith(`${customer.id}.`))
      .map((p) => p.to)
      .sort();
    assert.deepEqual(reached, ['public.payment', 'public.rental']);
  });

  it('ids are opaque, so a table name can never be mistaken for one', () => {
    for (const s of offer.subjects) assert.match(s.id, /^s\d+$/);
    for (const p of offer.paths) assert.match(p.id, /^s\d+\.p\d+$/);
  });
});

describe('sealLookup refuses', () => {
  const offer = lookupOffer(GRAPH);

  const refuses = (raw: unknown, why: RegExp): void => {
    assert.throws(() => sealLookup(raw, offer), (e: unknown) => {
      assert.ok(e instanceof LookupRefused, `expected LookupRefused, got ${String(e)}`);
      assert.match(e.message, why);
      return true;
    });
  };

  it('a shape that is not the contract', () => {
    refuses({ answerable: true }, /did not return the shape/);
    refuses('not an object', /did not return the shape/);
  });

  it('an extra key, because that is a model answering something nobody asked', () => {
    // `sql` in particular: the moment a model can hand back a query, the
    // product is no longer the thing that writes them, whatever the call site
    // does with the field.
    refuses(
      { ...(good(offer) as object), sql: 'SELECT * FROM public.customer' },
      /did not return the shape/,
    );
  });

  it('🟥 a subject that was never offered — the ㉔ failure', () => {
    refuses({ ...(good(offer) as object), subject: 'public.secrets' }, /never\s+offered/);
    refuses({ ...(good(offer) as object), subject: 's99' }, /never\s+offered/);
  });

  it('a route that was never offered', () => {
    refuses({ ...(good(offer) as object), follow: ['s1.p99'] }, /never offered/);
  });

  it('the same route twice, which would count the same rows twice', () => {
    const body = good(offer) as { follow: string[] };
    refuses({ ...body, follow: [body.follow[0]!, body.follow[0]!] }, /more than once/);
  });

  it('an answer with no target behind it', () => {
    refuses(
      { ...(good(offer) as object), subject: null, follow: [] },
      /names nothing to look at/,
    );
  });

  it('a refusal that will not name the gap', () => {
    refuses(
      { answerable: false, subject: null, follow: [], outside: [] },
      /names no gap/,
    );
  });

  it('a refusal that still picks somewhere to look', () => {
    const body = good(offer) as { subject: string; follow: string[] };
    refuses(
      { answerable: false, subject: body.subject, follow: [], outside: ['request_traces'] },
      /two different answers/,
    );
    refuses(
      { answerable: false, subject: null, follow: body.follow, outside: ['request_traces'] },
      /two different answers/,
    );
  });
});

describe('sealLookup accepts', () => {
  const offer = lookupOffer(GRAPH);

  it('a choice that aims inside the menu', () => {
    const sealed = sealLookup(good(offer), offer);
    assert.equal(sealed.answerable, true);
    assert.equal(sealed.follow.length, 1);
  });

  it('🟥 answerable AND outside together — the deliberate break from sealAnswer', () => {
    // `sealAnswer` refuses this pairing. Here it is the ordinary case, because
    // G3's instruction is to answer the database half and admit the rest, and
    // almost every real operational question has both halves.
    //
    // This test exists so that a later tidy-up which "makes the three seals
    // consistent" goes red instead of quietly deleting the Admit half of the
    // product. Consistency between the seals is not the goal; each one is
    // shaped by what its own answer can be wrong about.
    const sealed = sealLookup(
      good(offer, { outside: ['external_service', 'application_logs'] }),
      offer,
    );
    assert.equal(sealed.answerable, true);
    assert.deepEqual([...sealed.outside], ['external_service', 'application_logs']);
  });

  it('an answerable choice that follows nothing, for a one-table question', () => {
    const sealed = sealLookup(good(offer, { follow: [] }), offer);
    assert.deepEqual([...sealed.follow], []);
  });

  it('a refusal that names what is outside', () => {
    const sealed = sealLookup(
      { answerable: false, subject: null, follow: [], outside: ['credential_check'] },
      offer,
    );
    assert.equal(sealed.answerable, false);
  });
});

describe('resolveLookup', () => {
  const offer = lookupOffer(GRAPH);

  it('gives back the subject and the routes, resolved against the map', () => {
    const sealed = sealLookup(good(offer), offer);
    const resolved = resolveLookup(sealed, offer);
    assert.ok(resolved);
    assert.equal(resolved.subject.entity.table, 'customer');
    assert.equal(resolved.routes.length, 1);
    assert.ok(resolved.routes[0]!.path.length >= 1);
  });

  it('gives back nothing for a lookup that aimed nowhere', () => {
    const sealed = sealLookup(
      { answerable: false, subject: null, follow: [], outside: ['application_logs'] },
      offer,
    );
    assert.equal(resolveLookup(sealed, offer), null);
  });

  it('throws when a route does not start where the subject is', () => {
    // Only reachable if the offer was built from one map and checked against
    // another. Loud, because the quiet version is a timeline that wanders into
    // a table the question was never about.
    const sealed = sealLookup(good(offer), offer);
    const corrupted: LookupOffer = {
      subjects: offer.subjects,
      paths: offer.paths.map((p) => ({ ...p, from: 'public.somewhere_else' })),
    };
    assert.throws(() => resolveLookup(sealed, corrupted), LookupRefused);
  });
});

describe('the outside vocabulary', () => {
  it('is closed, and every member is something Postgres structurally lacks', () => {
    assert.deepEqual(
      [...OUTSIDE_KINDS].sort(),
      [
        'application_logs',
        'cache_or_session_store',
        'credential_check',
        'events_not_recorded',
        'external_service',
        'request_traces',
      ],
    );
  });

  it('refuses a kind nobody defined', () => {
    assert.equal(
      BoundedLookup.safeParse({
        answerable: false,
        subject: null,
        follow: [],
        outside: ['the_weather'],
      }).success,
      false,
    );
  });
});
