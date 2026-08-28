/**
 * The one door, and what holds it shut.
 *
 * `export-evidence.ts` is the only command in this product that turns a scan
 * into a file somebody can send. Rule 6 of AGENTS.md section 3 — no byte of
 * real data leaves the machine outside a redacted Evidence Pack — is enforced
 * in two different places, and only one of them had a test:
 *
 *   `buildEvidencePack` in @ledar/contracts decides WHAT may leave. It has
 *   its own suite.
 *
 *   This file decides WHERE it lands, and it had none. Three refusals lived
 *   here checked by hand only:
 *
 *     (1) never write inside a git repository — walks up looking for `.git`
 *     (2) never overwrite an existing file — `wx`, not check-then-write
 *     (3) never export a run number that is not in the history
 *
 * A barrier nobody watches is a barrier that goes away without anybody
 * noticing, which is lesson 12 in HANDOFF-STATUS section 4: a gate nothing
 * calls is not a gate. So each refusal gets a test that fails if it stops
 * happening, and each test asserts two things — that the command refused,
 * *and* that nothing was written. Exit code alone would stay green for a
 * command that wrote the file and then complained.
 *
 * The redaction test is the one that matters most, and it is the reason the
 * other three are worth having: it plants a password, a DSN, a hostname and
 * every prose sentence a scan produces into the history file, exports it, and
 * reads the resulting bytes back looking for them. `buildEvidencePack` is
 * what stops them; this proves the command actually goes through it, on the
 * real path, with a real file at the end.
 *
 * Six holes stayed open behind all that, written down as N10, N11, N12, N13,
 * N18 and N19 in the debt ledger of HANDOFF-STATUS section 1c. They are closed
 * here:
 *
 *   N10  every test in this file passed `--out`. The branch a real person
 *        takes — no `--out`, read the path off the screen — was watched by
 *        nothing, so renaming the default file or letting it fall into the
 *        working directory went red nowhere. Suite (8).
 *
 *   N11  `.git` is a FILE in a linked worktree and in a submodule, not a
 *        directory. `existsSync` catches both — and nothing said so, so a
 *        `statSync(...).isDirectory()` "tightening" would have kept the
 *        suite green while taking refusal (1) off every worktree checkout.
 *
 *   N12  `--force` is the sanctioned way around refusal (2), and had no test
 *        at all: not that it works, and — the classic bug in any
 *        skip-the-check flag — not that it stops at the check it is for.
 *
 *   N13  every history above is built by hand. One is now built by a scan.
 *
 *   N18  a run against Pagila has no negative claim and no read-only
 *        disclosure, so the two places where the pack carries the FACT of a
 *        sentence while dropping the sentence were exercised by nothing.
 *
 *   N19  N12 proved `--force` stops at one barrier. Refusal (3) is the other
 *        one it must not open, and it fails in a different currency: a pack
 *        for a run nobody recorded describes a scan that never happened.
 *
 * ## Almost nothing here needs a database
 *
 * All but the last suite run against a `ScanStore` history built in this
 * file, which is the same file `scan.ts` writes and `export-evidence.ts`
 * reads — so the export runs against exactly the shape it meets in
 * production, without Docker, without Postgres, and without the fixture being
 * up. Those tests run everywhere and are never skipped: a skipped guard-rail
 * test is the same as no test at all.
 *
 * The last suite is the exception, and has to be. Its whole subject is
 * whether the shape `scan.ts` writes and the shape this command reads are
 * still the same shape — which no hand-built history can be asked, because a
 * hand-built history is written by this file and would agree with itself
 * forever (principle 12: a gate nothing calls is not a gate). So it runs a
 * real scan against the Pagila fixture and exports the run that scan printed.
 * Without the container it SKIPS, loudly, naming the reason. Never a quiet
 * pass.
 *
 * ## Exit codes are part of the contract
 *
 * `export-evidence.ts` ends with `process.exit(err instanceof Refused ? 1 : 2)`.
 * 1 means "refused, and here is what to do about it"; 2 means it crashed.
 * These tests assert 1 exactly. Accepting any non-zero code would let a
 * removed refusal pass as a TypeError — the command would still fail, but it
 * would fail without telling the user anything, and the barrier would be gone
 * with the suite still green.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import type { ClaimKind, Finding, ScopeManifest } from '@ledar/contracts';
import { ScanStore, type DatabaseIdentity } from '@ledar/store';

// The command under test, imported rather than spawned — the only two things
// in it that can be asked a question instead of watched. Importing it runs
// nothing: `export-evidence.ts` starts itself only when it is the entry point,
// which is what makes this line safe and is checked by every spawn below.
import { dataDir, defaultOutputFile } from '../src/export-evidence.js';

import {
  PAGILA_DSN,
  announceSkip,
  openPagila,
  redactDsn,
} from '@ledar/test-fixtures';
import { coverageOf } from '@ledar/contracts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Generous: it starts an npm script and a tsx compile, and does no I/O. */
const EXPORT_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// what must never come out the other end
// ---------------------------------------------------------------------------

/**
 * The credential half. None of these three is in an Evidence Pack's schema,
 * so none of them can travel — but they are all in the history file this
 * command reads, and a hostname is exactly the sort of thing that gets
 * appended to a message "for context" by a future edit.
 */
const SECRET_PASSWORD = 'hunter2-not-a-real-password';
const SECRET_HOST = 'db-prod-01.internal.example-corp.invalid';
// Assembled rather than written as one template, for the reason given on
// PAGILA_DSN in @ledar/test-fixtures: the gate that would block this file
// cannot tell an invented DSN from a live one, and should not have to.
const SECRET_DSN = ['postgres://ledar_reader', ':', SECRET_PASSWORD, '@', SECRET_HOST, ':5432/paydb'].join('');

/** A row value, the thing rule 6 is actually about. */
const CUSTOMER_VALUE = 'ana@example.com';

/**
 * A short marker inside every sentence below.
 *
 * The full sentences are asserted absent too, but a full sentence only
 * catches a leak that copied the whole thing. These catch half of one: a
 * truncated `plainText`, a sentence spliced into a message, a field carried
 * across in pieces. They are meaningless strings on purpose — nothing else in
 * this codebase or in a pack can produce them by coincidence.
 */
const CANARY = {
  plainText: 'CANARY-PLAINTEXT-q7wz',
  technical: 'CANARY-TECHNICAL-m4vk',
  boundary: 'CANARY-BOUNDARY-x2np',
  sql: 'CANARY-SQL-b8fr',
  skipReason: 'CANARY-SKIPREASON-t5jd',
  disclosure: 'CANARY-DISCLOSURE-h9cs',
} as const;

/**
 * The prose a scan produces, all of it, planted in the history.
 *
 * Every one of these fields is written by rule code, and rule code
 * interpolates whatever it had to hand — including Postgres error messages,
 * which quote values back. That is why a pack carries none of it, and why
 * this test carries all of it in.
 */
const PROSE = {
  plainText:
    `9 rows in customer_ledger point at a customer that is not there, ` +
    `including the account for ${CUSTOMER_VALUE}. ${CANARY.plainText}`,
  technical:
    `FK customer_ledger_customer_fkey is NOT VALID; 9 orphans, measured as ` +
    `ledar_reader on ${SECRET_HOST}. ${CANARY.technical}`,
  boundary:
    `Nothing was found in audit_trail, and only rows written after ` +
    `2026-01-01 were looked at, over ${SECRET_DSN}. ${CANARY.boundary}`,
  observationSql:
    `SELECT count(*) FROM public.customer_ledger l LEFT JOIN public.customer ` +
    `c ON c.id = l.customer_id WHERE c.id IS NULL -- ${CANARY.sql}`,
  negativeSql:
    `SELECT count(*) FROM public.audit_trail WHERE written_at > ` +
    `'2026-01-01' -- ${CANARY.sql}`,
  skipReason:
    `permission denied: Key (email)=(${CUSTOMER_VALUE}) already exists. ` +
    `${CANARY.skipReason}`,
  disclosure:
    `The read-only promise here is made by LEDAR, not by ${SECRET_HOST}: ` +
    `the role still holds INSERT. ${CANARY.disclosure}`,
} as const;

/**
 * Identifiers that MUST be in the pack.
 *
 * The first third of this test, and the part that is easy to leave out. A
 * pack containing nothing at all passes every "does not contain a password"
 * assertion perfectly. These names prove both findings actually travelled, so
 * that the missing prose means the prose was stripped — not that the findings
 * were.
 *
 * `payroll_ledger` is the sharpest of them: it is the target of a skipped
 * check, whose `reason` holds a customer's email. The name travels. The
 * reason does not.
 */
