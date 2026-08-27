/**
 * The SQL this package writes for people to run by hand.
 *
 * Nothing here needs a database: these are string builders, and what has to
 * hold is the shape of the strings — identifiers quoted, hostile names
 * refused, and the repair script narrower than the exit script. The repair
 * path exists so "your role can still write" arrives with the SQL that fixes
 * it; the one thing it must never do is widen into the exit path and take
 * reading away from a role the person meant to keep.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildReadOnlyRoleSql, buildRevokeWriteSql } from '../src/role-sql.js';

describe('buildRevokeWriteSql', () => {
  it('revokes writes in every schema it was given, and only writes', () => {
    const sql = buildRevokeWriteSql('ledar_reader', ['public', 'sales']);

    for (const schema of ['"public"', '"sales"']) {
      assert.ok(
        sql.includes(`ON ALL TABLES IN SCHEMA ${schema} FROM "ledar_reader";`),
        `no revoke for schema ${schema}`,
      );
    }

    // Narrower than the exit script on purpose: reading stays.
    assert.ok(sql.includes('REVOKE INSERT, UPDATE, DELETE, TRUNCATE'));
    assert.ok(!sql.includes('REVOKE ALL'), 'repair must not widen into revoke-all');
    assert.ok(!/\bSELECT\b/.test(sql), 'repair must not touch SELECT');
    assert.ok(!sql.includes('DROP ROLE'), 'repair must not remove the role');
  });

  it('covers privileges future tables would arrive with, not only current ones', () => {
    const sql = buildRevokeWriteSql('ledar_reader', ['public']);
    assert.ok(
      sql.includes('ALTER DEFAULT PRIVILEGES IN SCHEMA "public"'),
      'default privileges left in place would re-open the hole on the next table',
    );
  });

  it('refuses a role name that is not a plain identifier', () => {
    assert.throws(
      () => buildRevokeWriteSql('reader"; DROP TABLE users; --', ['public']),
      /not a plain identifier/,
    );
  });

  it('refuses a schema name that is not a plain identifier', () => {
    assert.throws(
      () => buildRevokeWriteSql('ledar_reader', ['pub"lic']),
      /not a plain identifier/,
    );
  });
});

describe('buildReadOnlyRoleSql', () => {
  it('still refuses hostile identifiers after the repair builder joined this file', () => {
    assert.throws(
      () =>
        buildReadOnlyRoleSql({
          roleName: 'r"; --',
          database: 'db',
          schemas: ['public'],
        }),
      /not a plain identifier/,
    );
  });
});
