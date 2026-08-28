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
import type { Observation, SchemaShape, StatedAnswer } from '../src/index.js';

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
