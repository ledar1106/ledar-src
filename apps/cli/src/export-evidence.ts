/**
 * Writes one recorded scan out as an Evidence Pack.
 *
 * This is the command that makes rule 6 of AGENTS.md §3 mean something. Until
 * it existed nothing in this product had ever sent a byte anywhere, so *"no
 * real data leaves the user's machine outside a redacted Evidence Pack"* was
 * true the way a locked door in a house with no walls is true. A file the user
 * can hand to their DBA is the first wall.
 *
 * It is deliberately its own entry point rather than a flag on `scan`. Two
 * reasons, and the second is the one that matters:
 *
 *   - Exporting reads the local history file. It never connects to a database,
 *     so it works on a laptop that cannot reach the server, and it cannot cost
 *     anybody's production system a query.
 *   - Sharing is a decision. A scan that quietly left an exportable file
 *     behind would make that decision on the user's behalf, and the whole
 *     point of the pack is that it exists because somebody chose to make one.
 *
 * The gate is `buildEvidencePack` in `@ledar/contracts`. Nothing here decides
 * what may leave — this file decides *where it lands*, which is the other half
 * of the same problem: a pack written into a git repository is a pack that
 * gets pushed.
 *
 *   npm run export:evidence -- --run 7
 *   npm run export:evidence -- --run 7 --out C:\Users\me\Desktop\pack.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildEvidencePack,
  serializeEvidencePack,
  type ScanResult,
} from '@ledar/contracts';
import type { DatabaseIdentity, RunSummary, ScanStore } from '@ledar/store';

import { dataDir, ledarDir, runningAsCommand } from './paths.js';

/**
 * Re-exported because this module's own tests reach for it here, and because
 * a reader following `defaultOutputFile` should not have to guess where the
 * platform rule went. `./paths.js` is the one definition.
 */
export { dataDir };

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A failure the user can act on, printed without a stack trace. */
class Refused extends Error {}

// ---- where things live -----------------------------------------------------

/**
 * Where the history this pack is built from already lives.
 *
 * `scan.ts` computes the same path. It gets it from the same `ledarDir()` now:
 * this file used to carry its own copy of the three platform branches, with a
 * docstring admitting the copy and saying the right home was "a shared place
 * neither slice owns yet". `./paths.js` is that place. The copies were not
 * merely redundant, they were guarded unevenly — this one grew property tests
 * and the one in `scan.ts` had none — and the unguarded copy is the one that
 * drifts.
 */
function historyFile(): string {
  const named = process.env.LEDAR_HISTORY_DB?.trim();
  return named ? resolve(named) : join(ledarDir(), 'history.db');
}

/**
 * Refuses to write anywhere inside a git repository.
 *
 * Not "inside *this* repository" — inside any of them. A pack holds table
 * names, column names, role names and counts: a description of somebody's
 * system, which `notice.contains` in the pack itself says out loud. Dropped
 * into a working tree it is one `git add .` from being public, and the person
 * who typed `--out .` was thinking about where the file was easy to find, not
 * about what was in it.
 *
 * Walks up from the target directory looking for `.git`, which catches the
 * user's own projects as well as this one.
 */
function assertOutsideAnyRepository(file: string): void {
  let dir = dirname(resolve(file));
  const { root } = parse(dir);

  for (;;) {
    if (existsSync(join(dir, '.git'))) {
      throw new Refused(
        `${file} is inside the git repository at ${dir}.\n\n` +
          `  An Evidence Pack names tables, columns and roles — it is a\n` +
          `  description of a database somebody owns. A file in a working\n` +
          `  tree is one \`git add .\` away from being published, and this\n` +
          `  one is not yours to publish.\n\n` +
          `  Write it somewhere outside the repository, or leave --out off\n` +
          `  and it will land beside the scan history.`,
      );
    }
    const up = dirname(dir);
    if (up === dir || dir === root) return;
    dir = up;
  }
}

/**
 * Where a pack lands when the user did not say where.
 *
 * Under the platform's data directory, beside the history it was built from,
 * and never in the working directory: a file that lands wherever the terminal
 * happened to be standing is a file that gets committed by accident, and this
 * one describes somebody's database. `scan.ts` puts the history there for the
 * same reason.
 *
 * The name carries the run number so two packs can be told apart, and the
 * generation timestamp so a second export of the same run cannot land on the
 * first. That is not the overwrite barrier — `wx` further down is, and it
 * covers this path exactly as it covers `--out` — it is the reason somebody
 * re-exporting a run never has to meet it.
 *
 * `base` is a parameter for the reason `dataDir` takes three: so the rule can
 * be read back without writing into the directory it names.
 */