const MUST_APPEAR = [
  'customer_ledger',
  'audit_trail',
  'payroll_ledger',
  'layer-a/fk-orphans/public.customer_ledger.customer_fkey',
  'layer-b/no-implicit-fk/public.audit_trail',
] as const;

// ---------------------------------------------------------------------------
// a history file of this suite's own
// ---------------------------------------------------------------------------

/**
 * Everything this suite touches lives under here, and here is thrown away.
 *
 * Never the user's real data directory and never the repository: a suite that
 * appends a fabricated run holding a fabricated password to somebody's real
 * scan history has done something it can no longer undo. Every invocation
 * below passes `--out` explicitly, into this directory, so that a barrier
 * which has been broken writes its file somewhere harmless instead of into
 * `%LOCALAPPDATA%` or into a working tree.
 *
 * Suite (8) is the exception, and has to be: its subject is what happens when
 * nobody passes `--out`. It moves the platform's own data directory in here
 * instead — see `dataDirRedirectedTo` — and it ends by measuring that the real
 * one on this machine still holds exactly what it held before the file
 * started.
 */
const WORK = mkdtempSync(join(tmpdir(), 'ledar-export-evidence-'));
const HISTORY_DB = join(WORK, 'history.db');

/**
 * The evidence directory belonging to whoever is running this suite.
 *
 * Read once, at load, and compared again at the end of suite (8). Nothing here
 * writes into it — but "nothing writes into it" is the sort of claim that is
 * true until an edit makes it false quietly, and this is the difference
 * between measuring that and promising it. Names only, never contents, and
 * only ever printed if the assertion fails.
 */
const REAL_EVIDENCE_DIR = join(dataDir(), 'ledar', 'evidence');

function realEvidenceListing(): string[] {
  try {
    return readdirSync(REAL_EVIDENCE_DIR).sort();
  } catch {
    return [];
  }
}

const REAL_EVIDENCE_EXISTED = existsSync(REAL_EVIDENCE_DIR);
const REAL_EVIDENCE_BEFORE = realEvidenceListing();

const IDENTITY: DatabaseIdentity = {
  host: SECRET_HOST,
  port: 5432,
  database: 'paydb',
};

const SCOPE: ScopeManifest = {
  database: 'paydb',
  role: 'ledar_reader',
  schemas: ['public'],
  visibleTables: 12,
  totalTables: 19,
  grantedAt: null,
  // False on purpose: it is the branch that puts a disclosure sentence on the
  // run, which is one more piece of prose the pack has to leave behind.
  readOnlyEnforcedByDatabase: false,
  disclosure: PROSE.disclosure,
};

const OBSERVATION: Finding = {
  id: 'layer-a/fk-orphans/public.customer_ledger.customer_fkey',
  rule: 'layer-a/unvalidated-foreign-key-has-orphans',
  kind: 'observation',
  confidence: 'certain',
  severity: 'high',

  // A counted claim, which is what entitles it to `certain`. `sealFindings`
  // reads these two together and refuses the pair that does not add up, so a
  // fixture with an incoherent provenance would be refused for that rather
  // than for whatever the test around it is actually about.
  origin: 'counted',
  confidenceBasis: 'full_count',
  egressClass: 'customer-system-metadata',
  observedAt: '2026-08-21T10:00:04.000Z',
  engineRuleVersion: 'layer-a@1.0.0',
  userStatus: 'unreviewed',

  schema: 'public',
  table: 'customer_ledger',
  columns: ['customer_id'],
  plainText: PROSE.plainText,
  technical: PROSE.technical,
  // Since N50 a raised finding carries one too — and for this test that is
  // one MORE piece of rule-written prose the export has to redact, which is
  // the whole subject here. Same canary as the negative below: a leak that
  // copies the field is caught whichever finding it copied it from.
  boundary: PROSE.boundary,
  evidence: {
    sql: PROSE.observationSql,
    rowCount: 9,
    sampleSize: null,
    durationMs: 1.5,
    sample: [],
  },
  coverage: {
    checked: 1,
    eligible: 2,
    skipped: [{ target: 'public.payroll_ledger', reason: PROSE.skipReason }],
    truncatedAt: null,
    visibleToRole: null,
    verified: null,
    sampled: null,
    excluded: null,
  },
};

const NEGATIVE: Finding = {
  id: 'layer-b/no-implicit-fk/public.audit_trail',
  rule: 'layer-b/implicit-foreign-key',
  kind: 'negative',
  confidence: 'certain',
  severity: 'info',
  origin: 'counted',
  confidenceBasis: 'full_count',
  egressClass: 'customer-system-metadata',
  observedAt: '2026-08-21T10:00:07.000Z',
  engineRuleVersion: 'layer-b@1.0.0',
  userStatus: 'unreviewed',
  schema: 'public',
  table: 'audit_trail',
  columns: ['actor_id'],
  plainText: PROSE.plainText,
  technical: PROSE.technical,
  boundary: PROSE.boundary,
  evidence: {
    sql: PROSE.negativeSql,
    rowCount: 0,
    sampleSize: null,
    durationMs: 0.9,
    sample: [],
  },
  coverage: coverageOf(4, 4),
};

/**
 * One finished run, written the way `scan.ts` writes one.
 *
 * Built at module load rather than in a hook so the run id is a constant the
 * tests below can name. If this throws, the file fails to load and says why,
 * which is the right kind of loud.
 */
const RUN_ID = (() => {
  const store = ScanStore.open(HISTORY_DB);
  try {
    const runId = store.openRun({
      database: IDENTITY,
      scope: SCOPE,
      startedAt: '2026-08-21T09:00:00Z',
    });
    store.recordFindings(runId, [OBSERVATION, NEGATIVE]);
    store.finishRun(runId, {
      finishedAt: '2026-08-21T09:00:11Z',
      outcome: 'completed',
      cost: { queries: 14, totalMs: 62, rowsScanned: 1204 },
    });
    return runId;
  } finally {
    store.close();
  }
})();

/** A run number nothing could have recorded. */
const ABSENT_RUN = RUN_ID + 9_000;

type Ran = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

/**
 * Runs one npm script and collects both streams.
 *
 * `shell: true` because npm is a `.cmd` on Windows and Node refuses to spawn
 * one directly; one constant command string rather than an argv array for the
 * reason `scan.smoke.test.ts` gives — Node deprecates the array form under a
 * shell because it concatenates without escaping. The only interpolated part
 * is a path this file made, quoted because `%TEMP%` on somebody else's
 * machine may hold a space.
 */
function runScript(
  command: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<Ran> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, {
      cwd: REPO_ROOT,
      shell: true,
      timeout: timeoutMs,
      env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));

    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

/**
 * Runs the command a person actually types.
 *
 * `--run` is always passed, so the DSN reader in `export-evidence.ts` is
 * never reached and a DSN left in the operator's shell cannot influence any
 * of this.
 *
 * `historyDb` defaults to the hand-built history every test above uses. The
 * last suite in this file passes its own, because the whole point of that one
 * is that a scan wrote it.
 *
 * `env` is added last so it wins, which suite (8) needs: it moves the
 * platform's data directory somewhere disposable, and one of its tests has to
 * take `LEDAR_HISTORY_DB` away to see where the command looks without it.
 */
function runExport(
  args: string,
  historyDb: string = HISTORY_DB,
  env: NodeJS.ProcessEnv = {},
): Promise<Ran> {
  return runScript(
    `npm run export:evidence -- ${args}`,
    { ...process.env, LEDAR_HISTORY_DB: historyDb, ...env },
    EXPORT_TIMEOUT_MS,
  );
}

/**
 * `child` is somewhere below `parent`.
 *
 * By the relative path between them rather than by `startsWith`, which reads
 * `C:\work-in-progress` as being inside `C:\work` and would make a test about
 * where files land agree with the wrong directory.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Moves this platform's data directory into `base`, using only variables the
 * product already reads.
 *
 * Both branches of `dataDir()` for the platform in hand, not just the one it
 * takes today: the variable it consults AND the home directory it falls back
 * to. Pointing only the first one somewhere safe would write a real pack into
 * the operator's real `%LOCALAPPDATA%` the day somebody deletes that branch —
 * and deleting that branch is exactly the sort of edit this suite exists to
 * catch, so it must not be the sort of edit that makes the suite dangerous.
 *
 * No new variable was invented for this. Something that moves where evidence
 * lands is product surface: one more way for a pack to end up somewhere its
 * owner did not expect, and one more thing to document, support and mean.
 * `LOCALAPPDATA`, `XDG_DATA_HOME`, `USERPROFILE` and `HOME` are all read by
 * the product already — the last two through `os.homedir()`.
 */
