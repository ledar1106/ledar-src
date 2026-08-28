/**
 * Two windows, one history file.
 *
 * This is a desktop app. Opening it twice is not an edge case, it is Tuesday
 * — and both copies write to the same `history.db`. SQLite allows exactly one
 * writer at a time, so the only question is what the second one does while it
 * waits. With SQLite's defaults the answer is "does not wait": `busy_timeout`
 * starts at 0, so the second window fails on contact with `SQLITE_BUSY`, and
 * a scan that read a database perfectly ends with no record of having run.
 *
 * The other window is a real second thread here, not a mock. A mock of a lock
 * proves the mock is consistent with itself; only a second OS thread holding
 * a genuine RESERVED lock, and letting go of it while this thread is blocked
 * inside SQLite, can show that the wait actually resolves. Every test below
 * therefore asserts on elapsed time as well as on the result: a call that
 * returned instantly did not wait for anything, which would mean the lock was
 * never held and the test proved nothing.
 */

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { Worker } from 'node:worker_threads';

import type { Finding, ScopeManifest } from '@ledar/contracts';

import { ScanStore } from '../src/store.js';
import type { DatabaseIdentity } from '../src/types.js';
import { coverageOf } from '@ledar/contracts';

const DB: DatabaseIdentity = { host: '127.0.0.1', port: 55432, database: 'pagila' };
const NO_COST = { queries: 0, totalMs: 0, rowsScanned: 0 };

/**
 * How long the other window keeps the write lock.
 *
 * Long enough that a wait is unmistakable next to the ~1 ms it takes to fail,
 * short enough that the suite does not notice.
 */
const HOLD_MS = 300;

function scope(over: Partial<ScopeManifest> = {}): ScopeManifest {
  return {
    database: 'pagila',
    role: 'ledar_reader',
    schemas: ['public'],
    visibleTables: 47,
    totalTables: 52,
    grantedAt: null,
    readOnlyEnforcedByDatabase: true,
    disclosure: null,
    ...over,
  };
}

function finding(): Finding {
  return {
    id: 'layer-a/fk-orphans/public.damaged_rental_note.rental_fkey',
    rule: 'layer-a/unvalidated-foreign-key-has-orphans',
    kind: 'observation',
    confidence: 'certain',
    severity: 'high',
    origin: 'counted',
    confidenceBasis: 'full_count',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-21T10:00:04.000Z',
    engineRuleVersion: 'layer-a@2.1.0',
    userStatus: 'unreviewed',
    schema: 'public',
    table: 'damaged_rental_note',
    columns: ['rental_id'],
    plainText: '3 rows point at a rental record that is not there.',
    technical: 'FK damaged_rental_note_rental_fkey is NOT VALID; 3 orphans.',
    // N50: every finding states the limit of the measurement behind it.
    boundary: 'Counted one constraint; validated constraints were not re-checked.',
    evidence: null,
    coverage: coverageOf(1, 1),
  } as Finding;
}

// ---- the other window ------------------------------------------------------

/**
 * A second window that simply holds the write lock for a while.
 *
 * `BEGIN IMMEDIATE` takes the RESERVED lock straight away rather than at the
 * first write, which is what makes the handshake exact: by the time the
 * message arrives the lock is already held, so there is no gap in which this
 * thread could slip a write through and pass for the wrong reason.
 *
 * It sets a busy timeout of its own because a real second window is a real
 * `ScanStore` and now has one. Without it this thread's own COMMIT can fail:
 * releasing a write lock needs every reader out of the way, and the thread
 * under test takes a brief read lock on each of its retries. Seen once under
 * a loaded machine — as `database is locked` raised inside the COMMIT here,
 * not in the code under test.
 */
const HOLDS_THE_LOCK = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA busy_timeout = 10000');
db.exec('BEGIN IMMEDIATE');
db.prepare('INSERT OR REPLACE INTO store_meta (key, value) VALUES (?, ?)')
  .run('other_window_probe', new Date().toISOString());
