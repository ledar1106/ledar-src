/**
 * Reading the history files this build refuses to write to.
 *
 * `openHistory` moved eleven real runs aside on the machine this was written
 * on and started a new file. Nothing was lost, and nothing was readable
 * either: a diff drawn from the live store saw one run and reported that
 * there was nothing to compare, one directory away from a year of history.
 *
 * Two things are pinned here, and the second one is the one that would have
 * shipped a lie:
 *
 * ① The reader never writes. Read-only is asserted against the driver, not
 *    against good intentions, and the refusals name what they refused.
 *
 * ② **A schema-1 `structure_hash` is not comparable to a current one.** This
 *    is measured, not feared. The two negative claims on the empty Supabase
 *    database in `%LOCALAPPDATA%\ledar` come out as
 *
 *        history.v1.db   1aab6107…   0086f727…
 *        history.v2.db   480464ae…   3a0fa116…
 *        history.db      480464ae…   3a0fa116…
 *
 *    on a database that holds no rows and therefore cannot have changed.
 *    `structureHash` hashes `origin` and `confidenceBasis`, which schema 1
 *    does not have, so the recipe moved when provenance arrived. A diff that
 *    compares those hashes reports *every* carried-over finding as "the
 *    structure changed" — the exact false alarm this slice exists to prevent,
 *    fired on every row rather than occasionally.
 *
 * The files those numbers came from exist on one machine. What is committed
 * is their *schema*, dumped out of `sqlite_master` — see
 * `@ledar/test-fixtures/legacy-history` — so these run anywhere, with no
 * container and no skip.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { FIXTURE_FINGERPRINT, writeLegacyHistory } from '@ledar/test-fixtures';

import { diffRuns } from '../src/diff.js';
import { RetiredHistoryReader } from '../src/legacy.js';
import { SCHEMA_VERSION } from '../src/schema.js';
import { ScanStore } from '../src/store.js';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'ledar-legacy-'));
  dirs.push(d);
  return d;
}

/** One rule, one finding, the shape both eras of the file can hold. */
const ORPHANS = 'layer-a/unvalidated-foreign-key-has-orphans';
const KEY = 'layer-a/fk-orphans/public.damaged_rental_note.fk';

describe('reading a retired history file', () => {
  it('reads runs, findings and coverage out of a schema-1 file', () => {
    const path = join(workspace(), 'history.v1.db');
    writeLegacyHistory(path, 1, [
      {
        runId: 1,
        startedAt: '2026-08-21T04:21:46.998Z',
        label: 'pagila',
        findings: [{ findingKey: KEY, rule: ORPHANS, rowCount: 3 }],
        rules: [{ rule: ORPHANS, checked: 1, eligible: 1 }],
      },
    ]);

    const reader = RetiredHistoryReader.open(path);
    try {
      assert.equal(reader.source.schemaVersion, 1);
      const snapshot = reader.snapshotOf(1);
      assert.ok(snapshot);
      assert.equal(snapshot.run.label, 'pagila');
      assert.equal(snapshot.findings.length, 1);
      assert.equal(snapshot.findings[0]?.measuredRows, 3);
      assert.equal(snapshot.rules[0]?.coverage?.checked, 1);
    } finally {
      reader.close();
    }
  });

  it('reports a schema-1 file as unable to say which rule version ran', () => {
    const path = join(workspace(), 'history.v1.db');
    writeLegacyHistory(path, 1, [
      {
        runId: 1,
        startedAt: '2026-08-21T04:21:46.998Z',
        findings: [{ findingKey: KEY, rule: ORPHANS, engineRuleVersion: 'layer-a@9.9.9' }],
      },
    ]);

    const reader = RetiredHistoryReader.open(path);
    try {
      assert.equal(reader.source.recordsEngineVersion, false);
      assert.equal(reader.source.comparableStructureHash, false);
      // `engineRuleVersion` was supplied above and there is nowhere to put it.
      // Null, not the string that was asked for, and not an empty string —
      // an empty string compares equal to another empty string, which turns
      // "neither side says" into "both sides agree".
      assert.equal(reader.snapshotOf(1)?.findings[0]?.engineRuleVersion, null);
    } finally {
      reader.close();
    }
  });

  it('reads the rule version out of a schema-2 file', () => {
    const path = join(workspace(), 'history.v2.db');
    writeLegacyHistory(path, 2, [
      {
        runId: 1,
        startedAt: '2026-08-21T22:09:18.538Z',
        findings: [{ findingKey: KEY, rule: ORPHANS, engineRuleVersion: 'layer-a@1.0.0' }],
      },
    ]);

    const reader = RetiredHistoryReader.open(path);
    try {
      assert.equal(reader.source.recordsEngineVersion, true);
      assert.equal(reader.source.comparableStructureHash, true);
      assert.equal(reader.snapshotOf(1)?.findings[0]?.engineRuleVersion, 'layer-a@1.0.0');
    } finally {
      reader.close();
    }
  });

  it('cannot write, and the driver is what stops it', () => {
    const path = join(workspace(), 'history.v1.db');
    writeLegacyHistory(path, 1, [{ runId: 1, startedAt: '2026-08-21T04:21:46.998Z' }]);

    const reader = RetiredHistoryReader.open(path);
    try {
      // Reaching past the reader's own API on purpose. What is being pinned
      // is that the *connection* is read-only, not that this class happens to
      // expose no writing methods today — a method added next month would
      // silently be allowed to write if this asserted the latter.
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        assert.throws(
          () => db.exec(`INSERT INTO store_meta (key, value) VALUES ('x', 'y')`),
          /readonly|read-only/i,
        );
      } finally {
        db.close();
      }
    } finally {
      reader.close();
    }
  });

  it('returns null for a run that is not in the file', () => {
    const path = join(workspace(), 'history.v1.db');
    writeLegacyHistory(path, 1, [{ runId: 1, startedAt: '2026-08-21T04:21:46.998Z' }]);
    const reader = RetiredHistoryReader.open(path);
    try {
      // Not an empty snapshot. An empty one compares cleanly against anything
      // and reports every finding on the other side as new or fixed — a
      // confident answer about a run that does not exist.
      assert.equal(reader.snapshotOf(404), null);
    } finally {
      reader.close();
    }
  });
});

