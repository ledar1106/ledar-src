/**
 * The map, kept between sessions. Ideal §23, schema 7.
 *
 * What is on trial here is not "does a row go in and come out". It is that a
 * person answers five questions ONCE. A profile that comes back different from
 * the one that went in is worse than no profile at all: nobody re-reads it
 * against what they said, so a rung that quietly moved is a rung the product
 * will explain somebody's system with for as long as the file exists.
 *
 * Two rules this file is written under, both from AGENTS §4.3 and §4.16:
 *
 * ① **Every assertion here has to be able to go red.** The one that would
 *    hurt most to get wrong — `verified` cannot exist without evidence and a
 *    confirmation — is asserted against SQLITE rather than against the code
 *    that writes it, by opening the file and inserting the forbidden row by
 *    hand. A guard tested only through its own writer proves the writer, and
 *    the writer is not the only thing that will ever open this file.
 *
 * ② **Nothing is asserted over an empty set.** Every loop and every count is
 *    preceded by a statement of how many things there were to look at, because
 *    `0 of 0 matched` is true and proves nothing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';

// Test-only, exactly as in `vocabulary.test.ts`. `packages/store` has no
// runtime dependency on contracts and must not gain one — a history file has
// to be readable on a machine with nothing else installed. Building the
// fixtures through the real `AreaKnowledge` is the point of importing it here:
// a hand-written object literal would let this suite round-trip a shape the
// contract would have refused, and then agree with itself about it.
import { AreaKnowledge, emptyProfile } from '@ledar/contracts';
import type { ProfileEvidence, ProjectProfile } from '@ledar/contracts';

import { databaseFingerprint } from '../src/identity.js';
import { ScanStore } from '../src/store.js';
import type { DatabaseIdentity } from '../src/types.js';

const DB: DatabaseIdentity = { host: '127.0.0.1', port: 55432, database: 'pagila' };
const FINGERPRINT = databaseFingerprint(DB);

const SCOPE = {
  database: 'pagila',
  role: 'ledar_reader',
  schemas: ['public'],
  visibleTables: 3,
  totalTables: 3,
  grantedAt: null,
  readOnlyEnforcedByDatabase: true,
  disclosure: null,
};

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function historyPath(): string {
  const d = mkdtempSync(join(tmpdir(), 'ledar-profile-'));
  dirs.push(d);
  return join(d, 'history.db');
}

/**
 * A store with the one thing a profile needs to hang on.
 *
 * `openRun` is what creates the `scanned_database` row, and that ordering is
 * the product's own: the scan opens a run before it reads the schema graph the
 * observations come from.
 */
function storeWithDatabase(path: string): ScanStore {
  const store = ScanStore.open(path);
  store.openRun({ database: DB, scope: SCOPE, storeSamples: false });
  return store;
}

const AT = '2026-08-28T09:00:00.000Z';

function evidence(over: Partial<ProfileEvidence> = {}): ProfileEvidence {
  return {
    where: 'public.users.stripe_customer_id',
    why: 'a column named after a payment processor',
    observedAt: AT,
    ...over,
  };
}

/**
 * One profile with every rung of the ladder on it, one per area.
 *
 * Five areas and five DIFFERENT states, on purpose. A fixture where four areas
 * are `unknown` would round-trip perfectly while the four columns that only
 * `stated` and `verified` ever touch went untested — the round trip would be
 * measuring almost nothing and looking exactly the same doing it.
 */
function fullProfile(): ProjectProfile {
  const base = emptyProfile(FINGERPRINT, AT);
  return {
    ...base,
    // Not 1. A version that happens to equal the default cannot show that the
    // column is being read rather than reconstructed.
    version: 4,
    updatedAt: '2026-08-28T09:30:00.000Z',
    areas: {
      auth: AreaKnowledge.parse({
        state: 'observed',
        stated: 'yes',
        evidence: [evidence({ where: 'auth.users', why: 'a Supabase auth schema' })],
      }),
      database: AreaKnowledge.parse({
        state: 'stated',
        answer: 'yes',
        picked: ['postgresql', 'redis'],
      }),
      payment: AreaKnowledge.parse({
        state: 'verified',
        evidence: [evidence(), evidence({ where: 'public.orders', why: 'an orders table' })],
        confirmedAt: '2026-08-28T10:00:00.000Z',
      }),
      storage: AreaKnowledge.parse({
        state: 'suspected',
        // The load-bearing null: nobody was asked about an area the scan found
        // something in.
        stated: null,
        evidence: [evidence({ where: 'public.files', why: 'a table called files' })],
      }),
      jobs: AreaKnowledge.parse({ state: 'unknown' }),
    },
  };
}