function dataDirRedirectedTo(
  base: string,
  // Defaulted rather than read, for the reason `dataDir` itself takes one:
  // two of these three branches could never run, because a suite only ever
  // executes on one platform. A branch no test can reach is a branch nobody
  // has checked against the rule it is supposed to mirror. See
  // `paths.platform.test.ts`, which asks all three from wherever it runs.
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    return { LOCALAPPDATA: base, USERPROFILE: base };
  }
  if (platform === 'darwin') {
    // macOS reads no variable for this, so the pack lands under
    // `<base>/Library/Application Support`. Still inside `base`, which is all
    // the assertions below ask.
    return { HOME: base };
  }
  return { XDG_DATA_HOME: base, HOME: base };
}

export { dataDirRedirectedTo as packRedirectFor };

/**
 * Every file path the command printed.
 *
 * Off the screen, because that is where a person who did not pass `--out` gets
 * it: a pack written to a path the command kept to itself is a pack nobody can
 * find. Suite (8) asserts there is exactly one — two would mean the output
 * tells the reader to look in two places.
 */
function pathsPrinted(ran: Ran): string[] {
  return ran.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.json'));
}

/** Everything either stream said, for a failure message worth reading. */
function said(ran: Ran): string {
  return `--- stderr ---\n${ran.stderr.trim()}\n--- stdout ---\n${ran.stdout.trim()}`;
}

/**
 * Asserts the command refused rather than crashed.
 *
 * Exit 1 is `Refused`: a sentence the user can act on. Exit 2 is anything
 * else — a thrown TypeError from a guard somebody deleted looks exactly like
 * this if the only thing checked is "non-zero".
 */
function assertRefused(ran: Ran, expected: string): void {
  assert.equal(
    ran.signal,
    null,
    `the export was killed by ${ran.signal} instead of refusing.\n${said(ran)}`,
  );
  assert.equal(
    ran.code,
    1,
    ran.code === 0
      ? `the export exited 0. It did not refuse.\n${said(ran)}`
      : `the export exited ${ran.code} rather than refusing with 1. Exit 2 ` +
        `is an unhandled throw: it failed, but it told the user nothing.\n${said(ran)}`,
  );
  assert.ok(
    ran.stderr.includes(expected),
    `the refusal never mentions ${expected}, so it is probably about ` +
      `something other than what this test set up.\n${said(ran)}`,
  );
}

after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (1) (2) (3) — where a pack is allowed to land
// ---------------------------------------------------------------------------

describe('export-evidence refuses to write where it should not', () => {
  /**
   * A repository that is not this one.
   *
   * The barrier looks for a `.git` entry while walking up from the target, so
   * a directory of that name is precisely what it is looking for — and using
   * a fabricated one in the temp directory means that if the barrier ever
   * fails, the file it should not have written lands here and gets deleted,
   * rather than in the tree this suite is running out of.
   *
   * The target sits two directories below the repository root so the upward
   * walk is actually exercised. A test pointing straight at the root would
   * still pass for an implementation that only checked its own directory.
   */
  const FAKE_REPO = join(WORK, 'somebodys-project');
  const IN_REPO_DIR = join(FAKE_REPO, 'reports', 'for-the-dba');
  const IN_REPO = join(IN_REPO_DIR, 'pack.json');

  before(() => {
    mkdirSync(join(FAKE_REPO, '.git'), { recursive: true });
  });

  it('refuses a target inside a git repository, and creates nothing', async () => {
    const ran = await runExport(`--run ${RUN_ID} --out "${IN_REPO}"`);

    assertRefused(ran, IN_REPO);

    assert.equal(
      existsSync(IN_REPO),
      false,
      `${IN_REPO} was written into a git repository. An Evidence Pack in a ` +
        `working tree is one \`git add .\` from being published.`,
    );
    // The refusal happens before `mkdirSync`, and that is worth pinning: a
    // pack that is refused should leave no trace at all, not an empty
    // directory somebody later wonders about.
    assert.equal(
      existsSync(join(FAKE_REPO, 'reports')),
      false,
      'the export created directories inside the repository before refusing',
    );
  });

  /**
   * The same barrier, against the shape it actually meets on a real machine.
   *
   * In a linked worktree and in a submodule, `.git` is not a directory: it is
   * a one-line FILE holding `gitdir: <path>`. Everything else about that
   * checkout is a working tree — `git add .` there publishes just as fast.
   *
   * `existsSync` catches both, which is why the barrier works today. Nothing
   * said so. An edit to `statSync(...).isDirectory()` reads like a
   * tightening, leaves every other test in this file green, and takes rule 6
   * off on every machine that uses `git worktree`. Debt N11.
   */
  const WORKTREE = join(WORK, 'linked-worktree');
  const IN_WORKTREE = join(WORKTREE, 'reports', 'for-the-dba', 'pack.json');

  before(() => {
    mkdirSync(WORKTREE, { recursive: true });
    // What git itself writes there: the word, a space, an absolute path.
    writeFileSync(
      join(WORKTREE, '.git'),
      `gitdir: ${join(WORK, 'somebodys-project', '.git', 'worktrees', 'linked-worktree')}\n`,
      'utf8',
    );
  });

  it('refuses a target under a `.git` FILE, as a worktree has', async () => {
    // Guards the guard. If this ever stops being a file, the test below is
    // just the previous one again, passing for a property it never checked.
    assert.equal(
      statSync(join(WORKTREE, '.git')).isFile(),
      true,
      'this test set up a `.git` directory, not the `.git` FILE a linked ' +
        'worktree has, so it is no longer testing anything new',
    );

    const ran = await runExport(`--run ${RUN_ID} --out "${IN_WORKTREE}"`);

    assertRefused(ran, IN_WORKTREE);

    assert.equal(
      existsSync(IN_WORKTREE),
      false,
      `${IN_WORKTREE} was written into a linked worktree. A worktree is a ` +
        `working tree — the only thing unusual about it is that its \`.git\` ` +
        `is a file, and the barrier must not be reading that as "no repo here".`,
    );
    assert.equal(
      existsSync(join(WORKTREE, 'reports')),
      false,
      'the export created directories inside the worktree before refusing',
    );
  });

  it('refuses to overwrite an existing file, and leaves it byte for byte', async () => {
    const TAKEN = join(WORK, 'occupied', 'pack.json');
    // Deliberately longer than the pack would be, and not JSON. A `w` flag
    // truncates before writing, so a shorter payload would leave this file
    // both changed and still parseable-looking; comparing the exact bytes is
    // what makes "it was not touched" mean it.
    const ORIGINAL = `somebody else's export, ${'kept'.repeat(400)}\n`;

    mkdirSync(dirname(TAKEN), { recursive: true });
    writeFileSync(TAKEN, ORIGINAL, 'utf8');

    const ran = await runExport(`--run ${RUN_ID} --out "${TAKEN}"`);

    assertRefused(ran, TAKEN);

    assert.equal(
      readFileSync(TAKEN, 'utf8'),
      ORIGINAL,
      `${TAKEN} was modified. Two exports of two different scans under one ` +
        `name is how the wrong one gets sent.`,
    );
  });

  it('refuses a run number the history does not have', async () => {
    const NEVER = join(WORK, 'missing-run', 'pack.json');

    const ran = await runExport(`--run ${ABSENT_RUN} --out "${NEVER}"`);

    assertRefused(ran, String(ABSENT_RUN));

    assert.equal(
      existsSync(NEVER),
      false,
      `${NEVER} was written for run ${ABSENT_RUN}, which is not in the ` +
        `history. Whatever is in that file is not the run that was asked for.`,
    );
    assert.equal(
      existsSync(dirname(NEVER)),
      false,
      'the export created its output directory for a run that does not exist',
    );
  });
});

// ---------------------------------------------------------------------------
// (4) the happy path, and what it is allowed to carry
// ---------------------------------------------------------------------------

