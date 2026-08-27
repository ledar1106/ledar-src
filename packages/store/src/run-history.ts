/**
 * The scan's own record of itself, which is never allowed to break the scan.
 *
 * Writing history is secondary work: a database the scan could read is a
 * report the user should get, whether or not a local file could be opened.
 * Every call here swallows its failure — and then says so out loud in the
 * report, because a history that silently stopped being written is how a diff
 * six months from now comes to compare against a run that does not exist.
 *
 * ## Why it moved here on 2026-08-27
 *
 * It lived inside `apps/cli/src/scan.ts`, which meant the desktop shell could
 * not write a run at all — and the desktop MUST write to the same file the
 * CLI writes to, or `diffRuns` reads a timeline with a seam in it that
 * nothing marks. Copying the class into the desktop was the other option and
 * it is the one this repository has already been burned by twice (see
 * `paths.ts`), so the class moved to the package that owns the file.
 *
 * The one signature change: `open` takes `lang` rather than reading it from
 * the environment. A package that reads `process.env` to decide what language
 * to speak is a package that cannot be asked to speak another one, and the
 * desktop asks.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { translator } from '@ledar/contracts';
import type { Finding, Lang, ScopeManifest } from '@ledar/contracts';

import { historyFile } from './paths.js';
import type { OpenedHistory, RetiredHistory } from './retire.js';
import type { ScanStore } from './store.js';
// `ScanCost`, not `BudgetSpend`. types.ts says why in its header: taking that
// import would drag the `pg` driver into a package whose whole job is writing
// a local file, and a scan history should be readable on a machine that
// cannot reach the database it describes. The two shapes are identical, so a
// caller holding a BudgetSpend satisfies this structurally.
import type { DatabaseIdentity, RuleRun, ScanCost } from './types.js';

/** The message this build shows for a failure it has to keep going past. */
function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Which database this run belongs to, without the parts that unlock it.
 *
 * `new URL` is the redaction: only `hostname` and `port` are read back out of
 * it, so the password never leaves this function. The database name comes from
 * `current_database()` rather than from the DSN path — they can disagree, and
 * the server's answer is the true one.
 *
 * Returns null rather than a guess. Two databases filed under one identity
 * merge into a single timeline, and the diff drawn across that seam would be
 * confidently wrong about every finding in it.
 */
export function identityFrom(dsn: string, database: string): DatabaseIdentity | null {
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return null;
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;

  // A `host` query parameter is how a URL-form DSN names a unix socket
  // directory, and libpq — so also `pg` — lets it override the host in the
  // authority. Reading the hostname and ignoring this would file the run
  // against a server the scan was never connected to.
  const socket = url.searchParams.get('host');
  const host = socket !== null && socket !== '' ? socket : url.hostname;
  if (host === '') return null;

  const port = url.port === '' ? 5432 : Number(url.port);
  if (!Number.isInteger(port) || port <= 0) return null;

  return { host, port, database };
}

/**
 * Loads the history store, or fails in a way the caller can report.
 *
 * `node:sqlite` announces that it is experimental the moment it loads, which
 * is true, worth knowing once, and not worth stapling across the top of
 * somebody's report. Exactly that one warning is dropped, only while the
 * module loads; the original emitter goes straight back.
 *
 * ⚠️ The suppression is best-effort and always was: anything that has already
 * imported this package statically has loaded sqlite before reaching here, so
 * the warning has been and gone. It is kept because it still works for the
 * path that matters — a caller whose first touch of the store is a scan.
 */
async function openStore(file: string): Promise<OpenedHistory> {
  mkdirSync(dirname(file), { recursive: true });

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
    // `openHistory`, not `ScanStore.open`. The difference is what happens to a
    // file written by an older schema: `ScanStore.open` refuses it and leaves
    // the user holding a path they have never heard of, which is how the
    // default history path came to be dead on the machine that shipped the
    // version bump. This moves the old file aside, keeps it, and hands back
    // the receipt so `lines()` can say where it went.
    const { openHistory } = await import('./retire.js');
    return openHistory(file);
  } finally {
    process.emitWarning = emitWarning;
  }
}

export class RunHistory {
  private store: ScanStore | null = null;
  private file = '';
  /** The run currently open. Cleared once it is closed, or once it breaks. */
  private runId: number | null = null;
  /** The run's number, kept after it closes so the report can name it. */
  private recorded: number | null = null;
  private problem: string | null = null;
  /**
   * A history file this build could not read, moved aside so this one could
   * start. Reported whether or not anything else about the run went well: a
   * file that moves without being mentioned is its own kind of data loss.
   */
  private retired: RetiredHistory | null = null;
  private t: ReturnType<typeof translator> = translator('en');