/** The raw file, for the assertions that must not go through `ScanStore`. */
function reopenRaw(path: string): DatabaseSync {
  return new DatabaseSync(path);
}

// ---- the round trip, across a close and a reopen ----------------------------

test('a profile survives being closed and opened again, unchanged', () => {
  const path = historyPath();
  const written = fullProfile();

  const store = storeWithDatabase(path);
  store.saveProfile(written);
  store.close();

  // The whole reason this table exists: a different session, a different
  // connection, and the same answers. An in-memory round trip would pass while
  // nothing at all had reached the disk.
  const reopened = ScanStore.open(path);
  const read = reopened.loadProfile(FINGERPRINT);
  reopened.close();

  assert.ok(read, 'the profile did not survive the reopen at all');

  // Said out loud before anything is compared, so this cannot pass by
  // comparing two empty maps: five areas, five distinct rungs.
  const rungs = new Set(Object.values(written.areas).map((a) => a?.state));
  assert.equal(Object.keys(written.areas).length, 5, 'the fixture lost an area');
  assert.equal(rungs.size, 5, 'the fixture stopped covering every rung');

  assert.deepEqual(
    read,
    written,
    'a profile that comes back different from the one that went in is the ' +
      'defect this table exists to prevent — nobody re-reads a map against ' +
      'what they said, so a rung that moved quietly stays moved',
  );
});

test('a verified rung comes back verified, with the moment it was agreed', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);
  store.saveProfile(fullProfile());
  const read = store.loadProfile(FINGERPRINT);
  store.close();

  const payment = read?.areas['payment'];
  assert.equal(payment?.state, 'verified');
  assert.equal(
    payment?.state === 'verified' ? payment.confirmedAt : null,
    '2026-08-28T10:00:00.000Z',
    'a boolean would have said somebody once agreed. The question six months ' +
      'later is WHEN — a system changes, and an agreement about March is not ' +
      'an agreement about now',
  );
  assert.equal(
    payment?.state === 'verified' ? payment.evidence.length : 0,
    2,
    'the evidence a person was shown has to come back with their agreement, ' +
      'or the agreement is about nothing',
  );
  assert.equal(
    payment?.state === 'verified' ? payment.evidence[1]?.where : null,
    'public.orders',
    'evidence order is part of the record: the second item is the second item',
  );
});

// ---- the file refuses what the contract refuses -----------------------------

test('the FILE cannot hold a verified rung with nothing behind it', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);
  store.saveProfile(fullProfile());
  store.close();

  // Deliberately NOT through `saveProfile`. A rule enforced only by the one
  // writer is a rule an import tool, a repair script, or somebody with the
  // sqlite3 CLI never hears about — and `verified` is the single rung that
  // claims a HUMAN agreed. A file able to hold one that nobody earned is a
  // file able to manufacture that agreement.
  const raw = reopenRaw(path);
  const id = raw.prepare(`SELECT database_id AS id FROM project_profile`).get();
  assert.ok(id, 'there is no profile row to attach the forbidden rungs to');

  const INSERT = `
    INSERT INTO project_profile_area (
      database_id, area, state, answer, picked_json, evidence_json,
      stated_answer, confirmed_at
    ) VALUES (?, 'jobs', 'verified', NULL, NULL, ?, NULL, ?)
  `;
  const seen = JSON.stringify([evidence()]);

  // Each case names the fence that is supposed to catch it, rather than only
  // asking whether something went wrong. §4.3: reading "it threw" instead of
  // "it threw for the reason claimed" is how a refusal that fires for an
  // unrelated syntax error gets counted as a live fence.
  const cases: readonly [string, [string | null, string | null], RegExp][] = [
    ['no evidence at all', [null, '2026-08-28T10:00:00.000Z'], /verified_is_seen_and_agreed/],
    ['an empty evidence list', ['[]', '2026-08-28T10:00:00.000Z'], /verified_is_seen_and_agreed/],
    // Caught one fence earlier — by the column constraint, before the rung's.
    // Both are correct refusals and the earlier one is the tighter statement.
    ['evidence that is not a list', ['{"where":"a"}', '2026-08-28T10:00:00.000Z'], /evidence_is_a_list/],
    ['no confirmedAt', [seen, null], /verified_is_seen_and_agreed/],
    ['a blank confirmedAt', [seen, ''], /verified_is_seen_and_agreed/],
    // 🟥 Added 2026-08-28 after writing this row by hand and watching it land.
    // The constraint said `confirmed_at <> ''` while the comment above it
    // claimed whitespace was refused too — so the claim was false for exactly
    // the value it named, and the case that would have caught it was the one
    // case missing from this list. `trim()` closes it.
    //
    // The same hole `saying()` exists to close on a finding's prose: a value
    // that passes every presence check and says nothing. Here it would date a
    // person's agreement to nothing at all.
    ['a whitespace confirmedAt', [seen, '   '], /verified_is_seen_and_agreed/],
  ];
  assert.equal(cases.length, 6, 'there is nothing here to refuse');

  for (const [what, args, fence] of cases) {
    assert.throws(
      () => raw.prepare(INSERT).run(id['id'] as number, ...args),
      // The constraints are NAMED so the error says which rule was broken
      // rather than only which table. A person reading "CHECK constraint
      // failed: project_profile_area" has nothing to act on.
      fence,
      `SQLite accepted a verified rung with ${what}`,
    );
  }
  raw.close();
});