parentPort.postMessage('held');

setTimeout(() => {
  db.exec('COMMIT');
  db.close();
}, workerData.holdMs);
`;

/**
 * A second window that creates the schema in a file neither of them has
 * touched yet, and sits on it uncommitted.
 *
 * The statements are copied out of a history file this build wrote a moment
 * earlier rather than written out here, so this stays a race between two
 * copies of the real schema. A hand-written imitation would drift from
 * `schema.ts` and the test would go on passing while testing a shape nobody
 * ships.
 */
const CREATES_THE_SCHEMA = `
const { DatabaseSync } = require('node:sqlite');
const { parentPort, workerData } = require('node:worker_threads');

const template = new DatabaseSync(workerData.template);
const ddl = template
  .prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid')
  .all()
  .map((row) => row.sql);
const meta = template.prepare('SELECT key, value FROM store_meta').all();
template.close();

if (ddl.length === 0) throw new Error('the template history had no schema in it');

const db = new DatabaseSync(workerData.file);
db.exec('PRAGMA busy_timeout = 10000');
db.exec('BEGIN IMMEDIATE');
for (const statement of ddl) db.exec(statement);
const insert = db.prepare('INSERT INTO store_meta (key, value) VALUES (?, ?)');
for (const row of meta) insert.run(row.key, row.value);
parentPort.postMessage('held');

