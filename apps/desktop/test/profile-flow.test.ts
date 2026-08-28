/**
 * Who is allowed to promote a rung, and what a window is allowed to remember.
 *
 * `profile-flow.ts` holds the session half of the map: which observations
 * belong to which window, and who may write `verified`. The contract half —
 * what a name means, how the ladder is climbed — is tested in
 * `packages/contracts/test/profile-observe.test.ts` and is not repeated here.
 *
 * Four rules, and the first is the one the whole product leans on:
 *
 *   1. `verified` is produced by a person pressing a button, and by nothing
 *      else. Every later screen reads that rung as settled.
 *   2. A confirmation lands only on a rung that was SHOWN something. Nobody
 *      can agree with a blank space.
 *   3. Answers about one database are never reconciled against sightings from
 *      another.
 *   4. Answers arriving before any scan produce nothing, and say so by
 *      returning null rather than inventing an empty map.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { PROFILE_AREAS } from '@ledar/contracts';
import type { SchemaShape } from '@ledar/contracts';

import type { AreaReply } from '../src/shared/ipc.js';
import {
  confirmArea,
  currentFacts,
  forgetObservations,
  noteObservations,
  saveProfile,
} from '../src/main/profile-flow.js';

const AT = '2026-08-28T00:00:00.000Z';
const LATER = '2026-08-28T01:00:00.000Z';
const FP_ONE = 'fingerprint-one';
const FP_TWO = 'fingerprint-two';

/** A schema that settles payments outright and only suggests auth. */
const MIXED: SchemaShape = {
  schemas: ['public'],
  tables: [{ schema: 'public', table: 'users' }],
  columns: [{ schema: 'public', table: 'users', name: 'stripe_customer_id' }],
};

const NOTHING: SchemaShape = { schemas: ['public'], tables: [], columns: [] };

function factsFor(area: (typeof PROFILE_AREAS)[number]) {
  return currentFacts()?.areas.find((a) => a.area === area) ?? null;
}

beforeEach(() => {
  forgetObservations();
});

describe('before a scan has happened', () => {
  it('🟥 answers produce nothing, and say so rather than inventing a map', () => {
    // Rule 4. The answers are about a database; until one has been read there
    // is nothing for them to be about. An empty map returned here would be
    // indistinguishable from a real one where nothing was found.
    const replies: AreaReply[] = [{ area: 'payment', answer: 'yes', picked: [] }];
    assert.equal(saveProfile(replies, AT), null);
    assert.equal(currentFacts(), null);
    assert.equal(confirmArea('payment', AT), null);
  });
});

describe('what the scan saw, put beside what was said', () => {
  beforeEach(() => {
    noteObservations(FP_ONE, MIXED, AT);
  });

  it('a settled sighting becomes observed and carries their answer', () => {
    saveProfile([{ area: 'payment', answer: 'no', picked: [] }], LATER);
    const payment = factsFor('payment');
    assert.equal(payment?.state, 'observed');
    assert.equal(payment?.stated, 'no');
    assert.ok((payment?.evidence.length ?? 0) > 0);
  });

  it('a suggestion stays a suggestion even when they agree with it', () => {
    saveProfile([{ area: 'auth', answer: 'yes', picked: [] }], LATER);
    assert.equal(factsFor('auth')?.state, 'suspected');
  });

  it('an area with nothing seen and nothing said stays unknown', () => {
    saveProfile([], LATER);
    assert.equal(factsFor('jobs')?.state, 'unknown');
    assert.deepEqual(factsFor('jobs')?.evidence, []);
  });

  it('🟥 said no, found it — the disagreement reaches the window', () => {
    saveProfile([{ area: 'payment', answer: 'no', picked: [] }], LATER);
    const conflicts = currentFacts()?.conflicts ?? [];
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]?.area, 'payment');
    assert.equal(conflicts[0]?.direction, 'said_no_found_yes');
  });

  it('every area is present on the way out, whatever its rung', () => {
    // A window that had to handle a missing area would end up inventing a
    // state for it, and the invented one would be the cheerful one.
    saveProfile([], LATER);
    assert.deepEqual(
      currentFacts()?.areas.map((a) => a.area),
      [...PROFILE_AREAS],
    );
  });
});