test('the file refuses a sighting with an empty evidence list', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);
  store.saveProfile(fullProfile());
  store.close();

  const raw = reopenRaw(path);
  const id = Number(
    (raw.prepare(`SELECT database_id AS id FROM project_profile`).get() as Record<string, unknown>)[
      'id'
    ],
  );

  // `observed` with nothing to point at reads as "seen, but we cannot say
  // what" — a sentence this product is not allowed to write.
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO project_profile_area (database_id, area, state, evidence_json, stated_answer)
           VALUES (?, 'jobs', 'observed', '[]', NULL)`,
        )
        .run(id),
    /a_sighting_names_what_was_seen/,
  );

  // And a claim may not carry a measurement it never made.
  assert.throws(
    () =>
      raw
        .prepare(
          `INSERT INTO project_profile_area (database_id, area, state, answer, picked_json, evidence_json)
           VALUES (?, 'jobs', 'stated', 'yes', '[]', '[{"where":"a"}]')`,
        )
        .run(id),
    /stated_is_only_what_was_said/,
  );
  raw.close();
});

// ---- nothing there is a normal state ---------------------------------------

test('a database nobody has answered about loads as null, not as an error', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);

  assert.equal(
    store.loadProfile(FINGERPRINT),
    null,
    'a run exists for this database and no profile does. That is the ordinary ' +
      'case — most databases have never been asked about — and treating it as ' +
      'a failure is the mistake the `unknown` rung exists to refuse',
  );

  // And a fingerprint this history has never heard of is the same answer,
  // rather than a different failure that a caller would have to tell apart.
  assert.equal(store.loadProfile('a-fingerprint-of-nothing'), null);

  // The null is about absence and not about the read being broken: save one,
  // and the same call answers.
  store.saveProfile(fullProfile());
  assert.ok(store.loadProfile(FINGERPRINT), 'the null above was not about absence');
  store.close();
});

// ---- one profile per database ----------------------------------------------

test('saving twice replaces the map instead of stacking a second one', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);

  const first = fullProfile();
  store.saveProfile(first);

  const second: ProjectProfile = {
    ...first,
    version: first.version + 1,
    updatedAt: '2026-08-28T11:00:00.000Z',
    areas: {
      ...first.areas,
      // The person looked at what was found for storage and agreed.
      storage: AreaKnowledge.parse({
        state: 'verified',
        evidence: [evidence({ where: 'public.files', why: 'a table called files' })],
        confirmedAt: '2026-08-28T11:00:00.000Z',
      }),
    },
  };
  store.saveProfile(second);
  store.close();

  const raw = reopenRaw(path);
  const profiles = Number(
    (raw.prepare(`SELECT count(*) AS n FROM project_profile`).get() as Record<string, unknown>)['n'],
  );
  const areas = Number(
    (
      raw.prepare(`SELECT count(*) AS n FROM project_profile_area`).get() as Record<string, unknown>
    )['n'],
  );
  raw.close();

  assert.equal(profiles, 1, 'two profiles for one database is two answers to one question');
  assert.equal(
    areas,
    5,
    'ten area rows would mean the second save stacked on the first. Half of ' +
      'them would be a rung from an older map, sitting beside the current ' +
      'ones under a version claiming all five were written together',
  );

  const reopened = ScanStore.open(path);
  const read = reopened.loadProfile(FINGERPRINT);
  reopened.close();
  assert.deepEqual(read, second, 'the second save is the one that is there');
});

test('an area dropped from the map does not survive the save that dropped it', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);

  const first = fullProfile();
  store.saveProfile(first);
  assert.equal(
    store.loadProfile(FINGERPRINT)?.areas['payment']?.state,
    'verified',
    'the area has to be there first, or its removal below measures nothing',
  );

  const withoutPayment = { ...first.areas };
  delete withoutPayment['payment'];
  store.saveProfile({ ...first, version: first.version + 1, areas: withoutPayment });

  const read = store.loadProfile(FINGERPRINT);
  store.close();

  assert.equal(Object.keys(read?.areas ?? {}).length, 4);
  assert.equal(
    read?.areas['payment'],
    undefined,
    'a save is a whole map, not a patch. An upserted-per-area store would ' +
      'leave the old `verified` rung behind — an agreement nobody has made ' +
      'since, filed under the current version',
  );
});

// ---- the nulls that carry meaning ------------------------------------------

test('a sighting nobody was asked about comes back with nothing said, not with an answer', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);
  store.saveProfile(fullProfile());
  const read = store.loadProfile(FINGERPRINT);
  store.close();

  const storage = read?.areas['storage'];
  assert.equal(storage?.state, 'suspected');
  assert.equal(
    storage?.state === 'suspected' ? storage.stated : 'not-read',
    null,
    'null means the person was never asked. Reading it back as `dont_know` ' +
      'would turn a question nobody put to them into an answer they gave',
  );

  // The other half of the same column: an answer that WAS given survives.
  const auth = read?.areas['auth'];
  assert.equal(
    auth?.state === 'observed' ? auth.stated : null,
    'yes',
    'what they said is kept beside what was seen — a disagreement between ' +
      'the two is the most valuable thing on the screen',
  );
});

test('a picked list survives with its order and its emptiness', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);

  const base = fullProfile();
  store.saveProfile({
    ...base,
    areas: {
      ...base.areas,
      // `AreaKnowledge.parse` fills `picked` in from its own `.default([])`,
      // which is what the store reproduces rather than inventing.
      jobs: AreaKnowledge.parse({ state: 'stated', answer: 'no' }),
    },
  });
  const read = store.loadProfile(FINGERPRINT);
  store.close();

  const database = read?.areas['database'];
  assert.deepEqual(
    database?.state === 'stated' ? database.picked : null,
    ['postgresql', 'redis'],
    'the order is what they picked first, and a set would lose it',
  );

  const jobs = read?.areas['jobs'];
  assert.equal(jobs?.state, 'stated');
  assert.deepEqual(
    jobs?.state === 'stated' ? jobs.picked : null,
    [],
    'an empty list is "they said no and picked nothing", which is not the ' +
      'same as an area nobody asked about',
  );
});

// ---- what the DDL cannot reach, and what does it instead --------------------

test('evidence nobody could go and check is refused, and told why', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);
  const base = fullProfile();

  // The DDL reaches the array — it must be an array, and a sighting's must not
  // be empty — and stops there: looking INSIDE it needs `json_each`, which is
  // a table-valued function, and a CHECK may not hold a subquery. So this is
  // the one writer's job, and these three are what an observation needs to be
  // checkable by the person it is about.
  const broken: [string, Partial<ProfileEvidence>][] = [
    ['where', { where: '' }],
    ['why', { why: '   ' }],
    ['observedAt', { observedAt: '' }],
  ];
  assert.equal(broken.length, 3, 'all three fields have to be tried, or one is unguarded');

  for (const [field, over] of broken) {
    assert.throws(
      () =>
        store.saveProfile({
          ...base,
          areas: {
            ...base.areas,
            jobs: {
              state: 'observed',
              stated: null,
              evidence: [evidence(over)],
            },
          },
        }),
      new RegExp(`usable \`${field}\``),
      `evidence with a blank ${field} was accepted`,
    );
  }

  // And the refusal is whole: the transaction took the profile with it, so
  // nothing half-written is left behind.
  assert.equal(
    store.loadProfile(FINGERPRINT),
    null,
    'a refused save must leave no profile at all, or the map on disk is half ' +
      'of one nobody wrote',
  );
  store.close();
});

