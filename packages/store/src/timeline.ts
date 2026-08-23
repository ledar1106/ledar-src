/**
 * One history out of however many files it actually lives in.
 *
 * `openHistory` retires a file this build cannot speak to — `history.db`
 * becomes `history.v1.db` and a fresh one takes its place — so a user's runs
 * end up scattered across as many files as this product has had schema
 * versions. Anything that wants to compare two runs has to gather them first,
 * and on the machine this was written that means three files and thirteen
 * runs, twelve of them in files the live store refuses to open.
 *
 * This lived inside `apps/cli/src/diff.ts` until a second caller needed it.
 * That file mixed two jobs — assembling the timeline, and printing it — and
 * only the second is a command-line concern. Leaving the first there would
 * have meant the engine growing its own copy, which is how two answers to the
 * same question start disagreeing about which runs exist.
 *
 * Read-only throughout. Nothing here writes, renames, or retires: a caller
 * asked what changed, not to have their history rotated.
 */

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { RetiredHistoryReader } from './legacy.js';
import { ScanStore } from './store.js';
import type { RunSnapshot, RunSummary } from './types.js';

/**
 * A history file that is open, and the way to read a run out of it.
 *
 * The live store and a retired reader are kept apart rather than behind one
 * interface, because they differ in the way that matters at the end: only one
 * of them can be written to at all.
 */
type Opened =
  | { kind: 'live'; path: string; store: ScanStore }
  | { kind: 'retired'; path: string; reader: RetiredHistoryReader };

export type TimelineEntry = {
  /** What a caller names this run: `7` when live, `v1:11` when retired. */
  handle: string;
  run: RunSummary;
  /** The file it came out of, and the schema that wrote it. */
  source: { path: string; schemaVersion: number | null };
};

/**
 * The retired siblings of a history file.
 *
 * `retiredName` produces `history.v1.db`, then `history.v1.2.db` if that is
 * taken. Matching that shape rather than "every .db in the directory" keeps
 * this from adopting a file somebody else put there — and the reader refuses
 * anything that is not a LEDAR history anyway, so a false match costs a
 * skipped file rather than a wrong answer.
 */
export function retiredSiblings(live: string): string[] {
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

/** `history.v1.2.db` → `v1.2`, which is what a caller types. */
export function handlePrefix(path: string, live: string): string {
  const name = basename(path);
  const stem = basename(live).split('.')[0] ?? '';
  // `v\d+(\.\d+)?` rather than `v[\d.]+?` — the lazy version stops at the
  // first dot, turning `history.v1.2.db` into the handle `v1`, which names a
  // different file that may also be sitting there.
  const match = new RegExp(`^${stem}\\.(v\\d+(?:\\.\\d+)?)\\.`).exec(name);
  return match?.[1] ?? name;
}

/**
 * Every run a user has, gathered from every file that holds one.
 *
 * `close()` is the caller's job and is not optional: a SQLite handle left open
 * holds a lock on the file, and on Windows that costs the user their history
 * until the process exits.
 */
export class HistoryTimeline {
  private constructor(
    private readonly live: string,
    private readonly open: readonly Opened[],
  ) {}

  /**
   * Opens the live history and every retired sibling beside it.
   *
   * Never throws for a file it cannot read. A history directory is a place
   * other things also live, and a command that stops working because
   * something unrelated is sitting there is worse than one that reads what it
   * can — the caller is told what was found, and `isEmpty` says when that was
   * nothing.
   */
  static open(live: string): HistoryTimeline {
    const open: Opened[] = [];

    if (existsSync(live)) {
      try {
        open.push({ kind: 'live', path: live, store: ScanStore.open(live) });
      } catch {
        // The file at the live path is from an older schema — the window
        // between a version bump and the next scan, which is when somebody is
        // most likely to ask what changed and least likely to get an answer.
        //
        // Read it, do not retire it. `openHistory` would rename the file and
        // start a fresh one, and nothing here has the standing to do that.
        try {
          open.push({ kind: 'retired', path: live, reader: RetiredHistoryReader.open(live) });
        } catch {
          // Not a history this build can read at all. `isEmpty` reports it.
        }
      }
    }

    for (const path of retiredSiblings(live)) {
      try {
        open.push({ kind: 'retired', path, reader: RetiredHistoryReader.open(path) });
      } catch {
        // Looks retired, is not readable as one. Skipped, not fatal.
      }
    }

    return new HistoryTimeline(live, open);
  }

  get isEmpty(): boolean {
    return this.open.length === 0;
  }

  /** Every history file this timeline is reading from. */
  get files(): readonly string[] {
    return this.open.map((o) => o.path);
  }

  /**
   * Which database this history is mostly about.
   *
   * The newest run in any file wins. A history holding two databases — the
   * fixture and the real one, which is the ordinary case on a developer's
   * machine — needs *a* default, and the one scanned last is the one being
   * asked about.
   */
  newestFingerprint(): string | null {
    let best: RunSummary | null = null;
    for (const o of this.open) {
      const runs = o.kind === 'live' ? o.store.everyRun(200) : o.reader.runs(200);
      for (const run of runs) {
        if (best === null || run.startedAt > best.startedAt) best = run;
      }
    }
    return best?.fingerprint ?? null;
  }

  /**
   * Every run for one database, oldest first.
   *
   * The fingerprint is settled before anything is listed, because a timeline
   * mixing two databases reports each one's findings as the other's appearing
   * and disappearing.
   */
  entries(fingerprint?: string): TimelineEntry[] {
    const want = fingerprint ?? this.newestFingerprint();
    if (want === null) return [];

    const out: TimelineEntry[] = [];
    for (const o of this.open) {
      // A retired reader opened at the LIVE path is still the main file, so it
      // keeps the bare handle. Only true siblings get a `vN:` prefix.
      const prefix =
        o.kind === 'live' || o.path === this.live ? '' : `${handlePrefix(o.path, this.live)}:`;
      const runs =
        o.kind === 'live' ? o.store.runsFor(want, 200) : o.reader.runsFor(want, 200);
      for (const run of runs) {
        out.push({
          handle: `${prefix}${run.runId}`,
          run,
          source: {
            path: o.path,
            schemaVersion: o.kind === 'live' ? null : o.reader.source.schemaVersion,
          },
        });
      }
    }

    out.sort((a, b) =>
      a.run.startedAt === b.run.startedAt
        ? a.run.runId - b.run.runId
        : a.run.startedAt.localeCompare(b.run.startedAt),
    );
    return out;
  }

  /** The snapshot behind one handle, or null when no such run exists. */
  snapshotOf(handle: string, fingerprint?: string): RunSnapshot | null {
    const entry = this.entries(fingerprint).find((e) => e.handle === handle);
    if (entry === undefined) return null;
    const from = this.open.find((o) => o.path === entry.source.path);
    if (from === undefined) return null;
    return from.kind === 'live'
      ? from.store.snapshotOf(entry.run.runId)
      : from.reader.snapshotOf(entry.run.runId);
  }

  close(): void {
    for (const o of this.open) {
      try {
        if (o.kind === 'live') o.store.close();
        else o.reader.close();
      } catch {
        // Closing is cleanup. A failure here must not replace whatever the
        // caller was actually reporting.
      }
    }
  }
}
