/**
 * The entity map, into the file and back out.
 *
 * Two things are being tested here and they are not the same thing:
 *
 * ```text
 * round trip      what goes in comes out, unchanged, across a close and reopen
 * the FILE's own  what SQLite refuses when the writer is not this module —
 *   refusals      raw SQL, an import tool, somebody at 2am with the CLI
 * ```
 *
 * The second is the reason `entity_edge` is columns rather than a JSON blob,
 * so the tests that matter most below are the ones that bypass `writeMap`
 * entirely and hand SQLite a row it must reject on its own.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

// Built through the real contract, so a fixture that could not exist in the
// product cannot be smuggled into a store test.
import { EntityEdge } from '@ledar/contracts';
import type { EntityEdge as Edge, EntityGraph } from '@ledar/contracts';

import { databaseFingerprint } from '../src/identity.js';
import { ScanStore } from '../src/store.js';
import type { DatabaseIdentity } from '../src/types.js';

const DB: DatabaseIdentity = { host: '127.0.0.1', port: 55432, database: 'pagila' };
const FINGERPRINT = databaseFingerprint(DB);
const AT = '2026-08-28T09:00:00.000Z';

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
  const d = mkdtempSync(join(tmpdir(), 'ledar-map-'));
  dirs.push(d);
  return join(d, 'history.db');
}

function storeWithDatabase(path: string): ScanStore {
  const store = ScanStore.open(path);
  store.openRun({ database: DB, scope: SCOPE, storeSamples: false });
  return store;
}

const DECLARED = EntityEdge.parse({
  from: { schema: 'public', table: 'rental' },
  to: { schema: 'public', table: 'customer' },
  via: 'customer_id',
  tier: 'declared',
  why: 'the database enforces this with a foreign key',
  matched: null,
  join: { from: ['customer_id'], to: ['customer_id'] },
});

const NOT_VALID = EntityEdge.parse({
  from: { schema: 'public', table: 'damaged_rental_note' },
  to: { schema: 'public', table: 'rental' },
  via: 'rental_id',
  tier: 'declared',
  why:
    'the database has a foreign key for this, but it was declared NOT VALID — it holds ' +
    'for rows written from now on, and the rows already there were never checked against it',
  matched: null,
  // N58: deliberately WITHOUT a join. A declared edge whose source did not
  // carry the parent columns still asserts the relationship, and the round
  // trip has to keep it that way rather than dropping the row.
  join: null,
});

const MEASURED = EntityEdge.parse({
  from: { schema: 'public', table: 'invoice' },
  to: { schema: 'public', table: 'customer' },
  via: 'customer_id',
  tier: 'measured',
  why: '4,812 of 4,900 values here name a row in public.customer',
  matched: { of: 4900, found: 4812 },
  // Required on this tier: nothing could have counted 4,812 without knowing
  // which column on the other side it was counting against.
  join: { from: ['customer_id'], to: ['customer_id'] },
});

const GUESSED = EntityEdge.parse({
  from: { schema: 'public', table: 'store' },
  to: { schema: 'public', table: 'staff' },
  via: 'manager_staff_id',
  tier: 'guessed',
  why: 'the column is called "manager_staff_id", and after the "manager_" part it names a table called "staff"',
  matched: null,
});

const GRAPH: EntityGraph = { edges: [DECLARED, NOT_VALID, MEASURED, GUESSED] };

describe('a map survives the window that built it', () => {
  it('🟥 comes back the same after a close and a reopen', () => {
    // Ideal §45. The whole reason the map is stored, since rebuilding it costs
    // nothing: this is what lets a question be answered without opening
    // anybody's database.
    const path = historyPath();
    const store = storeWithDatabase(path);
    store.saveMap(FINGERPRINT, GRAPH, AT);
    store.close();

    const reopened = ScanStore.open(path);
    const back = reopened.loadMap(FINGERPRINT);
    reopened.close();

    assert.equal(back?.edges.length, 4);
    // Order is by name, not by insertion — a file is not a queue. Sorted by
    // the FULL key both sides agree on, because `via` alone is not one: two of
    // these edges travel on `customer_id`, and a sort that ties would compare
    // whichever order each side happened to produce.
    const key = (e: Edge) =>
      `${e.from.schema}.${e.from.table}|${e.via}|${e.to.schema}.${e.to.table}`;
    const byKey = (a: Edge, b: Edge) => key(a).localeCompare(key(b));
    assert.deepEqual([...(back?.edges ?? [])].sort(byKey), [...GRAPH.edges].sort(byKey));
  });

  it('🟥 the sentence carrying a limit survives verbatim', () => {
    // NOT VALID and partial partition coverage both live entirely in `why`.
    // A round trip that dropped or truncated it would turn "never checked
    // against the rows already there" into "the database enforces this".
    const store = storeWithDatabase(historyPath());
    store.saveMap(FINGERPRINT, GRAPH, AT);
    const back = store.loadMap(FINGERPRINT);
    store.close();

    const found = back?.edges.find((e) => e.via === 'rental_id');
    assert.equal(found?.why, NOT_VALID.why);
    assert.match(found?.why ?? '', /NOT VALID/);
  });

  it('a match rate comes back as numbers, not as a string', () => {
    const store = storeWithDatabase(historyPath());
    store.saveMap(FINGERPRINT, GRAPH, AT);
    const back = store.loadMap(FINGERPRINT);
    store.close();

    const found = back?.edges.find((e) => e.tier === 'measured');
    assert.deepEqual(found?.matched, { of: 4900, found: 4812 });
  });

  it('🟥 no map is null, and an empty map is not', () => {
    // Opposite sentences to say to somebody who just inherited a system:
    // "nobody has looked here" and "this database has no relationships".
    const store = storeWithDatabase(historyPath());
    assert.equal(store.loadMap(FINGERPRINT), null);

    store.saveMap(FINGERPRINT, { edges: [] }, AT);
    assert.deepEqual(store.loadMap(FINGERPRINT), { edges: [] });
    store.close();
  });

  it('🟥 a row whose join does not line up is dropped on the way back', () => {
    // The DDL refuses this shape, so the reader's own check is unreachable
    // through any writer here — which is exactly the state where a guard
    // rots. `ignore_check_constraints` produces the one file that can hold
    // it: one written by something that did not honour the CHECK.
    //
    // Dropped rather than repaired, for the reason an unknown tier is: a join
    // that does not line up joins the wrong columns, and the rows that come
    // back look exactly like right ones.
    const path = historyPath();
    const store = storeWithDatabase(path);
    store.saveMap(FINGERPRINT, { edges: [] }, AT);
    store.close();

    const raw = new DatabaseSync(path);
    try {
      const id = (raw.prepare(`SELECT id FROM scanned_database LIMIT 1`).get() as { id: number }).id;
      raw.exec('PRAGMA ignore_check_constraints = ON');
      raw
        .prepare(
          `INSERT INTO entity_edge (
             database_id, from_schema, from_table, to_schema, to_table,
             via, tier, why, join_from_json, join_to_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          'public',
          'a',
          'public',
          'b',
          'x, y',
          'declared',
          'the database enforces this with a foreign key',
          '["x","y"]',
          '["x"]',
        );
    } finally {
      raw.close();
    }

    const back = ScanStore.open(path);
    const read = back.loadMap(FINGERPRINT);
    back.close();
    assert.deepEqual(read?.edges, []);
  });

  it('🟩 the join survives the round trip, both sides and their order', () => {
    // N58. The whole point of the bump: a route through the map has to come
    // back joinable, and a join is a PAIRING — reversing one side silently
    // joins the wrong columns to each other, which returns rows that look
    // exactly like right ones.
    const path = historyPath();
    const store = storeWithDatabase(path);
    const composite = EntityEdge.parse({
      from: { schema: 'public', table: 'damaged_label_link' },
      to: { schema: 'public', table: 'damaged_label' },
      via: 'label_slug, label_key',
      tier: 'declared',
      why: 'the database enforces this with a foreign key',
      matched: null,
      join: { from: ['label_slug', 'label_key'], to: ['slug', 'key'] },
    });
    store.saveMap(FINGERPRINT, { edges: [composite] }, AT);
    store.close();

    const back = ScanStore.open(path);
    const read = back.loadMap(FINGERPRINT);
    back.close();

    assert.equal(read?.edges.length, 1);
    assert.deepEqual(read?.edges[0]?.join, {
      from: ['label_slug', 'label_key'],
      to: ['slug', 'key'],
    });
  });

  it('🟩 a declared edge with no join comes back as an edge, not as nothing', () => {
    // The relationship is still one the database declares. Dropping the row
    // because this product could not work out the parent columns would delete
    // something Postgres enforces, which is worse than the gap it came from.
    const path = historyPath();
    const store = storeWithDatabase(path);
    store.saveMap(FINGERPRINT, { edges: [NOT_VALID] }, AT);
    store.close();

    const back = ScanStore.open(path);
    const read = back.loadMap(FINGERPRINT);
    back.close();

    assert.equal(read?.edges.length, 1);
    assert.equal(read?.edges[0]?.tier, 'declared');
    assert.equal(read?.edges[0]?.join, null);
  });

  it('saving again replaces rather than accumulates', () => {
    // A dropped foreign key must not survive as a `declared` edge saying the
    // database enforces something it no longer mentions.
    const store = storeWithDatabase(historyPath());
    store.saveMap(FINGERPRINT, GRAPH, AT);
    store.saveMap(FINGERPRINT, { edges: [GUESSED] }, AT);
    const back = store.loadMap(FINGERPRINT);
    store.close();

    assert.equal(back?.edges.length, 1);
    assert.equal(back?.edges[0]?.tier, 'guessed');
  });

  it('a map for a database this history never opened is refused', () => {
    const store = ScanStore.open(historyPath());
    assert.throws(
      () => store.saveMap(FINGERPRINT, GRAPH, AT),
      /No scanned database with fingerprint/,
    );
    store.close();
  });
});

describe('what the FILE refuses, with this module out of the way', () => {
  /**
   * Writes a row with raw SQL, the way a second writer would.
   *
   * The point of every test below: `writeMap` could be careful and the file
   * would still be wrong the first time anything else touched it.
   */
  function rawInsert(path: string, columns: string, values: readonly unknown[]): void {
    const store = storeWithDatabase(path);
    store.saveMap(FINGERPRINT, { edges: [] }, AT);
    store.close();

    const db = new DatabaseSync(path);
    try {
      const id = (db.prepare(`SELECT id FROM scanned_database LIMIT 1`).get() as { id: number }).id;
      db.prepare(
        `INSERT INTO entity_edge (database_id, ${columns}) VALUES (?${', ?'.repeat(values.length)})`,
      ).run(id, ...(values as never[]));
    } finally {
      db.close();
    }
  }

  const COLS = 'from_schema, from_table, to_schema, to_table, via, tier, why';
  const OK = ['public', 'rental', 'public', 'customer', 'customer_id'];

  it('🟥 a match rate on a declared edge', () => {
    // 60% of an enforced constraint, shown to somebody who cannot check it,
    // with nothing having counted anything.
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, matched_of, matched_found`, [
          ...OK,
          'declared',
          'the database enforces this with a foreign key',
          100,
          60,
        ]),
      /rate_belongs_to_measured/,
    );
  });

  it('🟥 a measured edge with no count', () => {
    // Not a weak measurement. An edge claiming a tier it never earned.
    assert.throws(
      () => rawInsert(historyPath(), COLS, [...OK, 'measured', 'something counted, apparently']),
      /rate_belongs_to_measured/,
    );
  });

  it('🟥 a rate above one', () => {
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, matched_of, matched_found`, [
          ...OK,
          'measured',
          '11 of 10 values matched',
          10,
          11,
        ]),
      /rate_belongs_to_measured/,
    );
  });

  it('🟥 an edge whose sentence is blank', () => {
    // `why` is where every limit lives — NOT VALID, partial partition
    // coverage, which naming rung fired. An edge with a blank one is an
    // enforcement claim with its limit deleted.
    assert.throws(() => rawInsert(historyPath(), COLS, [...OK, 'declared', '']), /CHECK/);
  });

  it('🟥 an edge whose sentence is only spaces', () => {
    // `trim()`, not `<> ''`. The exact hole found in
    // `verified_is_seen_and_agreed` the day this table was written.
    assert.throws(() => rawInsert(historyPath(), COLS, [...OK, 'declared', '   ']), /CHECK/);
  });

  it('🟥 a guessed edge carrying a join', () => {
    // N58. `guessedEdges` matches a TABLE name and never looks for a column,
    // so a guessed edge with a join is one that learned something nobody
    // measured — the same shape as a match rate on a declared edge above.
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, join_from_json, join_to_json`, [
          ...OK,
          'guessed',
          'the column is called "customer_id" and so is a table in this schema',
          '["customer_id"]',
          '["customer_id"]',
        ]),
      /join_belongs_to_a_named_column/,
    );
  });

  it('🟥 a measured edge with no join', () => {
    // A rate nobody could have counted: there is no other side to count
    // against. Refused for the reason the missing rate is.
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, matched_of, matched_found`, [
          ...OK,
          'measured',
          '9 of 10 values here name a row in public.customer',
          10,
          9,
        ]),
      /join_belongs_to_a_named_column/,
    );
  });

  it('🟥 a join whose two sides are different lengths', () => {
    // Not a weaker edge. A three-column key joined against two columns
    // returns the WRONG ROWS, and they look exactly like right ones.
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, join_from_json, join_to_json`, [
          ...OK,
          'declared',
          'the database enforces this with a foreign key',
          '["a","b"]',
          '["a"]',
        ]),
      /join_belongs_to_a_named_column/,
    );
  });

  it('🟥 half a join', () => {
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, join_from_json`, [
          ...OK,
          'declared',
          'the database enforces this with a foreign key',
          '["a"]',
        ]),
      /join_belongs_to_a_named_column/,
    );
  });

  it('🟥 a join that is not a list', () => {
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, join_from_json, join_to_json`, [
          ...OK,
          'declared',
          'the database enforces this with a foreign key',
          '"customer_id"',
          '"customer_id"',
        ]),
      /join_belongs_to_a_named_column/,
    );
  });

  it('🟥 an empty join', () => {
    // Not "joined on nothing" — there is no such join, and a row saying so
    // would be a cross product waiting for somebody to build it.
    assert.throws(
      () =>
        rawInsert(historyPath(), `${COLS}, join_from_json, join_to_json`, [
          ...OK,
          'declared',
          'the database enforces this with a foreign key',
          '[]',
          '[]',
        ]),
      /join_belongs_to_a_named_column/,
    );
  });

  it('a tier nobody has heard of', () => {
    assert.throws(
      () => rawInsert(historyPath(), COLS, [...OK, 'probably', 'a fourth tier from the future']),
      /CHECK/,
    );
  });

  it('an edge that travels on no column', () => {
    assert.throws(
      () =>
        rawInsert(historyPath(), COLS, [
          'public',
          'rental',
          'public',
          'customer',
          '',
          'declared',
          'the database enforces this with a foreign key',
        ]),
      /CHECK/,
    );
  });

  it('🟥 an edge belonging to no map at all', () => {
    // The foreign key to `entity_map` is what makes "nobody has looked"
    // distinguishable from "no relationships". Without it an orphan edge would
    // answer a question nobody had built a map to ask.
    const path = historyPath();
    const store = storeWithDatabase(path);
    store.close();

    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA foreign_keys = ON');
      const id = (db.prepare(`SELECT id FROM scanned_database LIMIT 1`).get() as { id: number }).id;
      assert.throws(
        () =>
          db
            .prepare(`INSERT INTO entity_edge (database_id, ${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, ...OK, 'declared', 'the database enforces this with a foreign key'),
        /FOREIGN KEY/,
      );
    } finally {
      db.close();
    }
  });
});
