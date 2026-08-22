/**
 * What changed since last time.
 *
 * This is the only reason the MVP gives anybody to come back a second time,
 * and the only thing the scan history was ever for. Everything difficult
 * about it is in `@ledar/store`'s `diffRuns`; this file is the part that
 * decides *which two runs* and prints the answer.
 *
 * Which two runs turned out to be the hard half.
 *
 * A history file is not one file. `openHistory` retires a file it cannot
 * speak to — `history.db` becomes `history.v1.db` and a fresh one takes its
 * place — so the runs a user has accumulated are scattered across however
 * many schema versions this product has been through. On the machine this was
 * written on that is three files and thirteen runs, twelve of them in files
 * the live store refuses to open, and a diff that looked only at the live one
 * would report *"there is only one run; there is nothing to compare"* while
 * standing in a directory holding a year of history.
 *
 * So the timeline is assembled across all of them, oldest to newest, and the
 * user is never asked to know that retirement happened. What they are told —
 * loudly, above the findings — is what the older file could not record, because
 * a schema-1 history cannot say which version of a rule produced a claim and
 * cannot have its structure fingerprints compared with today's.
 *
 *   npm run diff
 *   npm run diff -- --list
 *   npm run diff -- --run 3 --against v1:11
 *   npm run diff -- --all
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RetiredHistoryReader, ScanStore, diffRuns } from '@ledar/store';
import type { FindingChange, RunDiff, RunSnapshot, RunSummary } from '@ledar/store';

import { ledarDir } from './paths.js';

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A failure the user can act on, printed without a stack trace. */
class Refused extends Error {}

function historyFile(): string {
  const named = process.env.LEDAR_HISTORY_DB?.trim();
  return named ? resolve(named) : join(ledarDir(), 'history.db');
}

// ---- assembling one timeline out of however many files there are -----------

/**
 * A history file that is open, and the way to read a run out of it.
 *
 * The live store and a retired reader are kept apart here rather than behind
 * one interface, because they differ in the one way that matters at the end:
 * only one of them has to be closed carefully, and only one of them can be
 * written to at all.
 */
type Opened =
  | { kind: 'live'; path: string; store: ScanStore }
  | { kind: 'retired'; path: string; reader: RetiredHistoryReader };

type Entry = {
  /** What the user types to name this run. `7` live, `v1:11` retired. */
  handle: string;
  run: RunSummary;
  from: Opened;
};

/**
 * The retired siblings of a history file.
 *
 * `retiredName` produces `history.v1.db`, then `history.v1.2.db` if that is
 * taken. Matching on that shape rather than "every .db in the directory"
 * keeps this from adopting a file somebody else put there — and the reader
 * refuses anything that is not a LEDAR history anyway, so a false match costs
 * a skipped file and not a wrong answer.
 */