describe('confirming', () => {
  beforeEach(() => {
    noteObservations(FP_ONE, MIXED, AT);
    saveProfile([{ area: 'payment', answer: 'yes', picked: [] }], LATER);
  });

  it('🟥 a person pressing the button is the only way to reach verified', () => {
    // Rule 1. Nothing before this call produced `verified` — not the scan, not
    // the answers, not the two together.
    assert.notEqual(factsFor('payment')?.state, 'verified');
    confirmArea('payment', LATER);
    assert.equal(factsFor('payment')?.state, 'verified');
  });

  it('confirming keeps the evidence that was shown', () => {
    const before = factsFor('payment')?.evidence.length ?? 0;
    confirmArea('payment', LATER);
    assert.equal(factsFor('payment')?.evidence.length, before);
    assert.ok(before > 0, 'nothing was shown, so this proved nothing');
  });

  it('a suggestion can be confirmed — that is what confirming is for', () => {
    assert.equal(factsFor('auth')?.state, 'suspected');
    confirmArea('auth', LATER);
    assert.equal(factsFor('auth')?.state, 'verified');
  });

  it('🟥 nothing can be confirmed that was never shown', () => {
    // Rule 2. `unknown` and `stated` were shown no evidence — there is no card
    // for a person to have read. Letting a confirmation land there would make
    // `verified` sometimes mean "a human agreed with a measurement" and
    // sometimes "a human clicked beside a blank space", and no later screen
    // could tell which.
    assert.equal(factsFor('jobs')?.state, 'unknown');
    confirmArea('jobs', LATER);
    assert.equal(factsFor('jobs')?.state, 'unknown');

    saveProfile([{ area: 'storage', answer: 'yes', picked: ['s3'] }], LATER);
    assert.equal(factsFor('storage')?.state, 'stated');
    confirmArea('storage', LATER);
    assert.equal(factsFor('storage')?.state, 'stated');
  });

  it('bumps the version, so two maps can be told apart', () => {
    const before = currentFacts()?.version ?? 0;
    confirmArea('payment', LATER);
    assert.equal(currentFacts()?.version, before + 1);
  });
});

describe('one window, one database', () => {
  it('🟥 a scan of a different database starts a fresh map', () => {
    // Rule 3. Answers about one system reconciled against sightings from
    // another would produce a map of a system nobody has — and it would look
    // exactly as convincing as a real one.
    noteObservations(FP_ONE, MIXED, AT);
    saveProfile([{ area: 'payment', answer: 'yes', picked: [] }], LATER);
    confirmArea('payment', LATER);
    assert.equal(factsFor('payment')?.state, 'verified');

    noteObservations(FP_TWO, NOTHING, LATER);
    saveProfile([], LATER);
    assert.equal(
      factsFor('payment')?.state,
      'unknown',
      'a confirmation about one database survived into another',
    );
  });

  it('scanning the same database again keeps what was already agreed', () => {
    // The other half of the same rule. Re-scanning is not a reason to make
    // somebody agree with the same thing twice.
    noteObservations(FP_ONE, MIXED, AT);
    saveProfile([{ area: 'payment', answer: 'yes', picked: [] }], LATER);
    confirmArea('payment', LATER);

    noteObservations(FP_ONE, MIXED, LATER);
    assert.equal(factsFor('payment')?.state, 'verified');
  });

  it('forgetting drops everything the window knew', () => {
    noteObservations(FP_ONE, MIXED, AT);
    saveProfile([], LATER);
    assert.notEqual(currentFacts(), null);
    forgetObservations();
    assert.equal(currentFacts(), null);
  });
});