test('a profile about a database this history has never opened a run against is refused', () => {
  const path = historyPath();
  const store = ScanStore.open(path);

  // No `openRun`, so no `scanned_database` row. The row exists to hold a
  // LABEL — what the person calls this database — and a profile carries none,
  // so creating it here would mean inventing one.
  assert.throws(
    () => store.saveProfile(emptyProfile(FINGERPRINT, AT)),
    /no record of the database|open a run against it first/,
  );
  assert.equal(store.loadProfile(FINGERPRINT), null);
  store.close();
});

// ---- a file written past the fence -----------------------------------------

test('a rung this build does not know is refused on the way out, not guessed at', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);
  store.saveProfile(fullProfile());
  store.close();

  const raw = reopenRaw(path);
  const id = Number(
    (raw.prepare(`SELECT database_id AS id FROM project_profile`).get() as Record<string, unknown>)[
      'id'
    ],
  );
  // The only way to get such a row into the file, which is itself the measure
  // of how tight the DDL is. It is still worth guarding the read: this is the
  // shape a NEWER build with a sixth rung would leave behind, and reading it
  // as one of the five would be a guess about how strongly somebody's system
  // was claimed to be understood.
  raw.exec('PRAGMA ignore_check_constraints = ON');
  raw
    .prepare(
      `UPDATE project_profile_area SET state = 'proven', confirmed_at = NULL,
       evidence_json = NULL WHERE area = 'payment'`,
    )
    .run();
  raw.close();

  const reopened = ScanStore.open(path);
  assert.throws(
    () => reopened.loadProfile(FINGERPRINT),
    /rung called "proven".*this build does not know/s,
  );
  reopened.close();
});

