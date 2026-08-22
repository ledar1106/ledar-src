/**
 * The default history path was dead, and these are the tests that say so.
 *
 * Not a hypothetical: `%LOCALAPPDATA%\ledar\history.db` on the machine that
 * bumped `SCHEMA_VERSION` to 2 held `schema_version = 1` and eleven real runs,
 * and every scan through the default path had stopped being recorded. The
 * argument for the bump — "no history file exists outside this repository's
 * tests" — was false at the moment it was written.
 *
 * What is pinned here is the shape of the answer, not just that an answer
 * happens: the old file must still EXIST, byte for byte, under a name that
 * cannot collide; the new file must be usable immediately; and the report
 * must be able to say what moved and how much was in it. A version of this
 * that deleted the old file would pass a test that only checked "the scan
 * records again".
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';

import { SCHEMA_VERSION } from '../src/schema.js';
import { openHistory, retiredName } from '../src/retire.js';
import { ScanStore } from '../src/store.js';
import type { DatabaseIdentity } from '../src/types.js';

const dirs: string[] = [];

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), 'ledar-retire-'));
  dirs.push(d);
  return d;
}

const DB: DatabaseIdentity = { host: '127.0.0.1', port: 55432, database: 'pagila' };

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

/**
 * A history file from before this build, built the way the gate reads it.
 *
 * Version 1's full DDL is gone from the source and is not reconstructed here,
 * because the gate does not read the DDL — it reads one row of `store_meta`.
 * A faithful replica of the old tables would test a schema nobody runs any
 * more; this tests the thing that actually decides. `run` is created so the
 * count in the report has something true to count, and it carries the marker
 * that proves the file was preserved rather than recreated.
 */
function writeOldHistory(path: string, version: number, runs: number): void {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
  db.prepare(`INSERT INTO store_meta (key, value) VALUES (?, ?)`).run(
    'schema_version',
    String(version),
  );
  db.exec(`CREATE TABLE run (id INTEGER PRIMARY KEY, marker TEXT NOT NULL) STRICT`);
  const insert = db.prepare(`INSERT INTO run (id, marker) VALUES (?, ?)`);
  for (let i = 1; i <= runs; i += 1) insert.run(i, `run-${i}-from-version-${version}`);
  db.close();
}

describe('a history file this build cannot speak to', () => {
  it('is moved aside, and the scan gets a working history immediately', () => {
    const dir = workspace();
    const file = join(dir, 'history.db');
    writeOldHistory(file, 1, 11);

    const { store, retired } = openHistory(file);

    assert.notEqual(retired, null, 'the move has to be reported, not just done');
    assert.equal(retired!.from, file);
    assert.equal(retired!.version, 1);
    assert.equal(retired!.runs, 11, 'the report says how much was set aside');

    // The point of the whole exercise: a run can be recorded again.
    const runId = store.openRun({ database: DB, scope: SCOPE, storeSamples: false });
    assert.equal(typeof runId, 'number');
    store.close();
  });

  it('does not delete the old file — it is still there, byte for byte', () => {
    const dir = workspace();
    const file = join(dir, 'history.db');
    writeOldHistory(file, 1, 4);
    const before = readFileSync(file);

    const { store, retired } = openHistory(file);
    store.close();

    assert.ok(existsSync(retired!.to), 'the retired file must still exist');
    assert.deepEqual(
      readFileSync(retired!.to),
      before,
      'retiring is a rename, not a rewrite — one changed byte and the ' +
        'history it was meant to preserve is a history nobody can trust',
    );
  });

  it('the retired file still answers for the runs it held', () => {
    const dir = workspace();
    const file = join(dir, 'history.db');
    writeOldHistory(file, 1, 11);

    const { store, retired } = openHistory(file);
    store.close();

    const old = new DatabaseSync(retired!.to, { readOnly: true });
    const row = old.prepare(`SELECT count(*) AS n FROM run`).get();
    const first = old.prepare(`SELECT marker FROM run WHERE id = 1`).get();
    old.close();

    assert.equal(Number(row!['n']), 11);
    assert.equal(String(first!['marker']), 'run-1-from-version-1');
  });

  it('the new file is a real version-2 store, not a copy of the old one', () => {
    const dir = workspace();
    const file = join(dir, 'history.db');
    writeOldHistory(file, 1, 3);

    const { store } = openHistory(file);
    store.close();

    const fresh = new DatabaseSync(file, { readOnly: true });
    const version = fresh.prepare(
      `SELECT value FROM store_meta WHERE key = 'schema_version'`,
    ).get();
    const runs = fresh.prepare(`SELECT count(*) AS n FROM run`).get();
    fresh.close();

    assert.equal(Number(version!['value']), SCHEMA_VERSION);
    assert.equal(
      Number(runs!['n']),
      0,
      'the new history starts empty. Carrying the old rows over would mean ' +
        'inventing the six provenance columns they never had',
    );
  });

  it('a second retirement does not overwrite the first', () => {
    const dir = workspace();
    const file = join(dir, 'history.db');

    writeOldHistory(file, 1, 2);
    const first = openHistory(file);
    first.store.close();

    // Somebody restores a backup over the top, or a second old file appears.
    rmSync(file);
    writeOldHistory(file, 1, 7);
    const second = openHistory(file);
    second.store.close();

    assert.notEqual(first.retired!.to, second.retired!.to);
    assert.ok(existsSync(first.retired!.to), 'the first retired file survives');
    assert.ok(existsSync(second.retired!.to));

    const a = new DatabaseSync(first.retired!.to, { readOnly: true });
    const b = new DatabaseSync(second.retired!.to, { readOnly: true });
    const an = Number(a.prepare(`SELECT count(*) AS n FROM run`).get()!['n']);
    const bn = Number(b.prepare(`SELECT count(*) AS n FROM run`).get()!['n']);
    a.close();
    b.close();

    assert.equal(an, 2, 'the first file still holds its own two runs');
    assert.equal(bn, 7);
  });
});