describe('export-evidence writes a pack that carries no data', () => {
  const PACK = join(WORK, 'exported', 'pack.json');

  /** One export, read by both tests. Two would be two of everything. */
  let ran: Ran | undefined;
  let raw: Buffer | undefined;

  before(async () => {
    ran = await runExport(`--run ${RUN_ID} --out "${PACK}"`);
    if (existsSync(PACK)) raw = readFileSync(PACK);
  });

  it('exits 0 and leaves a readable evidence pack', () => {
    assert.ok(ran, 'the export never ran');
    assert.equal(ran.code, 0, `the export exited ${ran.code}.\n${said(ran)}`);
    assert.ok(raw, `nothing was written to ${PACK}, though the export exited 0`);

    const pack: unknown = JSON.parse(raw.toString('utf8'));
    assert.ok(pack !== null && typeof pack === 'object', 'the pack is not an object');
    const p = pack as Record<string, unknown>;

    assert.equal(p['kind'], 'ledar.evidence-pack');
    assert.ok(p['notice'], 'the pack has no notice section');

    const notice = p['notice'] as Record<string, unknown>;
    assert.ok(
      Array.isArray(notice['contains']) && notice['contains'].length > 0,
      'the notice does not say what the pack contains',
    );
    assert.ok(
      Array.isArray(notice['excludes']) && notice['excludes'].length > 0,
      'the notice does not say what the pack leaves out — the half a person ' +
        'deciding whether to send this needs most',
    );
    assert.equal(
      typeof notice['scopeSentence'],
      'string',
      'the pack states no coverage sentence, so nothing in it says how much ' +
        'of the database these findings are about',
    );

    // Both findings, or the test below is proving nothing.
    assert.ok(Array.isArray(p['findings']), 'the pack has no findings array');
    assert.equal(
      (p['findings'] as unknown[]).length,
      2,
      'the pack does not hold both recorded findings',
    );
  });

  it('carries no credential and none of the scan’s prose', () => {
    assert.ok(raw, `nothing was written to ${PACK}`);

    // Read as bytes, not as a parsed object. `JSON.parse` throws away
    // anything it does not understand and hands back only the fields somebody
    // thought to look at; a leak in a field nobody expected would be
    // invisible to an assertion on the parsed shape. What was written to disk
    // is what gets sent, so what was written to disk is what is searched.
    const bytes = raw;
    const holds = (needle: string): boolean =>
      bytes.includes(Buffer.from(needle, 'utf8'));

    // ---- part one: the findings really are in there ----
    //
    // Without this, an empty file passes everything below.
    for (const name of MUST_APPEAR) {
      assert.ok(
        holds(name),
        `"${name}" is not in the pack. The findings did not travel, so the ` +
          `absence of their prose below proves nothing.`,
      );
    }

    // ---- part two: nothing that unlocks the database ----
    const CREDENTIALS: readonly [string, string][] = [
      ['the password', SECRET_PASSWORD],
      ['the hostname', SECRET_HOST],
      ['the connection string', SECRET_DSN],
      ['a row value', CUSTOMER_VALUE],
    ];

    for (const [what, needle] of CREDENTIALS) {
      assert.equal(
        holds(needle),
        false,
        `${what} reached the exported file. It was in the local history — ` +
          `that is allowed; leaving the machine in a pack is not.`,
      );
    }

    // ---- part three: none of the sentences ----
    //
    // Prose is where values arrive by accident: rule code interpolates
    // whatever it had to hand, including database error messages, which quote
    // values back. `plainText`, `technical`, `boundary`, the SQL and the
    // reason a target was skipped are all in the history file this command
    // just read, and none of them is a field an Evidence Pack has.
    const SENTENCES: readonly [string, string][] = [
      ['plainText', PROSE.plainText],
      ['technical', PROSE.technical],
      ['boundary', PROSE.boundary],
      ['evidence.sql (observation)', PROSE.observationSql],
      ['evidence.sql (negative)', PROSE.negativeSql],
      ['coverage.skipped[].reason', PROSE.skipReason],
      ['scope.disclosure', PROSE.disclosure],
    ];

    for (const [field, needle] of SENTENCES) {
      assert.equal(
        holds(needle),
        false,
        `the scan's ${field} was carried into the pack verbatim.`,
      );
    }

    // A whole sentence only catches a leak that copied the whole sentence.
    for (const [field, marker] of Object.entries(CANARY)) {
      assert.equal(
        holds(marker),
        false,
        `a fragment of the scan's ${field} reached the pack: the marker ` +
          `"${marker}" is in the file. Something is carrying part of a ` +
          `sentence across, which is how half a row value travels.`,
      );
    }

    // The whole point of the negative finding: that a boundary existed
    // travels, the boundary itself does not. If this flag is missing the
    // pack has quietly downgraded a negative claim.
    const findings = (JSON.parse(bytes.toString('utf8')) as {
      findings: { id: string; boundaryStated?: boolean }[];
    }).findings;
    const negative = findings.find((f) => f.id === NEGATIVE.id);
    assert.ok(negative, 'the negative finding is not in the pack');
    assert.equal(
      negative.boundaryStated,
      true,
      'the pack dropped the boundary sentence without recording that there ' +
        'was one, so "nothing found here" now reads as unbounded',
    );
  });
});

// ---------------------------------------------------------------------------
// (5) --force — the sanctioned way around one refusal, and only that one
// ---------------------------------------------------------------------------

/**
 * Debt N12.
 *
 * `--force` is a legitimate road: somebody re-exports a run over a file they
 * know is stale. It is also, by construction, the way past the barrier that
 * refuses to overwrite — so the two things worth pinning are that it opens
 * that door when typed, and that it opens nothing else.
 *
 * The second half is the classic failure of any "skip the check" flag: it is
 * written for one check and ends up wrapped around several, because the
 * checks sit near each other in the file. Here the neighbour is the
 * repository barrier, and the difference matters — an overwritten pack costs
 * the user a file they still have the scan for, while a pack written into a
 * working tree is rule 6 gone.
 */
describe('export-evidence overwrites only when --force says so', () => {
  /**
   * A marker in the middle of the old file, not at its start.
   *
   * `w` truncates; `a` appends. A test that only checked "the file changed"
   * passes for the append, which leaves the old export sitting above a valid
   * pack — a file that reads as one thing and holds two.
   */
  const SENTINEL = 'CANARY-OLD-EXPORT-v6qy';
  const ORIGINAL = `${'kept'.repeat(200)} ${SENTINEL} ${'kept'.repeat(200)}\n`;

  /** A repository of this suite's own, so no test ordering is assumed. */
  const FAKE_REPO = join(WORK, 'forced-into-a-repo');
  const IN_REPO = join(FAKE_REPO, 'reports', 'pack.json');

  before(() => {
    mkdirSync(join(FAKE_REPO, '.git'), { recursive: true });
  });

  it('replaces the file with --force, and refuses the same command without it', async () => {
    const TARGET = join(WORK, 'forced', 'pack.json');

    mkdirSync(dirname(TARGET), { recursive: true });
    writeFileSync(TARGET, ORIGINAL, 'utf8');

    // The same command twice. The flag is the only difference between them,
    // so whatever changes between the two runs is the flag's doing and
    // nothing else's — which is the whole claim being made here.
    const without = await runExport(`--run ${RUN_ID} --out "${TARGET}"`);

    assertRefused(without, TARGET);
    assert.equal(
      readFileSync(TARGET, 'utf8'),
      ORIGINAL,
      `${TARGET} was modified by a command that carried no --force`,
    );

    const forced = await runExport(`--run ${RUN_ID} --out "${TARGET}" --force`);

    assert.equal(
      forced.code,
      0,
      `--force did not write. The flag is documented in the refusal the user ` +
        `just read ("pass --force if replacing that file is what you meant"), ` +
        `so a --force that refuses is a dead end with directions to it.\n${said(forced)}`,
    );

    const replaced = readFileSync(TARGET, 'utf8');

    assert.equal(
      replaced.includes(SENTINEL),
      false,
      `part of the previous file survived --force. The old export is still ` +
        `in there beside the new one, which is worse than either: the file ` +
        `now describes two scans and announces one.`,
    );

    // Changed is not enough — it has to have changed into this export.
    const pack = JSON.parse(replaced) as Record<string, unknown>;
    assert.equal(
      pack['kind'],
      'ledar.evidence-pack',
      'the file --force left behind is not an evidence pack',
    );
    assert.ok(Array.isArray(pack['findings']), 'the pack has no findings array');
    assert.equal(
      (pack['findings'] as unknown[]).length,
      2,
      `the pack --force wrote does not hold the two findings of run ${RUN_ID}, ` +
        `so it is not the export that was asked for`,
    );
  });

  it('does not carry --force through the repository barrier', async () => {
    const ran = await runExport(`--run ${RUN_ID} --out "${IN_REPO}" --force`);

    assertRefused(ran, IN_REPO);

    assert.equal(
      existsSync(IN_REPO),
      false,
      `--force wrote ${IN_REPO} into a git repository. It is the flag for ` +
        `one refusal — "replace the file that is already there" — and it has ` +
        `been read as "skip the checks". Rule 6 is the one it skipped.`,
    );
    assert.equal(
      existsSync(dirname(IN_REPO)),
      false,
      '--force created directories inside the repository before refusing',
    );
  });

  /**
   * Debt N19.
   *
   * The test above proves `--force` stops at one barrier. One is not the set:
   * a flag written for a single check ends up wrapped around whichever checks
   * happen to sit near it, and the reason to name this second barrier
   * separately is that it fails in a different currency. Writing into a
   * repository leaks a description of somebody's database. Exporting a run
   * that is not in the history hands somebody a file that describes a scan
   * that never happened — and a pack is believed precisely because it came
   * out of a recorded run.
   *
   * The two refusals also sit at opposite ends of `main` in
   * `export-evidence.ts`: this one is inside `chooseRun`, before a pack has
   * been built at all, and the repository barrier is after the pack has been
   * serialized. A `--force` threaded through the wrong one of those would
   * leave the other test green.
   */
  it('does not carry --force through the missing-run barrier', async () => {
    const NEVER = join(WORK, 'forced-missing-run', 'pack.json');

    const ran = await runExport(`--run ${ABSENT_RUN} --out "${NEVER}" --force`);

    assertRefused(ran, String(ABSENT_RUN));

    assert.equal(
      existsSync(NEVER),
      false,
      `--force wrote ${NEVER} for run ${ABSENT_RUN}, which is not in the ` +
        `history. The flag means "replace the file that is already there", ` +
        `and it has been read as "export something anyway". Whatever is in ` +
        `that file, it is not the run that was asked for.`,
    );
    assert.equal(
      existsSync(dirname(NEVER)),
      false,
      '--force created its output directory for a run that does not exist',
    );
  });
});

