/**
 * 🟥 Which table a column might be pointing at, judged only by its name.
 *
 * Debt N35. `parentNameGuesses` used to strip exactly ONE leading word, so
 * `owner_user_id` produced `owner_user`, `owner_users`, `owner_useres` — and
 * never `users`, the table it points at. Every qualified reference on
 * devops.stackexchange was invisible: `last_editor_user_id`,
 * `related_post_id`, `accepted_answer_id`, `excerpt_post_id`, `wiki_post_id`.
 *
 * What made it worth fixing is not the columns it missed. It is that the rule
 * could not tell it had missed them, so they were never counted as unchecked
 * either — the scope strip reported full coverage of a set these columns had
 * silently dropped out of. A gap the denominator cannot see is the one kind
 * the disclosure cannot disclose.
 *
 * ⚠️ The fix landed without a test. Measured 2026-08-28: reverting the loop to
 * a single strip — the exact defect N35 describes — left all 965 tests green.
 * So the ledger was right to keep N35 open by its own rule, which is that a
 * debt closes when it is fixed AND something turns red if it comes back.
 *
 * Tested through `findCandidates` because `parentNameGuesses` is private, and
 * it should stay private: the candidate list is what the rest of the rule
 * consumes, and pinning the helper's return shape would pin an implementation
 * detail instead of the behaviour anybody depends on.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { findCandidates } from '../src/implicit-fk.js';
import type { SchemaGraph } from '@ledar/connector-postgres';

function table(name: string) {
  return { schema: 'public', table: name, isPartition: false, partitionOf: null };
}

function column(t: string, name: string, type = 'int4') {
  return { schema: 'public', table: t, name, type, notNull: false, position: 1 };
}

function primaryKey(t: string, col: string) {
  return {
    name: `${t}_pkey`,
    kind: 'primary_key' as const,
    schema: 'public',
    table: t,
    columns: [col],
    validated: true,
    definition: `PRIMARY KEY (${col})`,
    checkExpression: null,
    referencedSchema: null,
    referencedTable: null,
    referencedColumns: [],
  };
}

/**
 * A schema with `users`, `posts`, and a `comments` table carrying whatever
 * child columns a test names.
 *
 * ⚠️ The child columns go on `comments`, not on `posts`, and that is not
 * arbitrary. `findCandidates` skips a guess that names the column's own table
 * — `if (guess === col.table) continue` — so putting `related_post_id` on
 * `posts` measures the self-reference guard rather than the naming rule.
 * Which is worth knowing on its own: on the real devops.stackexchange those
 * `*_post_id` columns DO sit on `posts`, so they stay invisible to this rule
 * for a reason N35 does not name, and fixing the strip did not reach them.
 */
function graphWith(childColumns: readonly string[], extraTables: readonly string[] = []): SchemaGraph {
  const tables = ['users', 'posts', 'comments', ...extraTables];
  return {
    schemas: ['public'],
    tables: tables.map(table),
    totalTablesInSchemas: tables.length,
    constraints: tables.map((t) => primaryKey(t, 'id')),
    indexes: [],
    columns: [
      ...tables.map((t) => column(t, 'id')),
      ...childColumns.map((c) => column('comments', c)),
    ],
    sizes: tables.map((t) => ({ schema: 'public', table: t, estimatedRows: 1000 })),
  };
}

function parentsFound(childColumns: readonly string[], extraTables: readonly string[] = []) {
  return findCandidates(graphWith(childColumns, extraTables)).map(
    (c) => `${c.childColumn} -> ${c.parentTable}`,
  );
}

describe('a column named after its parent, with a role in front', () => {
  it('🟥 finds the parent behind one leading word', () => {
    // The column N35 is named after.
    assert.deepEqual(parentsFound(['owner_user_id']), ['owner_user_id -> users']);
  });

  it('🟥 finds it behind two, which a single strip never could', () => {
    // `last_editor_user_id` on devops.stackexchange. One strip yields
    // `editor_user`; the table is `users`, two words in.
    assert.deepEqual(parentsFound(['last_editor_user_id']), ['last_editor_user_id -> users']);
  });

  it('🟥 the whole devops shape, none of which a single strip reaches', () => {
    const found = parentsFound(
      ['related_post_id', 'accepted_answer_id', 'excerpt_post_id', 'wiki_post_id'],
      ['answers'],
    );
    assert.deepEqual(found.sort(), [
      'accepted_answer_id -> answers',
      'excerpt_post_id -> posts',
      'related_post_id -> posts',
      'wiki_post_id -> posts',
    ]);
  });

  it('⚠️ but a column naming its OWN table is still skipped', () => {
    // `if (guess === col.table) continue` — deliberate, and it means N35's
    // list overstates what the fix recovered. On devops.stackexchange those
    // `*_post_id` columns sit on `posts` itself, so they remain invisible to
    // this rule whatever the strip does. Recorded here rather than left for
    // somebody to rediscover from a passing test above.
    const graph = graphWith([]);
    graph.columns.push(column('posts', 'related_post_id'));
    assert.deepEqual(findCandidates(graph).map((c) => c.childColumn), []);
  });

  it('takes the most specific table when both exist', () => {
    // Longest stem first. A schema holding both `owner_user` and `users`
    // means the specific one, and dropping to the vaguer name would be
    // choosing the weaker answer for no reason.
    assert.deepEqual(parentsFound(['owner_user_id'], ['owner_user']), [
      'owner_user_id -> owner_user',
    ]);
  });

  it('still finds a plain one-word reference', () => {
    // The case that always worked, kept so a change to the loop cannot
    // quietly trade one shape for the other.
    assert.deepEqual(parentsFound(['user_id']), ['user_id -> users']);
  });

  it('names no parent when no table by any stem exists', () => {
    // The restraint that keeps this from guessing at every column: a guess
    // pointing at nothing is not a weaker guess, it is a wrong one.
    assert.deepEqual(parentsFound(['some_unrelated_thing_id']), []);
  });
});

describe('a column that is just the parent name', () => {
  it('🟥 is read, because most of MusicBrainz is written that way', () => {
    // 390 of its 758 foreign keys — `alternative_medium.medium` → `medium`.
    // A rule that only knows `<name>_id` scores zero there, on 370 tables,
    // in a schema where the graph is the whole point. Measured
    // `field-results` ㉙.
    assert.deepEqual(parentsFound(['users']), ['users -> users']);
  });

  it('fires only when a table of exactly that name exists', () => {
    // The restraint that stops every text column becoming a candidate. No
    // pluralising, no stripping: this rung is the one most likely to catch an
    // ordinary column, so it gets the strictest test.
    assert.deepEqual(parentsFound(['title', 'status', 'user']), []);
  });
});