describe('files this build should not touch', () => {
  it('an ordinary version-2 history is opened in place, untouched', () => {
    const dir = workspace();
    const file = join(dir, 'history.db');

    const first = ScanStore.open(file);
    const runId = first.openRun({ database: DB, scope: SCOPE, storeSamples: false });
    first.finishRun(runId, {
      outcome: 'completed',
      cost: { queries: 1, totalMs: 1, rowsScanned: 1 },
      truncationNote: null,
    });
    first.close();

    const { store, retired } = openHistory(file);
    assert.equal(retired, null, 'nothing to retire, so nothing may move');
    assert.deepEqual(
      store.runsFor(DB).map((r) => r.runId),
      [runId],
      'the run recorded a moment ago has to still be there',
    );
    store.close();

    const siblings = existsSync(join(dir, 'history.v2.db'));
    assert.equal(siblings, false, 'a healthy file must not sprout a retired twin');
  });

  it('a path with no file yet is just created, with nothing reported', () => {
    const dir = workspace();
    const { store, retired } = openHistory(join(dir, 'history.db'));
    assert.equal(retired, null);
    store.close();
  });

  it('a file that is not SQLite at all is left alone and left to fail', () => {
    const dir = workspace();
    const file = join(dir, 'history.db');
    writeFileSync(file, 'this is not a database, it is a note to self\n');

    // Whatever happens, the one unacceptable outcome is this file moving or
    // changing: it is not ours, and we did not read anything in it that said
    // we could take it.
    try {
      const { store, retired } = openHistory(file);
      assert.equal(retired, null);
      store.close();
    } catch {
      // Refusing is fine. Silently adopting the file would not be.
    }

    assert.equal(
      readFileSync(file, 'utf8'),
      'this is not a database, it is a note to self\n',
    );
    assert.equal(existsSync(join(dir, 'history.v1.db')), false);
  });

  it("somebody else's SQLite database is refused, not moved into", () => {
    // Debt N37. readSchemaVersion answers null for a new file AND for a
    // stranger's database, and applySchema used to treat both as "create".
    // One mistyped LEDAR_HISTORY_DB and four LEDAR tables grow inside a file
    // that is not ours, unasked and unannounced.
    const dir = workspace();
    const file = join(dir, 'someone-elses.db');

    const theirs = new DatabaseSync(file);
    theirs.exec(`CREATE TABLE invoices (id INTEGER PRIMARY KEY, total INTEGER)`);
    theirs.prepare(`INSERT INTO invoices (id, total) VALUES (?, ?)`).run(1, 500);
    theirs.close();

    assert.throws(
      () => openHistory(file).store.close(),
      /not a LEDAR history|somebody else/i,
      'a SQLite file with tables in it and no store_meta was adopted rather ' +
        'than refused',
    );

    // And it is untouched. The refusal is worth nothing if the tables landed
    // before it fired.
    const after = new DatabaseSync(file, { readOnly: true });
    const tables = after
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
      )
      .all()
      .map((r) => String(r['name']));
    const total = after.prepare(`SELECT total FROM invoices WHERE id = 1`).get();
    after.close();

    assert.deepEqual(
      tables,
      ['invoices'],
      `LEDAR tables were created inside a database that is not ours: ` +
        `${tables.join(', ')}`,
    );
    assert.equal(Number(total!['total']), 500, 'their row was disturbed');
  });

  it(':memory: never goes near the filesystem', () => {
    const { store, retired } = openHistory(':memory:');
    assert.equal(retired, null);
    store.close();
  });
});

describe('the name a retired file takes', () => {
  it('keeps the extension where a reader expects it', () => {
    assert.equal(retiredName('/x/history.db', 1, () => false), '/x/history.v1.db');
  });

  it('counts up rather than overwriting', () => {
    const taken = new Set(['/x/history.v1.db', '/x/history.v1.2.db']);
    assert.equal(
      retiredName('/x/history.db', 1, (p) => taken.has(String(p))),
      '/x/history.v1.3.db',
    );
  });

  it('carries the version it found, not the version this build speaks', () => {
    assert.equal(retiredName('/x/history.db', 7, () => false), '/x/history.v7.db');
  });

  it('handles a path with no extension without eating a directory name', () => {
    assert.equal(retiredName('/x.y/history', 1, () => false), '/x.y/history.v1');
  });
});