// ---------------------------------------------------------------------------
// (6) the two branches a run against the fixture never reaches
// ---------------------------------------------------------------------------

/**
 * Debt N18.
 *
 * Suite (7) below runs the real thing, and there are two branches it can
 * never take. Pagila always has findings, so Layer A never emits a negative
 * claim there and `kind === 'negative'` is dead code in that suite. The
 * fixture role is read-only enforced by the database, so `scope.disclosure`
 * is always `null` and there is never a disclosure sentence to go looking
 * for. Both branches pass today for the same reason an empty test passes.
 *
 * They are also the only two places where the pack has to do a difficult
 * thing rather than a simple one. Everywhere else the rule is "the sentence
 * stays on the machine", and the pack keeps it by having no field for it.
 * These two have to carry the FACT while leaving the SENTENCE behind:
 *
 *   `boundaryStated: true`          a negative claim said where it stopped
 *   `disclosureShownLocally: true`  the run carried a read-only disclosure
 *
 * Drop either flag and a real claim quietly changes meaning: "nothing found,
 * within these limits" becomes an unbounded "nothing found", and a read-only
 * promise made by this software reads as one made by Postgres. Carry either
 * sentence and the pack is exporting rule-written prose, which is the one
 * thing `notice.excludes` promises it does not do.
 *
 * Only a hand-built run has both, so this suite exports the hand-built one —
 * and its first test is the guard that the fixture still has them, because
 * every assertion below is worthless against a run that carries neither.
 */
describe('export-evidence carries the fact of a sentence, not the sentence', () => {
  const PACK = join(WORK, 'stated-not-said', 'pack.json');

  let ran: Ran | undefined;
  let raw: Buffer | undefined;

  before(async () => {
    ran = await runExport(`--run ${RUN_ID} --out "${PACK}"`);
    if (existsSync(PACK)) raw = readFileSync(PACK);
  });

  it('the exported run really holds a boundary and a disclosure', () => {
    // Half of this is about the fixture in this file. The other half is about
    // the history file, and it is the half that matters: the export reads
    // SQLite, not these constants, so a store that dropped either field would
    // leave every assertion below passing against a run that never had them.
    assert.equal(
      SCOPE.readOnlyEnforcedByDatabase,
      false,
      'the fixture scope is now enforced read-only, so it carries no ' +
        'disclosure and this suite is testing the branch it was written to ' +
        'get away from',
    );
    const boundary = NEGATIVE.kind === 'negative' ? NEGATIVE.boundary : null;
    assert.ok(
      typeof boundary === 'string' && boundary.trim() !== '',
      'the fixture no longer holds a negative claim with a boundary sentence',
    );

    const store = ScanStore.open(HISTORY_DB);
    try {
      const summary = store.runById(RUN_ID);
      assert.ok(summary, `run ${RUN_ID} is not in ${HISTORY_DB}`);
      assert.equal(
        summary.scope.disclosure,
        PROSE.disclosure,
        'the history did not keep the disclosure sentence, so the export ' +
          'never saw one and `disclosureShownLocally` below is false for a ' +
          'reason that has nothing to do with the pack',
      );

      const stored = store.findingsOf(RUN_ID).map((s) => s.finding);
      const negative = stored.find((f) => f.id === NEGATIVE.id);
      assert.ok(negative, `the negative finding is not in run ${RUN_ID}`);
      assert.equal(negative.kind, 'negative');
      assert.equal(
        negative.kind === 'negative' ? negative.boundary : null,
        boundary,
        'the history did not keep the boundary sentence',
      );
    } finally {
      store.close();
    }
  });

  it('states that a boundary existed, and does not state the boundary', () => {
    assert.ok(ran, 'the export never ran');
    assert.equal(ran.code, 0, `the export exited ${ran.code}.\n${said(ran)}`);
    assert.ok(raw, `nothing was written to ${PACK}, though the export exited 0`);

    // Bytes, not the parsed object. A flag read off `JSON.parse` is a flag
    // read out of the fields somebody thought to look at; the file is what
    // gets sent, so the file is what is searched. Both spellings are looked
    // for, because a `boundaryStated` that were hardcoded to `true` would
    // satisfy the first assertion alone and mean nothing.
    const bytes = raw;
    const holds = (needle: string): boolean =>
      bytes.includes(Buffer.from(needle, 'utf8'));

    assert.ok(
      holds('"boundaryStated": true'),
      'no finding in the pack says it stated a boundary. The negative claim ' +
        'in this run did, and without that flag "nothing was found here" ' +
        'leaves the machine with nothing beside it saying where the looking ' +
        'stopped.',
    );
    assert.ok(
      holds('"boundaryStated": false'),
      'every finding in the pack claims a boundary, including the ' +
        'observation, which never had one. The flag is not being computed ' +
        'from the claim — so the `true` above says nothing about this run.',
    );

    const boundary = NEGATIVE.kind === 'negative' ? NEGATIVE.boundary : '';
    assert.equal(
      holds(boundary),
      false,
      'the boundary sentence itself was exported. It is written by rule ' +
        'code out of whatever it had to hand — this one holds a connection ' +
        'string — and the pack carries that a boundary existed, never its ' +
        'words.',
    );
    assert.equal(
      holds(CANARY.boundary),
      false,
      `a fragment of the boundary sentence reached the pack: the marker ` +
        `"${CANARY.boundary}" is in the file.`,
    );
  });

  it('states that a disclosure was shown, in its own words, not the rule’s', () => {
    assert.ok(raw, `nothing was written to ${PACK}`);
    const bytes = raw;
    const holds = (needle: string): boolean =>
      bytes.includes(Buffer.from(needle, 'utf8'));

    assert.ok(
      holds('"readOnlyEnforcedByDatabase": false'),
      'the pack does not record that the database was not enforcing ' +
        'read-only. That is rule 1b of AGENTS.md section 3: a read-only ' +
        'promise made by software is not the same claim as one made by ' +
        'Postgres, and every number in the pack inherits the difference.',
    );
    assert.ok(
      holds('"disclosureShownLocally": true'),
      'the pack does not record that a disclosure was shown to the user ' +
        'locally. The sentence is not allowed to travel, so this flag is the ' +
        'only thing that tells a reader it was ever said.',
    );

    // And the pack says the same thing in prose it wrote itself — a
    // product-constant sentence out of `evidence-pack.ts`, not the
    // connector's. That is what makes leaving the connector's wording behind
    // a redaction rather than a loss.
    assert.ok(
      holds('NOT enforcing read-only'),
      'the pack states the fact as a flag and nowhere in words. A person ' +
        'reading this file is not going to reconstruct what a false boolean ' +
        'means about a promise.',
    );

    assert.equal(
      holds(PROSE.disclosure),
      false,
      'the connector’s disclosure sentence was exported verbatim. It names ' +
        'the host it was measured against, which is exactly why the pack ' +
        'says this in its own words instead of repeating anybody else’s.',
    );
    assert.equal(
      holds(CANARY.disclosure),
      false,
      `a fragment of the disclosure sentence reached the pack: the marker ` +
        `"${CANARY.disclosure}" is in the file.`,
    );
  });
});

// ---------------------------------------------------------------------------
// (7) the seam: a real scan, then a real export of the run it just printed
// ---------------------------------------------------------------------------