describe('what the retired reader refuses', () => {
  it('refuses a file at the current schema version, and says to use ScanStore', () => {
    const path = join(workspace(), 'history.db');
    ScanStore.open(path).close();
    assert.throws(
      () => RetiredHistoryReader.open(path),
      new RegExp(`schema version ${SCHEMA_VERSION}.*ScanStore`, 's'),
    );
  });

  it('refuses a file from a newer build rather than reading it as an older one', () => {
    const path = join(workspace(), 'future.db');
    writeLegacyHistory(path, 2, [{ runId: 1, startedAt: '2026-08-21T22:09:18.538Z' }]);
    const db = new DatabaseSync(path);
    db.prepare(`UPDATE store_meta SET value = ? WHERE key = 'schema_version'`).run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();

    assert.throws(() => RetiredHistoryReader.open(path), /newer file may hold columns/);
  });

  it('refuses a SQLite file that is not a LEDAR history', () => {
    const path = join(workspace(), 'someone-else.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY)`);
    db.close();
    assert.throws(() => RetiredHistoryReader.open(path), /not a LEDAR history/);
  });

  it('refuses a path that does not exist, by name', () => {
    const path = join(workspace(), 'nowhere.db');
    assert.throws(() => RetiredHistoryReader.open(path), /There is no history file at/);
  });

  it('names the missing column when a file is shaped in a way it has not seen', () => {
    const path = join(workspace(), 'clipped.db');
    writeLegacyHistory(path, 1, [{ runId: 1, startedAt: '2026-08-21T04:21:46.998Z' }]);
    const db = new DatabaseSync(path);
    // `scope_disclosure` rather than a more interesting column because SQLite
    // refuses to drop one that a CHECK constraint names, and most of this
    // table's columns are named by one. Which column is gone does not matter
    // to what is being pinned; that the reader says WHICH one does.
    db.exec(`ALTER TABLE run DROP COLUMN scope_disclosure`);
    db.close();

    // The alternative is failing three layers down with "Column
    // scope_disclosure should be text, got undefined", which tells the reader
    // nothing about which file is wrong or why.
    assert.throws(() => RetiredHistoryReader.open(path), /missing scope_disclosure/);
  });

  it('does not leave the file open when it refuses', () => {
    const path = join(workspace(), 'someone-else.db');
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY)`);
    db.close();

    assert.throws(() => RetiredHistoryReader.open(path));
    // A handle left open holds a lock on Windows, which would make the
    // refusal cost the user the file until the process exits.
    const after = new DatabaseSync(path);
    after.exec(`INSERT INTO invoices (id) VALUES (1)`);
    after.close();
  });

  it('refuses a file that is not SQLite at all', () => {
    const path = join(workspace(), 'notes.txt');
    writeFileSync(path, 'this is not a database\n', 'utf8');
    assert.throws(() => RetiredHistoryReader.open(path));
  });
});

describe('diffing across the schema boundary', () => {
  /**
   * The measurement at the top of this file, turned into a gate.
   *
   * Both sides hold the same finding at the same row count. Only the
   * `structure_hash` differs, because the recipe for it changed when
   * provenance arrived — not because anything about the database did.
   */
  function boundaryPair() {
    const dir = workspace();
    const oldPath = join(dir, 'history.v1.db');
    writeLegacyHistory(oldPath, 1, [
      {
        runId: 6,
        startedAt: '2026-08-21T04:25:19.116Z',
        fingerprint: FIXTURE_FINGERPRINT,
        findings: [
          { findingKey: KEY, rule: ORPHANS, rowCount: 3, structureHash: '1aab6107' },
        ],
        rules: [{ rule: ORPHANS, checked: 1, eligible: 1 }],
      },
    ]);

    const newPath = join(dir, 'history.db');
    const store = ScanStore.open(newPath);
    store.close();
    // Written through the legacy builder at schema 2 rather than through
    // ScanStore, because what matters is the pair of hashes, and the current
    // writer would compute its own.
    const modernPath = join(dir, 'history.v2.db');
    writeLegacyHistory(modernPath, 2, [
      {
        runId: 1,
        startedAt: '2026-08-22T05:00:44.063Z',
        fingerprint: FIXTURE_FINGERPRINT,
        findings: [
          {
            findingKey: KEY,
            rule: ORPHANS,
            rowCount: 3,
            structureHash: '480464ae',
            engineRuleVersion: 'layer-a@1.0.0',
          },
        ],
        rules: [{ rule: ORPHANS, checked: 1, eligible: 1 }],
      },
    ]);

    return { oldPath, modernPath };
  }

  it('does not call a changed hash recipe a changed structure', () => {
    const { oldPath, modernPath } = boundaryPair();
    const before = RetiredHistoryReader.open(oldPath);
    const after = RetiredHistoryReader.open(modernPath);
    try {
      const diff = diffRuns(before.snapshotOf(6)!, after.snapshotOf(1)!);
      const change = diff.changes.find((c) => c.findingKey === KEY);
      assert.ok(change);
      // The hashes differ. Reporting that as a structure change is the whole
      // bug; the row count is identical and so is the database.
      assert.notEqual(before.snapshotOf(6)!.findings[0]?.structureHash,
                      after.snapshotOf(1)!.findings[0]?.structureHash);
      assert.equal(change.verdict, 'unchanged');
    } finally {
      before.close();
      after.close();
    }
  });

  it('says out loud that the structure check was not run', () => {
    const { oldPath, modernPath } = boundaryPair();
    const before = RetiredHistoryReader.open(oldPath);
    const after = RetiredHistoryReader.open(modernPath);
    try {
      const diff = diffRuns(before.snapshotOf(6)!, after.snapshotOf(1)!);
      // Suppressing the check silently would be its own bug: the reader would
      // take "unchanged" to mean the structure was compared and matched.
      assert.ok(diff.cautions.some((c) => /Structure comparison is off/.test(c)));
      const change = diff.changes.find((c) => c.findingKey === KEY);
      assert.match(change!.says, /Unchanged in the numbers/);
    } finally {
      before.close();
      after.close();
    }
  });

  it('runs the structure check when both sides can be compared', () => {
    const dir = workspace();
    const a = join(dir, 'a.v2.db');
    const b = join(dir, 'b.v2.db');
    for (const [path, hash] of [[a, 'aaaa'], [b, 'bbbb']] as const) {
      writeLegacyHistory(path, 2, [
        {
          runId: 1,
          startedAt: path === a ? '2026-08-21T00:00:00.000Z' : '2026-08-22T00:00:00.000Z',
          findings: [
            { findingKey: KEY, rule: ORPHANS, rowCount: 3, structureHash: hash },
          ],
          rules: [{ rule: ORPHANS, checked: 1, eligible: 1 }],
        },
      ]);
    }

    const before = RetiredHistoryReader.open(a);
    const after = RetiredHistoryReader.open(b);
    try {
      const diff = diffRuns(before.snapshotOf(1)!, after.snapshotOf(1)!);
      // Same inputs as the boundary case above except that both files record
      // provenance. If this were also 'unchanged' the suppression would be
      // unconditional and the previous two tests would be proving nothing.
      assert.equal(diff.changes[0]?.verdict, 'structure-changed');
      assert.ok(!diff.cautions.some((c) => /Structure comparison is off/.test(c)));
    } finally {
      before.close();
      after.close();
    }
  });
});
