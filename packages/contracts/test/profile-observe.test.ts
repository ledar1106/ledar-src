/**
 * Looking at a schema and saying what it means — the half that can lie.
 *
 * Ideal §12's audit demands the product scan first and then ask the person
 * only to RECOGNISE what was found. This is that scan, and it is the cheapest
 * place in the whole product to overstate: nobody audits an onboarding screen
 * the way they audit a finding, and "you take payments" printed as a fact on
 * the strength of a table called `orders` would be the product inventing a
 * business model for somebody.
 *
 * So the rules pinned here are all about restraint:
 *
 *   1. Names only. Not one row is read, so nothing here can leak a value.
 *   2. A suggestion never becomes a sighting, and a person agreeing with a
 *      suggestion does not promote it either.
 *   3. `verified` cannot be produced by a computation. It means a human
 *      looked and agreed, and every later screen reads it that way.
 *   4. Saying nothing is a valid outcome and the common one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PROFILE_AREAS,
  ProjectProfile,
  conflictsIn,
  emptyProfile,
  observeAreas,
  reconcile,
  strongestFor,
} from '../src/index.js';
import type { Observation, ProjectProfile as Profile, SchemaShape, StatedAnswer } from '../src/index.js';

const AT = '2026-08-27T00:00:00.000Z';
const LATER = '2026-08-28T00:00:00.000Z';
const BASE = emptyProfile('fp-test', AT);

function shape(over: Partial<SchemaShape> = {}): SchemaShape {
  return { schemas: ['public'], tables: [], columns: [], ...over };
}

describe('what a schema settles', () => {
  it('a Supabase auth schema is Supabase Auth, and there is no second reading', () => {
    const seen = observeAreas(shape({ schemas: ['public', 'auth'] }), AT);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.area, 'auth');
    assert.equal(seen[0]?.strength, 'certain');
    assert.equal(seen[0]?.evidence.where, 'auth');
  });

  it('a column named for a payment processor settles payments', () => {
    const seen = observeAreas(
      shape({ columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }] }),
      AT,
    );
    assert.equal(seen[0]?.area, 'payment');
    assert.equal(seen[0]?.strength, 'certain');
  });

  it('🟥 the reason names the STEP, not the conclusion', () => {
    // So a person can disagree with the reasoning rather than only with the
    // verdict. "this column's name contains stripe" is checkable by anybody;
    // "you take payments" is a thing to either swallow or fight.
    const seen = observeAreas(
      shape({ columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }] }),
      AT,
    );
    assert.match(seen[0]!.evidence.why, /contains "stripe"/);
    assert.doesNotMatch(seen[0]!.evidence.why, /you /i);
  });

  it('every sighting names a place a person could go and open', () => {
    const seen = observeAreas(
      shape({
        schemas: ['public', 'storage'],
        tables: [{ schema: 'public', table: 'orders' }],
        columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }],
      }),
      AT,
    );
    assert.ok(seen.length >= 3);
    for (const o of seen) {
      assert.ok(o.evidence.where.trim().length > 0, 'a sighting with nowhere to look');
      assert.ok(o.evidence.why.trim().length > 0, 'a sighting with no reason');
      assert.equal(o.evidence.observedAt, AT);
    }
  });
});

describe('what a schema only suggests', () => {
  it('🟥 a table called orders is a suggestion, never a sighting', () => {
    // The clearest case, and the one that would be most tempting to promote:
    // plenty of systems have orders and take the money somewhere else.
    const seen = observeAreas(shape({ tables: [{ schema: 'public', table: 'orders' }] }), AT);
    assert.equal(seen[0]?.area, 'payment');
    assert.equal(seen[0]?.strength, 'suggestive');
  });

  it('the reason admits its own unreliability', () => {
    const seen = observeAreas(shape({ tables: [{ schema: 'public', table: 'jobs' }] }), AT);
    assert.match(seen[0]!.evidence.why, /sometimes does not/);
  });

  it('the strongest of several sightings wins, and the weaker ones are kept', () => {
    // A person shown "you have a Supabase auth schema" is better served by
    // also seeing the `users` table beside it. Discarding the weaker evidence
    // as redundant costs a line and buys nothing.
    const seen = observeAreas(
      shape({ schemas: ['public', 'auth'], tables: [{ schema: 'public', table: 'users' }] }),
      AT,
    );
    const best = strongestFor(seen, 'auth');
    assert.equal(best?.strength, 'certain');
    assert.equal(best?.evidence.length, 2);
  });
});

describe('a schema that says nothing', () => {
  it('🟥 produces no sightings, and that is a valid answer', () => {
    // Rule 4. Plenty of databases are a handful of domain tables with no
    // recognisable name in them, and the product must be able to come back
    // with nothing rather than reaching for the nearest match.
    const seen = observeAreas(
      shape({ tables: [{ schema: 'public', table: 'widget_revisions' }] }),
      AT,
    );
    assert.deepEqual(seen, []);
    assert.equal(strongestFor(seen, 'payment'), null);
  });

  it('🟥 never looks for a database, because it is connected to one', () => {
    // Pattern-matching a name to decide whether a database exists, while
    // holding an open connection to it, would be the product guessing at
    // something it already knows.
    const seen = observeAreas(
      shape({ schemas: ['public', 'auth', 'storage', 'cron'], tables: [{ schema: 'public', table: 'orders' }] }),
      AT,
    );
    assert.deepEqual(seen.filter((o) => o.area === 'database'), []);
  });
});

describe('putting what was said next to what was seen', () => {
  const stripe: Observation[] = observeAreas(
    shape({ columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }] }),
    AT,
  );
  const orders: Observation[] = observeAreas(
    shape({ tables: [{ schema: 'public', table: 'orders' }] }),
    AT,
  );

  it('seen for certain becomes observed, and carries what they said', () => {
    const p = reconcile(BASE, [{ area: 'payment', answer: 'no' }], stripe, LATER);
    const known = p.areas.payment;
    assert.equal(known?.state, 'observed');
    assert.equal(known?.state === 'observed' && known.stated, 'no');
  });

  it('seen suggestively becomes suspected, and also carries what they said', () => {
    // The rung where it matters most: "you said yes — is this it?" is a
    // question the screen can only ask if both halves survived to here.
    const p = reconcile(BASE, [{ area: 'payment', answer: 'yes' }], orders, LATER);
    const known = p.areas.payment;
    assert.equal(known?.state, 'suspected');
    assert.equal(known?.state === 'suspected' && known.stated, 'yes');
  });

  it('🟥 a person agreeing does NOT promote a suggestion to a sighting', () => {
    // Rule 2. Two weak things do not make a strong one when they are weak for
    // unrelated reasons — somebody can be right about their system and the
    // table can still be named after something else.
    const p = reconcile(BASE, [{ area: 'payment', answer: 'yes' }], orders, LATER);
    assert.notEqual(p.areas.payment?.state, 'observed');
  });

  it('nothing seen but something said becomes stated, which admits it is unchecked', () => {
    const p = reconcile(BASE, [{ area: 'storage', answer: 'yes', picked: ['s3'] }], [], LATER);
    const known = p.areas.storage;
    assert.equal(known?.state, 'stated');
    assert.deepEqual(known?.state === 'stated' ? known.picked : null, ['s3']);
  });

  it('nothing seen and nothing said stays unknown', () => {
    const p = reconcile(BASE, [], [], LATER);
    for (const area of PROFILE_AREAS) assert.equal(p.areas[area]?.state, 'unknown');
  });

  it('🟥 reconcile can never mint a verified', () => {
    // Rule 3. `verified` means a human looked at what was found and agreed,
    // and every later screen reads it as settled. A computation that could
    // produce it would make the one rung that requires a person reachable
    // without one.
    const everything: StatedAnswer[] = PROFILE_AREAS.map((area) => ({ area, answer: 'yes' as const }));
    const p = reconcile(BASE, everything, [...stripe, ...orders], LATER);
    for (const area of PROFILE_AREAS) {
      assert.notEqual(p.areas[area]?.state, 'verified', `${area} was verified by arithmetic`);
    }
  });

  it('bumps the version and the timestamp, because §24 says a profile is edited', () => {
    const p = reconcile(BASE, [], stripe, LATER);
    assert.equal(p.version, BASE.version + 1);
    assert.equal(p.updatedAt, LATER);
    assert.doesNotThrow(() => ProjectProfile.parse(p));
  });

  it('🟥 said no, found it for certain — the disagreement worth showing', () => {
    // The pair of halves earning their keep. Either alone is weaker: the
    // answer tells you what they believe, the scan tells you what is there,
    // and only the two together produce the question they did not know to ask.
    const p = reconcile(BASE, [{ area: 'payment', answer: 'no' }], stripe, LATER);
    const found = conflictsIn(p);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.area, 'payment');
    assert.equal(found[0]?.direction, 'said_no_found_yes');
  });

  it('🟥 said yes, saw nothing — reported, and never as their mistake', () => {
    // The direction that had copy written for it and could not happen. This
    // product reads ONE database: somebody who says they store files is very
    // probably right and it simply is not in here. That is a fact about the
    // edge of our vision, and the direction is a separate value so the
    // sentence can be about that rather than about them being wrong.
    const p = reconcile(BASE, [{ area: 'storage', answer: 'yes', picked: ['s3'] }], [], LATER);
    const found = conflictsIn(p);
    assert.equal(found.length, 1);
    assert.equal(found[0]?.direction, 'said_yes_found_no');
    assert.equal(found[0]?.area, 'storage');
    // Nothing was seen, so there is nothing to show them beside it. An empty
    // list here is the honest shape; a fabricated "we looked at X" would be
    // the product inventing evidence for its own blind spot.
    assert.deepEqual(found[0]?.evidence, []);
  });

  it('saying no with nothing seen is agreement, not a conflict', () => {
    const p = reconcile(BASE, [{ area: 'storage', answer: 'no' }], [], LATER);
    assert.deepEqual(conflictsIn(p), []);
  });

  it('"I do not know" is never a conflict in either direction', () => {
    const p = reconcile(BASE, [{ area: 'storage', answer: 'dont_know' }], [], LATER);
    assert.deepEqual(conflictsIn(p), []);
  });

  it('a suggestion is not strong enough to contradict a person', () => {
    // Telling somebody they are wrong about their own system, on the strength
    // of a table name, is the product mistaking a guess for a measurement.
    const p = reconcile(BASE, [{ area: 'payment', answer: 'no' }], orders, LATER);
    assert.deepEqual(conflictsIn(p), []);
  });
});

/**
 * 🟥 A human agreement is the one thing on this ladder that cannot be
 * re-derived, and reconcile used to throw it away.
 *
 * Found by audit 2026-08-28. `reconcile` rebuilt every area from `said` and
 * `observations` and never read `base.areas`, so the sequence a person
 * actually performs — confirm, close the app, reopen, scan, answer the five
 * questions again — silently demoted `verified` back to `observed` and dropped
 * `confirmedAt` with it. Nothing said anything. The next screen simply stopped
 * treating a settled question as settled.
 */
