/**
 * The filter that keeps `redactCell`'s null branch dead, held shut.
 *
 * WHY THIS FILE EXISTS
 *
 * `redactCell` in `packages/contracts/src/redaction.ts` has four branches:
 * `<number>`, `<text:N>`, `<uuid>`, and `'null'` for an empty cell. Damage 6
 * and 7 in `fixture-damage.sql` brought the first three onto real Postgres
 * rows. The fourth cannot be brought there at all, and that is the point.
 *
 * Both sample queries in this product select only the candidate columns and
 * require every one of them to be `IS NOT NULL`:
 *
 *   layer A  buildOrphanSampleQuery   (exported, asserted below)
 *   layer B  buildOrphanSample        (private; locked in the Layer B suite
 *                                      through the query the finding carries)
 *
 * So an empty cell cannot reach a sample by construction. Adding a nullable
 * column to the fixture does not cover the null branch; nothing does, while
 * that filter is there.
 *
 * The branch is worth guarding anyway, because it is the one that has
 * already caused a real divergence. There were three copies of this
 * redactor. They agreed on every case except the empty cell — Layer A
 * returned a real `null`, Layer B returned the string `'null'`, and the
 * store's guard accepted only strings — and nobody noticed for months,
 * because no query could produce the disagreement. The branch that goes
 * live first is the branch nobody tested.
 *
 * This suite is therefore not a test of redaction. It is a tripwire on the
 * precondition that lets us leave that branch untested: if someone later
 * samples whole rows, or widens the sample past the key columns, or drops
 * one column's filter while building a composite key, these assertions fail
 * on the same day — and whoever did it learns that the null branch has just
 * come alive and has to be checked end to end before it ships.
 *
 * No database is needed. This reads the SQL the pack builds.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { quoteIdent } from '@ledar/connector-postgres';
import type { Constraint } from '@ledar/connector-postgres';
import { buildOrphanSampleQuery } from '@ledar/packs-layer-a';

/** A foreign key as `readSchemaGraph` would hand one over. */
function fk(columns: string[], referencedColumns: string[]): Constraint {
  return {
    name: 'child_parent_fkey',
    kind: 'foreign_key',
    schema: 'public',
    table: 'child',
    columns,
    validated: false,
    definition: `FOREIGN KEY (${columns.join(', ')}) REFERENCES parent NOT VALID`,
    checkExpression: null,
    referencedSchema: 'public',
    referencedTable: 'parent',
    referencedColumns,
  };
}

/**
 * The columns the query hands back, read out of its own SELECT list.
 *
 * Parsed from the generated SQL rather than taken from the constraint,
 * because the claim under test is about what the query selects. Taking the
 * list from the input would assert that the columns we passed in are
 * filtered, which stays true no matter how much else the SELECT grows.
 */
function selectedColumns(sql: string): string[] {
  const match = /SELECT\s+([\s\S]*?)\s+FROM\s/i.exec(sql);
  const list = match === null ? undefined : match[1];
  assert.ok(
    list !== undefined && list.length > 0,
    `no SELECT list could be read out of the sample query, so nothing below ` +
      `is measuring what it claims to. Query was:\n${sql}`,
  );
  return list
    .split(',')
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

describe("Layer A's orphan sample cannot return an empty cell", () => {
  /**
   * The single-column case, which is every foreign key in the fixture.
   */
  it('filters the one column it selects', () => {
    const sql = buildOrphanSampleQuery(fk(['rental_id'], ['rental_id']));

    assert.deepEqual(selectedColumns(sql), [`c.${quoteIdent('rental_id')}`]);
    assert.ok(
      sql.includes(`c.${quoteIdent('rental_id')} IS NOT NULL`),
      `the sample query selects rental_id without requiring it to be ` +
        `non-empty. An empty cell can now be sampled, which puts ` +
        `redactCell's null branch on the live path for the first time. ` +
        `Query was:\n${sql}`,
    );
  });

  /**
   * The composite case, which is where this is most likely to be lost.
   *
   * A composite key is the shape where "just filter the column" stops being
   * one statement, and it is the shape a refactor is most likely to get
   * half right — filtering the first column and joining on the rest. Half
   * right is enough to let an empty cell through.
   */
  it('filters every column of a composite key, not just the first', () => {
    const columns = ['tenant_id', 'order_ref', 'line_no'];
    const sql = buildOrphanSampleQuery(fk(columns, ['tenant_id', 'ref', 'no']));

    const selected = selectedColumns(sql);
    assert.equal(
      selected.length,
      columns.length,
      `the query selects ${selected.length} expressions for a ${columns.length}-` +
        `column key: ${selected.join(' | ')}. The loop below would then be ` +
        `checking a different set of columns than the one being returned.`,
    );

    for (const column of selected) {
      assert.ok(
        sql.includes(`${column} IS NOT NULL`),
        `${column} is returned by the sample query but is not required to be ` +
          `non-empty. One unfiltered column of a composite key is enough: ` +
          `that row reaches redactCell with an empty cell, and the 'null' ` +
          `branch — the one place three copies of this redactor disagreed — ` +
          `goes live with nothing watching it. Query was:\n${sql}`,
      );
    }
  });

  /**
   * The guard against this whole file passing for the wrong reason.
   *
   * Every assertion above is satisfied by a query that returns no columns
   * at all, or by `selectedColumns` quietly returning an empty list after
   * the SQL is reshaped. Both would read as green.
   */
  it('is asserting about a query that actually selects something', () => {
    for (const columns of [['a_id'], ['a_id', 'b_id']]) {
      const selected = selectedColumns(buildOrphanSampleQuery(fk(columns, columns)));
      assert.ok(
        selected.length > 0,
        `the sample query for (${columns.join(', ')}) selects nothing, so the ` +
          `loops above ran over an empty list and proved nothing.`,
      );
    }
  });
});