setTimeout(() => {
  db.exec('COMMIT');
  db.close();
}, workerData.holdMs);
`;

type OtherWindow = {
  /** Resolves once the thread has finished and let go of everything. */
  ended: Promise<unknown>;
};

/** Starts the other window and returns only once its lock is genuinely held. */
async function otherWindow(
  source: string,
  data: Record<string, unknown>,
): Promise<OtherWindow> {
  const worker = new Worker(source, {
    eval: true,
    workerData: { holdMs: HOLD_MS, ...data },
  });
  const ended = once(worker, 'exit');

  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve());
    worker.once('error', reject);
    worker.once('exit', (code) =>
      reject(new Error(`The other window exited (${code}) before taking the lock.`)),
    );
  });

  return { ended };
}

const dirs: string[] = [];

function newDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledar-store-concurrency-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A leftover temp directory is not worth failing a suite over.
    }
  }
});

/**
 * Says how long a call took, and refuses to let it pass for the wrong reason.
 *
 * Every wait here is worthless without this: if the other window never took
 * the lock, the call under test would succeed immediately and the assertion
 * on its result would still hold. Green because nothing was contended looks
 * exactly like green because contention was handled.
 */
function assertWaited(what: string, ms: number): void {
  assert.ok(
    ms >= HOLD_MS / 2,
    `${what} returned after ${ms}ms, which is too fast to have waited for a ` +
      `lock held for ${HOLD_MS}ms. The other window cannot have been holding ` +
      `it, so this test proved nothing.`,
  );
}

// ---- waiting instead of failing --------------------------------------------

test('a second window opening a run waits for the first instead of failing', async () => {
  const file = join(newDir(), 'history.db');
  const store = ScanStore.open(file);

  const other = await otherWindow(HOLDS_THE_LOCK, { file });

  const started = Date.now();
  let runId: number;
  try {
    runId = store.openRun({ database: DB, scope: scope() });
  } finally {
    await other.ended;
  }

  assertWaited('openRun', Date.now() - started);
  assert.equal(store.runById(runId)?.outcome, 'running');

  store.close();
});

test('a second window recording findings and finishing a run also waits', async () => {
  const file = join(newDir(), 'history.db');
  const store = ScanStore.open(file);
  const runId = store.openRun({ database: DB, scope: scope() });

  // `recordFindings` writes inside a transaction and `finishRun` writes
  // without one. Those are different paths through SQLite's locking, so one
  // of them waiting is no evidence about the other.
  const duringFindings = await otherWindow(HOLDS_THE_LOCK, { file });
  const findingsStarted = Date.now();
  try {
    store.recordFindings(runId, [finding()]);
  } finally {
    await duringFindings.ended;
  }
  const findingsWaited = Date.now() - findingsStarted;

  const duringFinish = await otherWindow(HOLDS_THE_LOCK, { file });
  const finishStarted = Date.now();
  try {
    store.finishRun(runId, { outcome: 'completed', cost: NO_COST });
  } finally {
    await duringFinish.ended;
  }
  const finishWaited = Date.now() - finishStarted;

  assertWaited('recordFindings', findingsWaited);
  assertWaited('finishRun', finishWaited);

  assert.equal(store.findingsOf(runId).length, 1);
  assert.equal(store.runById(runId)?.outcome, 'completed');

  store.close();
});

test('two windows creating the same new history file both end up usable', async () => {
  const template = join(newDir(), 'template.db');
  ScanStore.open(template).close();

  // Nothing has touched this path yet, which is the point: both windows will
  // look, both will see an empty file, and both will decide to create the
  // schema. The loser has to notice that the winner got there first, in the
  // gap between looking and writing.
  const file = join(newDir(), 'history.db');
  const other = await otherWindow(CREATES_THE_SCHEMA, { file, template });

  const started = Date.now();
  let store: ScanStore;
  try {
    store = ScanStore.open(file);
  } finally {
    await other.ended;
  }

  assertWaited('ScanStore.open', Date.now() - started);

  // Opening is not the claim — a usable history is. A store that "opened" a
  // half-created schema fails here instead.
  const runId = store.openRun({ database: DB, scope: scope() });
  store.recordFindings(runId, [finding()]);
  store.finishRun(runId, { outcome: 'completed', cost: NO_COST });
  assert.equal(store.runById(runId)?.findingCount, 1);

  store.close();
});

// ---- one file, still one file ----------------------------------------------

test('the history is still a single file while it is being written', () => {
  const dir = newDir();
  const file = join(dir, 'history.db');
  const store = ScanStore.open(file);
  const runId = store.openRun({ database: DB, scope: scope() });
  store.recordFindings(runId, [finding()]);

  // Checked while the connection is open and a run is in progress, which is
  // the only moment it can be checked: SQLite deletes `-wal` and `-shm` on
  // the last close, so a listing taken after `close()` looks identical in
  // either journal mode and would prove nothing.
  //
  // This is a trap wire under a decision, not a preference about file names.
  // The history is documented as one file a user attaches to a bug report. In
  // WAL mode the committed tail of that history lives in `history.db-wal`
  // until a checkpoint, so a user whose scan died mid-run and who then sends
  // `history.db` alone sends a history missing its most recent rows, with
  // nothing in the file to say so. Measured rather than assumed: a copy taken
  // of a WAL database with a live connection reported 2 rows where the
  // original reported 3.
  //
  // Turning WAL on later is allowed. Turning it on and deleting this test is
  // not: the promise has to be paid for somewhere — checkpointing on close,
  // exporting instead of copying, or telling the user to send three files.
  const beside = readdirSync(dir).sort();
  assert.deepEqual(
    beside,
    ['history.db'],
    `The history grew sidecar files: ${beside.join(', ')}. It is documented as ` +
      `one file people attach to a bug report, and whatever is not in that ` +
      `file would go missing with no sign that it had.`,
  );

  store.finishRun(runId, { outcome: 'completed', cost: NO_COST });
  store.close();

  // Read back through a connection that knows nothing about this build. A WAL
  // database records that fact in its file header and keeps it across every
  // close, so this catches a flip that happened in some earlier session too.
  const fresh = new DatabaseSync(file);
  const mode = fresh.prepare('PRAGMA journal_mode').get()?.['journal_mode'];
  fresh.close();
  assert.notEqual(
    mode,
    'wal',
    'The history file is in WAL mode, so it is no longer one file.',
  );
});