function retiredSiblings(live: string): string[] {
  const dir = dirname(resolve(live));
  if (!existsSync(dir)) return [];

  const name = basename(live);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const pattern = new RegExp(
    `^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.v\\d+(\\.\\d+)?${ext.replace(/\./g, '\\.')}$`,
  );

  return readdirSync(dir)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** `history.v1.2.db` → `v1.2`, which is what the user types. */
function handlePrefix(path: string, live: string): string {
  const name = basename(path);
  const stem = basename(live).split('.')[0] ?? '';
  // `v\\d+(\\.\\d+)?` rather than `v[\\d.]+?` — the lazy version stops at the
  // first dot, turning `history.v1.2.db` into the handle `v1`, which names a
  // different file that may also be sitting there.
  const match = new RegExp(`^${stem}\\.(v\\d+(?:\\.\\d+)?)\\.`).exec(name);
  return match?.[1] ?? name;
}

function openAll(live: string): Opened[] {
  const open: Opened[] = [];
  if (existsSync(live)) {
    try {
      open.push({ kind: 'live', path: live, store: ScanStore.open(live) });
    } catch {
      // The history at the live path is from an older schema — the state
      // between a version bump and the next `npm run scan`, which is when the
      // user is most likely to want a diff and least likely to get one.
      //
      // Read it, do not retire it. `openHistory` would rename the file and
      // start a fresh one, and this command has no business doing that: the
      // user asked what changed, not to have their history rotated. The
      // retired reader takes it read-only and nothing moves.
      try {
        open.push({ kind: 'retired', path: live, reader: RetiredHistoryReader.open(live) });
      } catch {
        // Not a history this build can read at all. The caller reports the
        // absence; a second failure raised here would replace a sentence the
        // user can act on with a stack trace.
      }
    }
  }
  for (const path of retiredSiblings(live)) {
    try {
      open.push({ kind: 'retired', path, reader: RetiredHistoryReader.open(path) });
    } catch {
      // A file that looks retired and is not readable as one is skipped, not
      // fatal. The alternative is a command that stops working because
      // something unrelated is sitting in the data directory.
    }
  }
  return open;
}

function closeAll(open: readonly Opened[]): void {
  for (const o of open) {
    try {
      if (o.kind === 'live') o.store.close();
      else o.reader.close();
    } catch {
      // Closing is cleanup. A failure here must not replace whatever the
      // command was actually reporting.
    }
  }
}

function runsIn(o: Opened, fingerprint: string): RunSummary[] {
  return o.kind === 'live'
    ? o.store.runsFor(fingerprint, 200)
    : o.reader.runsFor(fingerprint, 200);
}

function snapshotIn(o: Opened, runId: number): RunSnapshot | null {
  return o.kind === 'live' ? o.store.snapshotOf(runId) : o.reader.snapshotOf(runId);
}

/**
 * Every run across every file, for one database, oldest first.
 *
 * The fingerprint is settled before anything is listed, because a timeline
 * that mixed two databases would report each one's findings as the other's
 * appearing and disappearing.
 */
function timeline(open: readonly Opened[], live: string, want: string | null): Entry[] {
  const fingerprint = want ?? newestFingerprint(open);
  if (fingerprint === null) return [];

  const entries: Entry[] = [];
  for (const o of open) {
    const prefix =
      o.kind === 'live' || o.path === live ? '' : `${handlePrefix(o.path, live)}:`;
    for (const run of runsIn(o, fingerprint)) {
      entries.push({ handle: `${prefix}${run.runId}`, run, from: o });
    }
  }
  entries.sort((a, b) =>
    a.run.startedAt === b.run.startedAt
      ? a.run.runId - b.run.runId
      : a.run.startedAt.localeCompare(b.run.startedAt),
  );
  return entries;
}

/**
 * Which database this history is mostly about.
 *
 * The newest run in any of the files wins. A history that holds two databases
 * — the fixture and the real one, which is the ordinary case on a developer's
 * machine — needs *a* default, and the one they scanned last is the one they
 * are asking about.
 */
function newestFingerprint(open: readonly Opened[]): string | null {
  let best: RunSummary | null = null;
  for (const o of open) {
    const runs = o.kind === 'live' ? o.store.everyRun(200) : o.reader.runs(200);
    for (const run of runs) {
      if (best === null || run.startedAt > best.startedAt) best = run;
    }
  }
  return best?.fingerprint ?? null;
}

// ---- printing --------------------------------------------------------------

/** `2026-08-22T05:00:44.063Z` → `2026-08-22 05:00`, which is what people read. */
function when(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

function describe(entry: Entry): string {
  // The schema version is printed only when it is not the current one. On the
  // ordinary path it is noise; on the path where half the timeline came out of
  // a retired file it is the reason two rows are allowed to disagree.
  const schema =
    entry.from.kind === 'live'
      ? ''
      : ` · schema ${entry.from.reader.source.schemaVersion}`;
  return `run ${entry.handle}  ${when(entry.run.startedAt)}  ${entry.run.label}  (${basename(entry.from.path)}${schema})`;
}

const HEADINGS: readonly { verdict: FindingChange['verdict']; title: string }[] = [
  { verdict: 'appeared', title: 'New' },
  { verdict: 'worsened', title: 'Worse' },
  { verdict: 'structure-changed', title: 'Changed shape' },
  { verdict: 'disappeared', title: 'No longer reported' },
  { verdict: 'improved', title: 'Better' },
  { verdict: 'unchanged', title: 'Unchanged' },
];

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length <= width) line = `${line} ${word}`;
    else {
      lines.push(indent + line);
      line = word;
    }
  }
  if (line !== '') lines.push(indent + line);
  return lines;
}

function report(diff: RunDiff, from: Entry, to: Entry, showUnchanged: boolean): string[] {
  const out: string[] = [];
  out.push('');
  out.push(`  Comparing ${to.run.label}`);
  out.push(`    from  ${describe(from)}`);
  out.push(`    to    ${describe(to)}`);
  out.push('');

  if (diff.cautions.length > 0) {
    // Above the numbers, never below. A caution read after the list is a
    // caution that arrives too late to change how the list was read.
    out.push('  Read this before the list');
    for (const caution of diff.cautions) {
      out.push(...wrap(caution, 72, '      '));
      out.push('');
    }
  }

  for (const { verdict, title } of HEADINGS) {
    const rows = diff.changes.filter((c) => c.verdict === verdict);
    if (rows.length === 0) continue;

    if (verdict === 'unchanged' && !showUnchanged) {
      out.push(`  ${title} (${rows.length}) — pass --all to list them`);
      out.push('');
      continue;
    }

    out.push(`  ${title} (${rows.length})`);
    for (const row of rows) {
      out.push(`    ${row.findingKey}`);
      out.push(...wrap(row.says, 68, '        '));
    }
    out.push('');
  }

  if (diff.changes.length === 0) {
    out.push('  Neither run reported anything. That is not the same as a clean');
    out.push('  database — check the coverage lines a scan prints.');
    out.push('');
  }

  if (diff.ruleGaps.length > 0) {
    out.push('  Rules that did not do the same work in both runs');
    for (const gap of diff.ruleGaps) {
      out.push(...wrap(gap.says, 72, '      '));
      out.push('');
    }
  }

  out.push('  What a comparison like this cannot see');
  for (const limit of diff.identityLimits) {
    out.push(...wrap(limit, 72, '      '));
  }
  out.push('');
  return out;
}