  static async open(
    dsn: string,
    scope: ScopeManifest,
    lang: Lang = 'en',
  ): Promise<RunHistory> {
    const history = new RunHistory();
    history.t = translator(lang);

    const identity = identityFrom(dsn, scope.database);
    if (identity === null) {
      history.problem =
        'the connection string is not in postgresql://host:port/name form, so ' +
        'there is no way to say which server this database is on without ' +
        'guessing at it';
      return history;
    }

    history.file = historyFile();
    try {
      const opened = await openStore(history.file);
      history.store = opened.store;
      history.retired = opened.retired;
      const store = history.store;
      history.runId = store.openRun({
        database: identity,
        scope,
        // Debt N44. Written so a later reader can explain a history holding
        // two languages, not so anything can branch on it: identity and the
        // diff never read prose, and they still do not.
        lang,
        // Rule 6: no real data leaves the user's machine, and a sample row
        // written to a file people attach to bug reports has already left.
        // The store defaults this off; it is passed anyway so the choice is
        // visible at the call site rather than inherited from somewhere else.
        storeSamples: false,
      });
      history.recorded = history.runId;
    } catch (err) {
      // The file is named because the failure is usually about the file, and
      // sqlite's own wording ("unable to open database file") does not say
      // which one it could not open.
      history.problem = `${why(err)} (${history.file})`;
      history.stop();
    }

    return history;
  }

  private stop(): void {
    try {
      this.store?.close();
    } catch {
      // Already broken. The first failure is the one worth reporting.
    }
    this.store = null;
    this.runId = null;
  }

  private guard(body: (store: ScanStore, runId: number) => void): void {
    if (this.store === null || this.runId === null) return;
    try {
      body(this.store, this.runId);
    } catch (err) {
      this.problem = why(err);
      this.stop();
    }
  }

  add(findings: readonly Finding[]): void {
    this.guard((store, runId) => store.recordFindings(runId, findings));
  }

  /**
   * What each rule covered, including the rules that found nothing.
   *
   * `add` already records that a rule ran when it produced a finding. This is
   * for the other case, which is the one that matters: a rule that returned
   * nothing and a rule that never got to run leave the same empty space, and
   * only one of them means the database is clean.
   */
  cover(rules: readonly RuleRun[]): void {
    this.guard((store, runId) => store.recordRules(runId, rules));
  }

  complete(cost: ScanCost, truncationNote: string | null): void {
    this.guard((store, runId) => {
      store.finishRun(runId, { outcome: 'completed', cost, truncationNote });
      this.stop();
    });
  }

  /**
   * Closes the run as failed, so it is not read later as a clean scan.
   *
   * The cost is what had been spent by the time it broke, not zero. A run
   * that cost the database two hundred queries before it fell over is worth
   * seeing as exactly that.
   */
  failed(err: unknown, cost: ScanCost): void {
    this.guard((store, runId) => {
      store.finishRun(runId, {
        outcome: 'failed',
        note: why(err),
        cost,
      });
      this.stop();
    });
  }

  /** The run number, once one exists. Null when nothing was recorded. */
  runNumber(): number | null {
    return this.recorded;
  }

  /**
   * What happened to a history file this build could not read.
   *
   * Printed before everything else this class has to say, and printed even
   * when the rest of it went fine, because it is the only notice the user will
   * ever get that a file they own is now somewhere else. The old runs are named
   * as a count rather than described: they are unreadable to this build, and
   * summarising what is in them would be claiming to have read them.
   */
  private retirementLines(): string[] {
    if (this.retired === null) return [];
    const r = this.retired;
    const held =
      r.runs === null
        ? this.t('history.holds-uncounted')
        : this.t('history.holds-runs', { runs: r.runs });

    return [
      this.t('history.moved', { version: r.version, to: r.to, held }),
      this.t('history.delete-freely'),
    ];
  }

  /** Said in the report either way. Silence would be the one bad answer. */
  lines(): string[] {
    const moved = this.retirementLines();

    if (this.problem === null) {
      return [
        ...moved,
        // `?? 0` for the same reason as below: with no problem recorded there
        // is always a run number, but that is an invariant of how the two
        // fields are set together rather than one the type carries.
        this.t('history.recorded', { run: this.recorded ?? 0, file: this.file }),
      ];
    }

    if (this.recorded === null) {
      return [
        ...moved,
        this.t('history.not-recorded', { problem: this.problem }),
      ];
    }

    // A row exists and says `running`, which is what it is. The store keeps
    // that state on purpose so a half-written run is never mistaken for a
    // clean one later.
    return [
      ...moved,
      this.t('history.unfinished', {
        // Reached only when `recorded` is non-null - the branch above returns
        // for the null case - but the compiler cannot see that across the two
        // `if`s, and asserting it away would outlive the shape that makes it
        // true.
        run: this.recorded ?? 0,
        file: this.file,
        problem: this.problem,
      }),
    ];
  }
}