export function defaultOutputFile(
  runId: number,
  generatedAt: string,
  base: string = dataDir(),
): string {
  // Colons are legal in an ISO timestamp and illegal in a Windows filename.
  const stamp = generatedAt.replace(/[:.]/g, '-');
  return join(base, 'ledar', 'evidence', `ledar-evidence-run${runId}-${stamp}.json`);
}

// ---- reading the history ---------------------------------------------------

/**
 * Opens the history store, quietly.
 *
 * The same dance `scan.ts` does: `node:sqlite` announces that it is
 * experimental the moment it loads, which is true, worth knowing once, and not
 * worth stapling across the top of a file somebody is about to email.
 */
async function openStore(file: string): Promise<ScanStore> {
  if (!existsSync(file)) {
    throw new Refused(
      `There is no scan history at ${file}.\n\n` +
        `  An Evidence Pack is built from a run that was recorded. Run\n` +
        `  \`npm run scan\` first — it prints the run number when it finishes.\n` +
        `  \`LEDAR_HISTORY_DB\` names a different history file.`,
    );
  }

  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: unknown, ...rest: unknown[]): void => {
    const text = warning instanceof Error ? warning.message : String(warning);
    const name =
      warning instanceof Error
        ? warning.name
        : rest.find((r) => typeof r === 'string');
    if (name === 'ExperimentalWarning' && /sqlite/i.test(text)) return;
    (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;

  try {
    const { ScanStore } = await import('@ledar/store');
    return ScanStore.open(file);
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * Which database the newest run belongs to, when no run was named.
 *
 * The history is keyed by a fingerprint of host, port and database name, so
 * finding "the last run" needs to know which database is meant. This reads the
 * DSN exactly as `scan.ts` does and derives the same three parts from it —
 * host and port out of the URL, name out of its path.
 *
 * The DSN is never printed, never stored and never reaches the pack: only the
 * hostname, the port and the database name are read back out of the parsed
 * URL, so the password stays inside this function. Returns null rather than
 * guessing; the caller then asks for `--run`.
 */
function identityFromEnvironment(repoEnvFile: string): DatabaseIdentity | null {
  let dsn = process.env.TEST_PG_DSN?.trim();
  if (!dsn) {
    try {
      const text = readFileSync(repoEnvFile, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = /^\s*TEST_PG_DSN\s*=\s*(.+)$/.exec(line);
        if (m?.[1]) {
          dsn = m[1].trim();
          break;
        }
      }
    } catch {
      return null;
    }
  }
  if (!dsn) return null;

  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;

  const socket = url.searchParams.get('host');
  const host = socket !== null && socket !== '' ? socket : url.hostname;
  if (host === '') return null;

  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port <= 0) return null;

  const database = url.pathname.replace(/^\//, '');
  if (database === '') return null;

  return { host, port, database };
}

const NO_RUN_NAMED =
  `Which run should be exported?\n\n` +
  `  Every scan prints its run number when it finishes:\n` +
  `    history: recorded as run 7 in ...\n\n` +
  `  Pass it:  npm run export:evidence -- --run 7\n\n` +
  `  Without --run this looks up the newest run for the database named by\n` +
  `  TEST_PG_DSN, and there is no usable DSN in the environment or in\n` +
  `  infra/.env.`;

function chooseRun(store: ScanStore, runId: number | null, envFile: string): RunSummary {
  if (runId !== null) {
    const run = store.runById(runId);
    if (run === null) {
      throw new Refused(
        `There is no run ${runId} in ${historyFile()}.\n\n` +
          `  Run numbers are printed at the end of every scan.`,
      );
    }
    return run;
  }

  const identity = identityFromEnvironment(envFile);
  if (identity === null) throw new Refused(NO_RUN_NAMED);

  const runs = store.runsFor(identity, 1);
  const newest = runs[0];
  if (newest === undefined) {
    throw new Refused(
      `No run has been recorded for ${identity.database} yet.\n\n` +
        `  Run \`npm run scan\` first, then export the run number it prints.`,
    );
  }
  return newest;
}

// ---- the export ------------------------------------------------------------

function scanResultOf(store: ScanStore, run: RunSummary): ScanResult {
  if (run.finishedAt === null || run.outcome === 'running') {
    throw new Refused(
      `Run ${run.runId} never finished, so there is nothing honest to export.\n\n` +
        `  A run left in the \`running\` state is one whose process died\n` +
        `  before it could say how it went. Findings missing from it may be\n` +
        `  missing because a rule never got to run, and that looks exactly\n` +
        `  like a rule that found nothing. Exporting it would hand somebody\n` +
        `  a clean-looking report of a scan that did not happen.`,
    );
  }

  return {
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    scope: run.scope,
    findings: store.findingsOf(run.runId).map((stored) => stored.finding),
  };
}

type Args = { runId: number | null; out: string | null; force: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { runId: null, out: null, force: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      args.force = true;
    } else if (arg === '--run') {
      const value = Number(argv[(i += 1)]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Refused('--run takes the run number a scan printed, e.g. --run 7.');
      }
      args.runId = value;
    } else if (arg === '--out') {
      const value = argv[(i += 1)];
      if (value === undefined || value === '') {
        throw new Refused('--out takes a file path.');
      }
      args.out = value;
    } else {
      throw new Refused(
        `I do not know what \`${String(arg)}\` means.\n\n` +
          `  npm run export:evidence -- [--run <id>] [--out <file>] [--force]`,
      );
    }
  }

  return args;
}

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const file = historyFile();
  // `infra/.env` is looked up from the working directory rather than from this
  // module's location: an installed copy of LEDAR has no repository around it,
  // and reaching three levels up from `dist/` would land somewhere arbitrary.
  const envFile = resolve(process.cwd(), 'infra/.env');

  const store = await openStore(file);
  let out: string;
  let packText: string;
  let findingCount: number;
  let runId: number;

  try {
    const run = chooseRun(store, args.runId, envFile);
    runId = run.runId;
    const result = scanResultOf(store, run);
    findingCount = result.findings.length;

    const generatedAt = new Date().toISOString();
    const pack = buildEvidencePack(result, {
      generatedAt,
      // Taken from the run, not assumed. A failed run that exported as
      // `completed` would be the same lie as an empty result reported as a
      // clean one.
      runOutcome: run.outcome === 'running' ? 'unknown' : run.outcome,
      truncated: run.costTruncated,
      disclosureShownLocally: run.scope.disclosure !== null,
    });

    packText = serializeEvidencePack(pack);
    out = resolve(args.out ?? defaultOutputFile(run.runId, generatedAt));
  } finally {
    store.close();
  }

  assertOutsideAnyRepository(out);
  mkdirSync(dirname(out), { recursive: true });

  try {
    // `wx` — create, or fail. Not a check followed by a write: between those
    // two steps a file can appear, and the one it would overwrite is somebody
    // else's export.
    writeFileSync(out, packText, { encoding: 'utf8', flag: args.force ? 'w' : 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Refused(
        `${out} already exists.\n\n` +
          `  Nothing was written. Two exports of two different scans under one\n` +
          `  name is how the wrong one gets sent. Choose another --out, or\n` +
          `  pass --force if replacing that file is what you meant.`,
      );
    }
    throw err;
  }

  console.log('');
  console.log(`  Wrote an Evidence Pack for run ${runId}.`);
  console.log('');
  console.log(`    ${out}`);
  console.log('');
  console.log(`    ${findingCount} finding${findingCount === 1 ? '' : 's'}, the scope they`);
  console.log(`    were found in, and the coverage behind each one.`);
  console.log('');
  console.log('  WHAT IS IN IT');
  console.log('');
  console.log('    Table, column, schema and role names. Counts. The shapes of');
  console.log('    sampled values — <uuid>, <text:14> — never the values.');
  console.log('');
  console.log('  WHAT IS NOT');
  console.log('');
  console.log('    No row values. No connection string, host, port or password.');
  console.log('    None of the sentences printed on screen: those are built by');
  console.log('    rule code out of whatever it had to hand, including database');
  console.log('    error messages, which quote values back.');
  console.log('');
  console.log('    The file says all of this itself, under `notice`. Read it');
  console.log('    before sending — this pack describes your database, and');
  console.log('    deciding who sees that is your decision, not this tool\u2019s.');
  console.log('');

  return 0;
}


if (runningAsCommand(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error('');
      console.error(`  ${err instanceof Refused ? err.message : why(err)}`);
      console.error('');
      process.exit(err instanceof Refused ? 1 : 2);
    },
  );
}