function listing(entries: readonly Entry[]): string[] {
  const out = ['', `  ${entries.length} run${entries.length === 1 ? '' : 's'}, oldest first`, ''];
  for (const entry of entries) {
    out.push(`    ${describe(entry)}  ${entry.run.findingCount} finding${entry.run.findingCount === 1 ? '' : 's'}`);
  }
  out.push('');
  out.push('  npm run diff -- --run <handle> --against <handle>');
  out.push('');
  return out;
}

// ---- the command ------------------------------------------------------------

type Args = { run: string | null; against: string | null; list: boolean; all: boolean };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { run: null, against: null, list: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--all') args.all = true;
    else if (arg === '--run' || arg === '--against') {
      const value = argv[(i += 1)];
      if (value === undefined || value === '') {
        throw new Refused(`${arg} takes a run handle. Run \`npm run diff -- --list\` to see them.`);
      }
      if (arg === '--run') args.run = value;
      else args.against = value;
    } else {
      throw new Refused(
        `I do not know what \`${String(arg)}\` means.\n\n` +
          `  npm run diff -- [--run <handle>] [--against <handle>] [--list] [--all]`,
      );
    }
  }
  return args;
}

function find(entries: readonly Entry[], handle: string): Entry {
  const found = entries.find((e) => e.handle === handle);
  if (found === undefined) {
    throw new Refused(
      `There is no run \`${handle}\` in this history.\n\n` +
        `  Run \`npm run diff -- --list\` to see the runs there are. A run in a\n` +
        `  retired history file is named like \`v1:11\`, not \`11\`.`,
    );
  }
  return found;
}

function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  const live = historyFile();
  const open = openAll(live);

  try {
    if (open.length === 0) {
      throw new Refused(
        `There is no scan history at ${live}.\n\n` +
          `  Run \`npm run scan\` at least twice; a comparison needs two runs.`,
      );
    }

    const entries = timeline(open, live, null);

    if (args.list) {
      console.log(listing(entries).join('\n'));
      return 0;
    }

    if (entries.length < 2) {
      throw new Refused(
        `There ${entries.length === 1 ? 'is 1 run' : 'are no runs'} recorded for this ` +
          `database, and a comparison needs two.\n\n` +
          `  Run \`npm run scan\` again, then come back.`,
      );
    }

    const to = args.run === null ? entries[entries.length - 1]! : find(entries, args.run);
    const from =
      args.against === null
        ? entries[entries.indexOf(to) - 1] ?? entries[entries.length - 2]!
        : find(entries, args.against);

    if (from.handle === to.handle) {
      throw new Refused(
        `\`${to.handle}\` compared against itself reports that nothing changed, ` +
          `which is true and useless.`,
      );
    }

    const beforeSnapshot = snapshotIn(from.from, from.run.runId);
    const afterSnapshot = snapshotIn(to.from, to.run.runId);
    if (beforeSnapshot === null || afterSnapshot === null) {
      throw new Refused(`One of those runs could not be read back out of its file.`);
    }

    console.log(report(diffRuns(beforeSnapshot, afterSnapshot), from, to, args.all).join('\n'));
    return 0;
  } finally {
    closeAll(open);
  }
}

/**
 * Whether this file is being run as a command rather than imported.
 *
 * Same guard, and same reasoning, as `export-evidence.ts`: a test that
 * imports this module to ask what `retiredSiblings` returns must not have
 * opened the operator's real history and printed a diff as a side effect of
 * the import.
 */
function runningAsCommand(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;

  const self = fileURLToPath(import.meta.url);
  if (resolve(entry) === self) return true;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}

export { handlePrefix, retiredSiblings };

if (runningAsCommand()) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err: unknown) {
    console.error('');
    console.error(`  ${err instanceof Refused ? err.message : why(err)}`);
    console.error('');
    process.exit(err instanceof Refused ? 1 : 2);
  }
}