describe('what a person already agreed to', () => {
  const AT = '2026-08-28T00:00:00.000Z';
  const LATER = '2026-08-29T00:00:00.000Z';

  const SEEN: SchemaShape = {
    schemas: ['public'],
    tables: [{ schema: 'public', table: 'users' }],
    columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }],
  };

  /** A profile where `payment` has been confirmed by a person. */
  function withVerifiedPayment(): Profile {
    const base = reconcile(
      emptyProfile('fp', AT),
      [],
      observeAreas(SEEN, AT),
      AT,
    );
    const seen = base.areas.payment;
    assert.ok(seen !== undefined);
    assert.ok(seen.state === 'suspected' || seen.state === 'observed');
    return {
      ...base,
      areas: {
        ...base.areas,
        payment: { state: 'verified', evidence: seen.evidence, confirmedAt: AT },
      },
    };
  }

  it('🟥 survives the next scan and the next set of answers', () => {
    const after = reconcile(
      withVerifiedPayment(),
      [{ area: 'payment', answer: 'yes', picked: ['Stripe'] }],
      observeAreas(SEEN, LATER),
      LATER,
    );
    assert.equal(after.areas.payment.state, 'verified');
  });

  it('🟥 keeps WHEN it was agreed, not just that it was', () => {
    // `confirmedAt` rather than a boolean is the contract's own choice: six
    // months on the question is not whether somebody agreed but when. Refreshed
    // to `LATER` it would claim an agreement that never happened today.
    const after = reconcile(
      withVerifiedPayment(),
      [],
      observeAreas(SEEN, LATER),
      LATER,
    );
    assert.equal(
      after.areas.payment.state === 'verified' ? after.areas.payment.confirmedAt : null,
      AT,
    );
  });

  it('🟥 does NOT survive when what they agreed to has gone', () => {
    // The other half, and it has to be the other half. They agreed to
    // evidence; if the column is dropped, keeping `verified` asserts something
    // about a database that no longer contains it.
    const after = reconcile(
      withVerifiedPayment(),
      [],
      observeAreas({ schemas: ['public'], tables: [], columns: [] }, LATER),
      LATER,
    );
    assert.notEqual(after.areas.payment.state, 'verified');
  });

  it('🟥 a person changing their mind outranks their old agreement', () => {
    // Saying "no" to something previously confirmed is a real edit, not noise
    // to be overridden by the confirmation it contradicts.
    const after = reconcile(
      withVerifiedPayment(),
      [{ area: 'payment', answer: 'no', picked: [] }],
      observeAreas(SEEN, LATER),
      LATER,
    );
    assert.notEqual(after.areas.payment.state, 'verified');
  });

  it('an area nobody confirmed is untouched by any of this', () => {
    const after = reconcile(
      withVerifiedPayment(),
      [{ area: 'jobs', answer: 'yes', picked: ['pg_cron'] }],
      observeAreas(SEEN, LATER),
      LATER,
    );
    assert.equal(after.areas.jobs.state, 'stated');
  });
});