test('an area this build does not render is refused rather than dropped', () => {
  const path = historyPath();
  const store = storeWithDatabase(path);
  store.saveProfile(fullProfile());
  store.close();

  const raw = reopenRaw(path);
  raw.exec('PRAGMA ignore_check_constraints = ON');
  raw.prepare(`UPDATE project_profile_area SET area = 'email' WHERE area = 'jobs'`).run();
  raw.close();

  const reopened = ScanStore.open(path);
  // Refused, not skipped. A sixth area silently dropped would leave a map that
  // looks complete and is missing a whole question.
  assert.throws(
    () => reopened.loadProfile(FINGERPRINT),
    /area called "email".*this build does not know/s,
  );
  reopened.close();
});

// ---- the bump ---------------------------------------------------------------

test('a schema-6 history is retired rather than written into', async () => {
  const path = historyPath();

  // Schema 6 had no profile tables. Opening one with this build and writing a
  // profile into it would fail on "no such table: project_profile" — after the
  // person had already answered five questions. The gate reads one row of
  // `store_meta`, so that is what this writes.
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
  old.prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?)`).run('schema_version', '6');
  old.exec(`CREATE TABLE run (id INTEGER PRIMARY KEY, marker TEXT NOT NULL) STRICT`);
  old.prepare(`INSERT INTO run (id, marker) VALUES (1, 'a real run from schema 6')`).run();
  old.close();

  const { openHistory } = await import('../src/retire.js');
  const { store, retired } = openHistory(path);

  assert.notEqual(retired, null, 'the move has to be reported, not just done');
  assert.equal(retired?.version, 6);
  assert.equal(retired?.runs, 1);
  assert.match(retired?.to ?? '', /history\.v6\.db$/);

  // And the file it moved aside is still readable, which is the promise the
  // whole retirement path is built on.
  const kept = new DatabaseSync(retired!.to, { readOnly: true });
  const marker = kept.prepare(`SELECT marker FROM run WHERE id = 1`).get();
  kept.close();
  assert.equal(String(marker?.['marker']), 'a real run from schema 6');

  // The new file is usable immediately: a run, and then a profile.
  store.openRun({ database: DB, scope: SCOPE, storeSamples: false });
  store.saveProfile(fullProfile());
  assert.ok(store.loadProfile(FINGERPRINT));
  store.close();
});