/**
 * Debt N13.
 *
 * Every history above this line was written by this file. That proves the
 * export against the shape this file believes `scan.ts` produces, which is a
 * belief, not a measurement: `scan.ts` could start writing a different scope,
 * a different outcome, or findings that `buildEvidencePack` refuses, and
 * nothing here would go red. The user would find out instead.
 *
 * So this one runs the two commands HANDOFF-STATUS section 1b tells a person
 * to run, in the order a person runs them, against the fixture — and takes
 * the run number the way a person takes it, by reading it off the screen.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * Not counts. The fixture's damage is edited by whoever is calibrating the
 * scanner, and a test that pins "4 findings" fails on the next fault added —
 * a failure that says nothing about the export and gets muted. It asserts
 * structure instead: at least one finding, every `kind` a kind a claim may
 * have, a `damaged_*` table named, and none of the scan's prose in the file.
 *
 * The prose it looks for is read back out of the history at run time rather
 * than written down here, so it is the sentences THIS scan produced — not a
 * copy of sentences some earlier scan produced, which would go stale into a
 * test that quietly stopped looking for anything real.
 */
const REAL_SUITE = 'export-evidence exports a run that npm run scan recorded';

/** A scan of Pagila, plus an export, plus npm twice. */
const SCAN_TIMEOUT_MS = 180_000;

