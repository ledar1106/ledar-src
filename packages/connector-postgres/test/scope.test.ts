/**
 * What the scope report says, and what it must never say.
 *
 * Two halves, on purpose:
 *
 *   1. `classifySchemas` on its own, with no database in sight. The bug this
 *      replaces was not in any SQL — it was one field read from the list of
 *      schemas that were *asked for* while its opposite was read from the
 *      list the catalog said were *granted*. A schema asked for and refused
 *      appeared in both at once, and the report claimed it had been read.
 *      That is a sorting mistake, so it is tested as a sorting mistake.
 *
 *   2. The counts, against the Pagila fixture, because the interesting one
 *      is a claim about the whole database and cannot be checked by reading
 *      the code that produced it.
 *
 * On the denominator that matters: `tablesInDatabase` counts tables in every
 * schema, including schemas this role cannot enter, because `pg_class` rows
 * are not filtered by schema privileges. Pagila cannot demonstrate that — it
 * has one schema and the role can read all of it. It was verified against the
 * second environment (a Supabase project, Postgres 17.6) where the same role
 * has no USAGE on `auth`, `realtime`, `_realtime`, `supabase_functions`,
 * `supabase_migrations` or `vault`: `pg_class` still counts their 39 tables
 * while `information_schema.tables`, which *is* privilege-filtered, reports 0
 * for every one of them. Those numbers came with this slice's handover and
 * belong in `field-results.md`.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { Client } from 'pg';

import { classifySchemas, describeScope, readScope } from '../src/scope.js';

// One shared gate for all the suites, so the DSN and the fixture table list
// cannot drift apart across copies.
import {
  FIXTURE_SCHEMA,
  announceSkip,
  openPagila,
} from '@ledar/test-fixtures';

// ---- no database needed ----------------------------------------------------

describe('classifySchemas', () => {
  it('never puts one schema in two answers at once', () => {
    const access = classifySchemas([
      { name: 'public', present: true, granted: true },
      { name: 'auth', present: true, granted: false },
      { name: 'nope', present: false, granted: false },
    ]);

    assert.deepEqual(access.granted, ['public']);
    assert.deepEqual(access.refused, ['auth']);
    assert.deepEqual(access.missing, ['nope']);

    // The shape of the old bug: `auth` was reported as granted because it had
    // been asked for, and as not granted because the catalog said so.
    const everywhere = [...access.granted, ...access.refused, ...access.missing];
    assert.equal(
      new Set(everywhere).size,
      everywhere.length,
      'a schema appears in more than one of the three answers',
    );
  });

  it('treats a schema that is not there as missing, not as refused', () => {
    const access = classifySchemas([{ name: 'typo', present: false, granted: false }]);

    assert.deepEqual(access.missing, ['typo']);
    assert.deepEqual(access.refused, []);
    assert.deepEqual(access.granted, []);
  });

  it('asking for the same schema twice is still one schema', () => {
    const access = classifySchemas([
      { name: 'public', present: true, granted: true },
      { name: 'public', present: true, granted: true },
    ]);

    assert.deepEqual(access.granted, ['public']);
  });
});

// ---- against the fixture ---------------------------------------------------

const SUITE = 'readScope against the Pagila fixture';

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);

  describe(SUITE, () => {
    it('the scope was not read', { skip: gate.reason }, () => {
      assert.fail('unreachable: this test is skipped');
    });
  });
} else {
  const client: Client = gate.client;

  describe(SUITE, () => {
    after(async () => {
      await client.end();
    });

    it('reports what it could read and what exists, as two measurements', async () => {
      const scope = await readScope(client, [FIXTURE_SCHEMA]);

      assert.deepEqual(scope.schemasGranted, [FIXTURE_SCHEMA]);
      assert.deepEqual(scope.schemasRefused, []);
      assert.deepEqual(scope.schemasMissing, []);
      assert.equal(scope.database, 'pagila');

      assert.ok(
        scope.tablesReadable > 0,
        'the fixture has tables and none of them were counted as readable',
      );
      assert.equal(scope.tablesReadable, scope.tablesInRequestedSchemas);

      // The invariant `assertScopeManifest` enforces. Break it and every
      // report built on this manifest is refused — which is the correct
      // outcome, and a reason to find out here instead.
      assert.ok(
        scope.tablesInDatabase >= scope.tablesReadable,
        `tablesInDatabase (${scope.tablesInDatabase}) is smaller than the ` +
          `${scope.tablesReadable} tables that were just read`,
      );
      assert.ok(scope.tablesReadableInDatabase >= scope.tablesReadable);
      assert.ok(scope.tablesInDatabase >= scope.tablesReadableInDatabase);
    });

    it('a schema that does not exist is named, not silently counted as read', async () => {
      const scope = await readScope(client, [FIXTURE_SCHEMA, 'ledar_no_such_schema']);

      assert.deepEqual(
        scope.schemasGranted,
        [FIXTURE_SCHEMA],
        'a schema that is not in this database was reported as granted',
      );
      assert.deepEqual(scope.schemasMissing, ['ledar_no_such_schema']);
      assert.deepEqual(scope.schemasRefused, []);

      const said = describeScope(scope).join('\n');
      assert.match(said, /ledar_no_such_schema/);

      // The denominator is a fact about the database, so asking for a schema
      // that is not there must not move it. If a typo could shrink the total,
      // "35 of 35 — all of them" would be one keystroke away.
      const real = await readScope(client, [FIXTURE_SCHEMA]);
      assert.equal(scope.tablesInDatabase, real.tablesInDatabase);
      assert.equal(scope.tablesReadable, real.tablesReadable);
    });

    it('the revoke script only names schemas that are actually here', async () => {
      const scope = await readScope(client, [FIXTURE_SCHEMA, 'ledar_no_such_schema']);

      assert.match(scope.revokeSql, /REVOKE ALL ON SCHEMA "public"/);
      assert.ok(
        !scope.revokeSql.includes('ledar_no_such_schema'),
        'the revoke script names a schema that does not exist, so running it ' +
          'would abort on that line and take the rest of the script with it',
      );
    });

    it('pointing at a system schema does not produce a total smaller than the count', async () => {
      // `pg_catalog` is excluded from "every schema in this database", so
      // without the clause that adds the requested schemas back in, the total
      // would come back smaller than the number of tables just read — a
      // manifest that fails its own consistency check, from a scan that did
      // nothing wrong.
      const scope = await readScope(client, ['pg_catalog']);

      assert.ok(scope.tablesReadable > 0, 'pg_catalog has readable tables');
      assert.ok(
        scope.tablesInDatabase >= scope.tablesReadable,
        `tablesInDatabase (${scope.tablesInDatabase}) is smaller than the ` +
          `${scope.tablesReadable} tables read out of pg_catalog`,
      );
    });

    it('names the schemas it never looked at', async () => {
      const scope = await readScope(client, ['ledar_no_such_schema']);

      assert.ok(
        scope.schemasNotLookedAt.includes(FIXTURE_SCHEMA),
        `${FIXTURE_SCHEMA} was not asked for and holds every table in this ` +
          `database, so a report that does not name it as unexamined is ` +
          `describing a scan of nothing as if it were a scan`,
      );
      assert.equal(scope.tablesReadable, 0);
      assert.ok(scope.tablesInDatabase > 0);
    });
  });
}