/**
 * 🟥 One column, seen once, however many partitions the table has.
 *
 * Found by audit 2026-08-28. The scan filtered partitions out of `tables` and
 * not out of `columns` — the guard on the path that did not need it, while the
 * path that did was open. `strongestFor` keeps every sighting, so a card for
 * one column rendered a line per month.
 *
 * Tested here rather than only in the shell, because `SchemaShape` is where
 * the rule is written and this is the shape any future caller will build.
 */
describe('a partitioned table is one table', () => {
  const AT = '2026-08-28T00:00:00.000Z';
  const MONTHS = Array.from({ length: 55 }, (_, i) => `events_p2022_${String(i + 1).padStart(2, '0')}`);

  it('🟥 56 copies of a column produce 56 lines of evidence when they get in', () => {
    // The bug, pinned as a measurement. If a later change makes `observeAreas`
    // dedupe internally this test goes red and the one below stops proving
    // anything on its own — which is the point of measuring both ends.
    const leaked = observeAreas(
      {
        schemas: ['public'],
        tables: [{ schema: 'public', table: 'events' }],
        columns: ['events', ...MONTHS].map((table) => ({
          schema: 'public',
          table,
          name: 'stripe_customer_id',
        })),
      },
      AT,
    );
    assert.equal(strongestFor(leaked, 'payment')?.evidence.length, 56);
  });

  it('🟥 the shape a caller is supposed to build gives exactly one', () => {
    const clean = observeAreas(
      {
        schemas: ['public'],
        tables: [{ schema: 'public', table: 'events' }],
        columns: [{ schema: 'public', table: 'events', name: 'stripe_customer_id' }],
      },
      AT,
    );
    const seen = strongestFor(clean, 'payment');
    assert.equal(seen?.evidence.length, 1);
    assert.equal(seen?.evidence[0]?.where, 'public.events.stripe_customer_id');
  });
});