const KINDS: ReadonlySet<string> = new Set<ClaimKind>([
  'observation',
  'inference',
  'recommendation',
  'negative',
]);

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(REAL_SUITE, gate.reason);

  // A skipped test, not a skipped suite: a suite that vanishes from the
  // totals reads as "nothing to do here", and this is a hole, not a nothing.
  describe(REAL_SUITE, () => {
    it('no scan was run, so the seam between the two commands is unmeasured', {
      skip: gate.reason,
    }, () => {
      assert.fail('unreachable: this test is skipped');
    });
  });
} else {
  // Opened only to prove the fixture is there. The scan opens its own.
  await gate.client.end();

  describe(REAL_SUITE, () => {
    /** This suite's own history, so the hand-built runs cannot be mistaken for it. */
    const SCAN_HISTORY = join(WORK, 'from-a-real-scan.db');
    const PACK = join(WORK, 'from-a-real-scan', 'pack.json');

    /** One scan and one export, read by all three tests. */
    let scan: Ran | undefined;
    let printedRun: number | undefined;
    let exported: Ran | undefined;
    let raw: Buffer | undefined;

    before(async () => {
      scan = await runScript(
        'npm run scan',
        {
          ...process.env,
          // Pinned, so a DSN left in the operator's shell cannot quietly
          // point this at some other database.
          TEST_PG_DSN: PAGILA_DSN,
          LEDAR_SCHEMAS: 'public',
          LEDAR_HISTORY_DB: SCAN_HISTORY,
        },
        SCAN_TIMEOUT_MS,
      );

      // The seam itself. `--run` takes a number a person copies off the
      // screen, so this reads it off the screen too rather than asking the
      // store — asking the store would test the store, and route around the
      // one printed sentence that makes the two commands usable together.
      const printed = /history: recorded as run (\d+) in /.exec(scan.stdout);
      const id = printed?.[1];
      if (id === undefined) return; // the first test says so, and why.

      printedRun = Number(id);
      exported = await runExport(`--run ${printedRun} --out "${PACK}"`, SCAN_HISTORY);
      if (existsSync(PACK)) raw = readFileSync(PACK);
    });

    it('scans the fixture and prints the run number an export can be given', () => {
      assert.ok(scan, 'the scan never ran');

      const tail = (s: string) => s.split(/\r?\n/).slice(-25).join('\n');

      assert.equal(
        scan.signal,
        null,
        `npm run scan was killed by ${scan.signal} — it did not finish ` +
          `within ${SCAN_TIMEOUT_MS / 1000}s against ${redactDsn(PAGILA_DSN)}`,
      );
      assert.equal(
        scan.code,
        0,
        `npm run scan exited ${scan.code} against ${redactDsn(PAGILA_DSN)}.\n` +
          `--- stderr (tail) ---\n${tail(scan.stderr)}\n` +
          `--- stdout (tail) ---\n${tail(scan.stdout)}`,
      );

      assert.match(
        scan.stdout,
        /history: recorded as run \d+ in /,
        `the scan printed no run number in the form this suite reads it. ` +
          `Either it recorded nothing — in which case the line it printed ` +
          `instead is the failure worth reading — or \`scan.ts\` reworded ` +
          `that sentence, and that sentence is the only place a user gets ` +
          `the number \`export:evidence --run\` needs.\n` +
          `--- stdout (tail) ---\n${tail(scan.stdout)}`,
      );
      assert.ok(
        printedRun !== undefined && Number.isInteger(printedRun) && printedRun > 0,
        'the run number printed by the scan is not a positive integer',
      );
    });

    it('exports that run, and the pack holds findings this scan really made', () => {
      assert.ok(
        exported,
        'the export never ran, because the scan printed no run number to give it',
      );
      assert.equal(
        exported.code,
        0,
        `the export of run ${printedRun} exited ${exported.code}. The run was ` +
          `written by a scan a moment earlier, so a refusal here is the two ` +
          `commands disagreeing about the history they share.\n${said(exported)}`,
      );
      assert.ok(raw, `nothing was written to ${PACK}, though the export exited 0`);

      const pack = JSON.parse(raw.toString('utf8')) as {
        kind: string;
        scope: { database: string };
        findings: { id: string; kind: string; table: string }[];
      };

      assert.equal(pack.kind, 'ledar.evidence-pack');
      assert.equal(
        pack.scope.database,
        new URL(PAGILA_DSN).pathname.replace(/^\//, ''),
        'the pack is about a different database than the one that was scanned',
      );

      // No count is asserted: the fixture's damage is edited as the scanner
      // is calibrated. Only that something came through — an empty pack
      // would satisfy every absence check below for the worst reason.
      assert.ok(
        pack.findings.length >= 1,
        `the pack from a real scan of ${redactDsn(PAGILA_DSN)} holds no ` +
          `findings at all. The fixture carries deliberate faults, so either ` +
          `the scan found none or none of them survived the export.`,
      );

      for (const f of pack.findings) {
        assert.ok(
          KINDS.has(f.kind),
          `finding ${f.id} left the machine with kind "${f.kind}", which is ` +
            `not a kind a claim may have. Rule 3 rests on this word.`,
        );
      }

      assert.ok(
        pack.findings.some((f) => f.table.startsWith('damaged_')),
        `no finding in the pack names one of the fixture's damaged_* tables. ` +
          `Whatever travelled, it is not what this scan was pointed at.`,
      );
    });

    it('carries none of the sentences this scan wrote into the history', () => {
      assert.ok(raw, `nothing was written to ${PACK}`);
      const run = printedRun;
      assert.ok(run !== undefined, 'no run was exported');

      // Read out of the history at run time. Sentences copied into this file
      // would be a snapshot of some earlier scan, and would keep passing
      // after the rules stopped producing them.
      const needles: [string, string][] = [];
      const store = ScanStore.open(SCAN_HISTORY);

      try {
        const summary = store.runById(run);
        assert.ok(summary, `run ${run} is not in ${SCAN_HISTORY}`);

        const keep = (where: string, text: string | null | undefined): void => {
          if (typeof text === 'string' && text.trim() !== '') {
            needles.push([where, text]);
          }
        };

        keep('scope.disclosure', summary.scope.disclosure);

        for (const stored of store.findingsOf(run)) {
          const f = stored.finding;
          keep(`${f.id}.plainText`, f.plainText);
          keep(`${f.id}.technical`, f.technical);
          if (f.kind === 'negative') keep(`${f.id}.boundary`, f.boundary);
          keep(`${f.id}.evidence.sql`, f.evidence?.sql);
          for (const s of f.coverage.skipped) {
            keep(`${f.id}.coverage.skipped[].reason`, s.reason);
          }
        }
      } finally {
        store.close();
      }

      // An empty needle list would make every assertion below pass for the
      // worst possible reason — nothing to look for.
      assert.ok(
        needles.length >= 2,
        `the history for run ${run} holds no prose, so this test would pass ` +
          `against any file at all`,
      );

      const bytes = raw;
      const holds = (needle: string): boolean =>
        bytes.includes(Buffer.from(needle, 'utf8'));

      for (const [where, needle] of needles) {
        assert.equal(
          holds(needle),
          false,
          `the scan's ${where} was carried into the pack verbatim. Rule code ` +
            `builds these out of whatever it had to hand, including Postgres ` +
            `error messages, which quote values back.`,
        );
      }

      // The credential the scan connected with, which is in neither the
      // history nor the pack's schema — and is one careless line from both.
      const dsn = new URL(PAGILA_DSN);
      for (const [what, secret] of [
        ['the password', dsn.password],
        ['the host', dsn.hostname],
      ] as const) {
        if (secret === '') continue;
        assert.equal(
          holds(secret),
          false,
          `${what} of the scanned database reached the exported file`,
        );
      }
    });
  });
}

// ---------------------------------------------------------------------------
// (8) the path nobody typed — where a pack goes when there is no --out
// ---------------------------------------------------------------------------

/**
 * Debt N10.
 *
 * Every test above this line passes `--out`, into a directory this file made.
 * That is the right thing for them to do and it leaves a hole exactly the
 * width of the branch a real person takes: they type
 * `npm run export:evidence -- --run 7`, and the pack lands wherever
 * `defaultOutputFile()` and `dataDir()` say it lands. Rename that file, or let
 * it fall into the working directory, and nothing in this suite went red.
 *
 * It is the subtle form of principle 12. The barrier IS watched — the three
 * refusals above are tested hard — but watched on the branch the user does not
 * take.
 *
 * ## Why this was put off twice, and what is done instead
 *
 * The obvious way to watch the default path is to let a test walk it, which
 * means letting a test write into `%LOCALAPPDATA%`. That is the operator's own
 * scan history and their own packs; a suite that leaves fabricated exports in
 * there has done something to their machine it cannot take back, and the cost
 * is larger than the thing being bought. So two cheaper instruments are used,
 * and neither writes a byte into it:
 *
 *   The rule is asked. `dataDir()` and `defaultOutputFile()` take the
 *   platform, the environment and the base directory as arguments, so this
 *   file can ask what a Mac would do from a Windows laptop and get a string
 *   back rather than a directory. Product code passes none of them.
 *
 *   The command is run with the platform's own data directory pointed into
 *   `WORK` — `LOCALAPPDATA` on Windows, `XDG_DATA_HOME` on Linux, `HOME` on
 *   macOS, plus the home directory in every case so that the fallback branch
 *   is covered too. No new environment variable was invented; every one of
 *   those is already read by the product. See `dataDirRedirectedTo`.
 *
 * ## Properties, not the string this machine produces
 *
 * `"C:\\Users\\me\\AppData\\Local\\ledar\\evidence"` in an assertion is a test
 * that goes red on the next person's computer for a reason that teaches
 * nothing, and a test like that gets deleted rather than read. What is
 * asserted here is what has to stay true anywhere: three platforms disagree,
 * none of them answers with the working directory, the answer comes from the
 * arguments it was given, the pack lands under the data directory, the
 * repository barrier covers that path too, and two exports of one run cannot
 * choose one name.
 *
 * Declared last on purpose: its final test compares the real evidence
 * directory on this machine against the listing taken when the file loaded, so
 * it wants every other suite in the file to have had its chance first.
 */
describe('export-evidence knows where a pack goes when nobody says', () => {
  /** A home nothing is ever created in: these tests ask the rule, they do not walk it. */
  const A_HOME = join(WORK, 'a-home-nothing-writes-to');
  /** Likewise a data directory, for the questions that need one named. */
  const A_DATA_DIR = join(WORK, 'a-data-directory-nothing-writes-to');
  const STAMP = '2026-08-21T09:00:11.123Z';

  /** The data directory the command is actually pointed at, and does create. */
  const DATA_HOME = join(WORK, 'a-users-data-directory');

  it('answers three platforms three different ways, and none of them is here', () => {
    const NOTHING_SET: NodeJS.ProcessEnv = {};
    const byPlatform = new Map<NodeJS.Platform, string>([
      ['win32', dataDir('win32', NOTHING_SET, A_HOME)],
      ['darwin', dataDir('darwin', NOTHING_SET, A_HOME)],
      ['linux', dataDir('linux', NOTHING_SET, A_HOME)],
    ]);

    const answers = [...byPlatform].map(([p, d]) => `${p} -> ${d}`).join('\n    ');
    assert.equal(
      new Set(byPlatform.values()).size,
      3,
      `three platforms gave ${new Set(byPlatform.values()).size} distinct ` +
        `answers, so at least two of them are being sent to the same place:` +
        `\n    ${answers}\n` +
        `  Each platform keeps per-user data somewhere of its own, and a pack ` +
        `in the wrong one of them is a pack nobody finds.`,
    );

    for (const [platform, dir] of byPlatform) {
      assert.ok(
        isAbsolute(dir),
        `${platform}: ${dir} is a relative path, so it names a different ` +
          `directory depending on where the terminal is standing`,
      );
      assert.ok(
        isInside(A_HOME, dir),
        `${platform}: ${dir} is not under the home directory it was handed ` +
          `(${A_HOME}), so it is being read from somewhere other than this ` +
          `function's arguments — and whatever that somewhere is, a test ` +
          `cannot point it anywhere safe.`,
      );
      assert.equal(
        isInside(process.cwd(), dir),
        false,
        `${platform}: the data directory came out inside the working ` +
          `directory (${process.cwd()}). A file that lands where the terminal ` +
          `happened to be standing is a file that gets committed by accident.`,
      );
    }
  });

  it('reads the variable each platform uses, and falls back to the home directory', () => {
    // Windows: LOCALAPPDATA, or AppData\Local under the home directory.
    assert.equal(dataDir('win32', { LOCALAPPDATA: A_DATA_DIR }, A_HOME), A_DATA_DIR);
    assert.equal(dataDir('win32', {}, A_HOME), join(A_HOME, 'AppData', 'Local'));
    assert.equal(
      dataDir('win32', { LOCALAPPDATA: '   ' }, A_HOME),
      join(A_HOME, 'AppData', 'Local'),
      'a variable set to nothing but spaces was taken for a directory name. ' +
        'The pack would land in a folder called "   " beside the working ' +
        'directory, or the write would fail with a path nobody can read.',
    );

    // Linux, and anything that is neither of the two above.
    assert.equal(dataDir('linux', { XDG_DATA_HOME: A_DATA_DIR }, A_HOME), A_DATA_DIR);
    assert.equal(dataDir('linux', {}, A_HOME), join(A_HOME, '.local', 'share'));

    // macOS reads neither variable. Worth pinning: it is the reason the
    // command below is redirected by moving HOME rather than by setting one,
    // and it means a Mac carrying a LOCALAPPDATA — a shell profile copied
    // between machines, a cross-platform toolchain — does not have its
    // evidence directory quietly moved by it.
    assert.equal(
      dataDir('darwin', { LOCALAPPDATA: A_DATA_DIR, XDG_DATA_HOME: A_DATA_DIR }, A_HOME),
      join(A_HOME, 'Library', 'Application Support'),
    );
  });

  it('puts the pack under the data directory, under a name a person can read', () => {
    const file = defaultOutputFile(7, STAMP, A_DATA_DIR);
    const name = basename(file);

    assert.ok(isAbsolute(file), `${file} is a relative path`);
    assert.ok(
      isInside(A_DATA_DIR, file),
      `${file} is not under the data directory it was handed (${A_DATA_DIR})`,
    );
    assert.equal(
      dirname(file),
      join(A_DATA_DIR, 'ledar', 'evidence'),
      'packs no longer land in a directory of their own beside the history. ' +
        'The point of the directory is that a person can be told "everything ' +
        'you have ever exported is in here" and have that be true.',
    );
    assert.match(
      name,
      /run7[^0-9]/,
      `"${name}" does not say which run it is about, so two packs on a ` +
        `desktop cannot be told apart without opening them`,
    );
    assert.ok(name.endsWith('.json'), `"${name}" is not named as the JSON it is`);

    // A colon is legal in an ISO timestamp and illegal in a Windows file name,
    // along with the rest of these. The failure would arrive as an unreadable
    // ENOENT on the platform most of this product's users are on.
    assert.equal(
      /[<>:"/\\|?*]/.test(name),
      false,
      `"${name}" holds a character Windows will not accept in a file name`,
    );
  });

  it('cannot give two exports the same name', () => {
    const a = defaultOutputFile(7, '2026-08-21T09:00:11.123Z', A_DATA_DIR);
    const b = defaultOutputFile(7, '2026-08-21T09:00:11.124Z', A_DATA_DIR);
    const c = defaultOutputFile(8, '2026-08-21T09:00:11.123Z', A_DATA_DIR);

    assert.notEqual(
      a,
      b,
      `two exports of run 7 one millisecond apart chose the same file: ` +
        `${a}. The overwrite barrier would refuse the second — correctly, and ` +
        `for a person who did nothing wrong — and the way past it is --force, ` +
        `which replaces a pack they may already have sent.`,
    );
    assert.notEqual(
      a,
      c,
      `runs 7 and 8 exported in the same millisecond chose the same file: ${a}`,
    );
  });

  it('does not move when the terminal does', () => {
    // The real platform and the real environment, no base handed in: the path
    // a person actually gets. Asking for it writes nothing — it is a string.
    const here = process.cwd();
    const before = defaultOutputFile(RUN_ID, STAMP);

    process.chdir(WORK);
    let after: string;
    try {
      after = defaultOutputFile(RUN_ID, STAMP);
    } finally {
      process.chdir(here);
    }

    assert.equal(
      after,
      before,
      `the default output path followed the working directory: ${before} ` +
        `became ${after}. Where a pack lands has to be a property of the ` +
        `machine, not of which directory somebody happened to be in.`,
    );
    assert.equal(
      isInside(here, before),
      false,
      `the default pack for run ${RUN_ID} would be written inside the working ` +
        `directory (${before})`,
    );
    assert.equal(
      isInside(REPO_ROOT, before),
      false,
      `the default pack for run ${RUN_ID} would be written inside this ` +
        `repository (${before}), which is the one place the command refuses ` +
        `to write when it is told to`,
    );
  });

  // ---- and now the command itself, with nobody telling it where -----------

  /** One export with no `--out`, read by the two tests after it. */
  let ran: Ran | undefined;
  let written: string | undefined;
  let writtenBytes: Buffer | undefined;

  before(async () => {
    ran = await runExport(`--run ${RUN_ID}`, HISTORY_DB, dataDirRedirectedTo(DATA_HOME));

    const printed = pathsPrinted(ran);
    if (printed.length === 1 && printed[0] !== undefined && existsSync(printed[0])) {
      written = printed[0];
      writtenBytes = readFileSync(printed[0]);
    }
  });

  it('writes the pack into the platform data directory, and says where', () => {
    assert.ok(ran, 'the export never ran');
    assert.equal(
      ran.code,
      0,
      `the export exited ${ran.code} with no --out, so the branch every other ` +
        `test in this file avoids is the branch that does not work.\n${said(ran)}`,
    );

    const printed = pathsPrinted(ran);
    assert.equal(
      printed.length,
      1,
      `the export printed ${printed.length} file paths. A person who did not ` +
        `pass --out has nowhere else to learn where their pack went: none is ` +
        `a pack they cannot find, two is a pack they have to guess at.\n${said(ran)}`,
    );

    const file = printed[0];
    assert.ok(file !== undefined, 'no path was printed');
    assert.ok(existsSync(file), `${file} was printed but nothing is there`);

    assert.ok(
      isInside(DATA_HOME, file),
      `the pack landed at ${file}, which is not under the data directory this ` +
        `run was given (${DATA_HOME}). On somebody's own machine that ` +
        `directory is %LOCALAPPDATA% — the pack is loose somewhere else.`,
    );
    assert.equal(
      isInside(REPO_ROOT, file),
      false,
      `the default output path landed inside this repository (${file})`,
    );
    assert.equal(
      isInside(process.cwd(), file),
      false,
      `the default output path landed inside the working directory (${file}), ` +
        `which is how a description of somebody's database gets committed`,
    );
    assert.ok(
      basename(file).includes(`run${RUN_ID}`),
      `"${basename(file)}" does not name the run it holds`,
    );

    // And it is the export, not an empty file that satisfies every assertion
    // above for the worst reason.
    const pack = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    assert.equal(pack['kind'], 'ledar.evidence-pack');
    assert.ok(Array.isArray(pack['findings']), 'the pack has no findings array');
    assert.equal(
      (pack['findings'] as unknown[]).length,
      2,
      `the pack written to the default path does not hold the two findings of ` +
        `run ${RUN_ID}`,
    );
  });

  it('exports the same run twice without landing on the first pack', async () => {
    assert.ok(written !== undefined, 'the first export wrote nothing to compare against');
    assert.ok(writtenBytes !== undefined, 'the first export was never read back');

    const second = await runExport(
      `--run ${RUN_ID}`,
      HISTORY_DB,
      dataDirRedirectedTo(DATA_HOME),
    );

    assert.equal(
      second.code,
      0,
      `exporting run ${RUN_ID} a second time exited ${second.code}. Nobody ` +
        `named a file either time, so there was no way for the user to avoid ` +
        `whatever this is refusing.\n${said(second)}`,
    );

    const printed = pathsPrinted(second);
    const file = printed[0];
    assert.equal(printed.length, 1, `the second export printed ${printed.length} paths`);
    assert.ok(file !== undefined, 'the second export printed no path');

    assert.notEqual(
      file,
      written,
      `both exports of run ${RUN_ID} chose ${file}. The overwrite barrier is ` +
        `the last line of defence, not the first — the name is supposed to ` +
        `make the collision impossible.`,
    );
    assert.ok(existsSync(file), `${file} was printed but nothing is there`);
    assert.ok(
      readFileSync(written).equals(writtenBytes),
      `${written} changed when the second export ran. The first pack may ` +
        `already have been sent to somebody, and it is now not the file they ` +
        `were told about.`,
    );
  });

  it('refuses the default path when the data directory sits in a git repository', async () => {
    // Somebody whose data directory is inside a checkout — a dotfiles
    // repository, a synced home directory that someone put under git. The
    // barrier walks up from the target, so it has to find this the same way it
    // finds a `--out` pointed into a working tree.
    const FAKE_REPO = join(WORK, 'a-repository-holding-a-data-directory');
    const DATA_IN_REPO = join(FAKE_REPO, 'local-data');
    mkdirSync(join(FAKE_REPO, '.git'), { recursive: true });

    const refused = await runExport(
      `--run ${RUN_ID}`,
      HISTORY_DB,
      dataDirRedirectedTo(DATA_IN_REPO),
    );

    assertRefused(refused, FAKE_REPO);

    // The refusal has to be about the pack, not about something else this
    // command dislikes: the message names the file it would have written, and
    // that name is the default one. Matched loosely on purpose — the shape of
    // the name is pinned three tests up, and a barrier test that goes red
    // because somebody moved a hyphen is a barrier test people learn to skip.
    assert.ok(
      refused.stderr.includes(`ledar-evidence-run${RUN_ID}`),
      `the export refused, but not about the default output file — so this ` +
        `test is passing for a refusal it did not set up.\n${said(refused)}`,
    );

    assert.equal(
      existsSync(join(DATA_IN_REPO, 'ledar', 'evidence')),
      false,
      `the export created its output directory inside a git repository ` +
        `before refusing`,
    );
  });

  it('looks for the history under the same data directory', async () => {
    // The other half of the default path, and unwatched for the same reason:
    // every test in this file names the history with LEDAR_HISTORY_DB. Take it
    // away and the command has to find `<data dir>/ledar/history.db` by
    // itself — and it says out loud which file it looked for, which is what
    // makes this measurable without a real history anywhere near it.
    const EMPTY = join(WORK, 'a-data-directory-with-no-history');
    const NEVER = join(WORK, 'no-history-at-all', 'pack.json');

    // `--out` is passed here, and this is the one test in this suite that
    // passes one. If the redirect below ever stopped working, this command
    // would find the operator's REAL history and export a run out of it;
    // `--out` is what keeps that hypothetical pack inside this directory.
    const refused = await runScript(
      `npm run export:evidence -- --run ${RUN_ID} --out "${NEVER}"`,
      { ...process.env, LEDAR_HISTORY_DB: undefined, ...dataDirRedirectedTo(EMPTY) },
      EXPORT_TIMEOUT_MS,
    );

    assertRefused(refused, join(EMPTY, 'ledar', 'history.db'));

    assert.equal(
      existsSync(NEVER),
      false,
      `${NEVER} was written from a history that does not exist`,
    );
  });

  it('wrote nothing into the real data directory on this machine', () => {
    // The claim the whole suite rests on, measured rather than promised. If a
    // future edit drops one of the redirects, a fabricated pack lands in
    // somebody's own evidence directory — and it lands looking exactly like
    // one of their own.
    assert.equal(
      existsSync(REAL_EVIDENCE_DIR),
      REAL_EVIDENCE_EXISTED,
      `${REAL_EVIDENCE_DIR} was created by this test file. It is where the ` +
        `person running these tests keeps the packs they exported themselves.`,
    );
    assert.deepEqual(
      realEvidenceListing(),
      REAL_EVIDENCE_BEFORE,
      `${REAL_EVIDENCE_DIR} does not hold what it held when this file ` +
        `started. Every export above is pointed at a temporary directory, so ` +
        `either one of those redirects stopped working or the command stopped ` +
        `reading it.`,
    );
  });
});