/**
 * 🟥 What somebody said yes ABOUT.
 *
 * Found by audit 2026-08-28. `picked` lived only on the `stated` rung, so a
 * person answering "yes — Supabase and Stripe" kept those words exactly as
 * long as the scan found nothing. The moment it saw a `stripe_customer_id`
 * column the rung became `observed`, and their answer lost its content. The
 * card then read "You said: yes" about nothing in particular.
 *
 * It is the half of the profile a person can correct, and nobody corrects what
 * they cannot see they said — ideal §24.
 */
describe('the list a person picked', () => {
  const AT = '2026-08-28T00:00:00.000Z';

  const SEEN: SchemaShape = {
    schemas: ['public'],
    tables: [{ schema: 'public', table: 'users' }],
    columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }],
  };
  const NOTHING: SchemaShape = { schemas: ['public'], tables: [], columns: [] };

  const SAID = [{ area: 'payment' as const, answer: 'yes' as const, picked: ['Stripe', 'Paypal'] }];

  it('🟥 survives the scan finding what they were talking about', () => {
    const after = reconcile(emptyProfile('fp', AT), SAID, observeAreas(SEEN, AT), AT);
    const payment = after.areas.payment;
    assert.ok(payment.state === 'suspected' || payment.state === 'observed');
    assert.deepEqual(payment.statedPicked, ['Stripe', 'Paypal']);
  });

  it('keeps their order, because it is their sentence', () => {
    const after = reconcile(
      emptyProfile('fp', AT),
      [{ area: 'payment', answer: 'yes', picked: ['Paypal', 'Stripe'] }],
      observeAreas(SEEN, AT),
      AT,
    );
    const payment = after.areas.payment;
    assert.deepEqual(
      payment.state === 'observed' || payment.state === 'suspected' ? payment.statedPicked : null,
      ['Paypal', 'Stripe'],
    );
  });

  it('is empty, not absent, when they said yes and picked nothing', () => {
    const after = reconcile(
      emptyProfile('fp', AT),
      [{ area: 'payment', answer: 'yes' }],
      observeAreas(SEEN, AT),
      AT,
    );
    const payment = after.areas.payment;
    assert.deepEqual(
      payment.state === 'observed' || payment.state === 'suspected' ? payment.statedPicked : null,
      [],
    );
  });

  it('still reaches the stated rung when nothing was seen', () => {
    // The path that always worked. Kept, so a fix to the other one cannot
    // quietly break this.
    const after = reconcile(emptyProfile('fp', AT), SAID, observeAreas(NOTHING, AT), AT);
    const payment = after.areas.payment;
    assert.deepEqual(payment.state === 'stated' ? payment.picked : null, ['Stripe', 'Paypal']);
  });
});
