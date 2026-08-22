/**
 * What to do with a history file this build cannot speak to.
 *
 * `applySchema` refuses to open a file written by another schema version, and
 * that refusal is right: a half-migrated history is worse than no history,
 * because the damage arrives later as a diff that is subtly wrong rather than
 * as an error. What was missing is the other half — somebody has to decide
 * what happens to the old file, and until now that somebody was the user,
 * holding a path they had never heard of and a message telling them to keep
 * it "alongside" a file they did not know they had.
 *
 * That was not a hypothetical. `SCHEMA_VERSION` went 1 → 2 on the argument
 * that no history file existed outside this repository's tests. The argument
 * was false as it was written: the machine it was written on had eleven real
 * runs in `%LOCALAPPDATA%\ledar\history.db`, and every scan through the
 * default path stopped being recorded from that moment.
 *
 * So: retire, do not migrate, and do not ask.
 *
 * Migrating is refused for the reason the refusal existed in the first place.
 * Version 1 predates provenance — `origin`, `confidenceBasis`, `egressClass`,
 * `observedAt`, `engineRuleVersion`, `userStatus`, all six NOT NULL. A
 * migration has to put something in those columns, and there is nothing true
 * to put there. Writing `origin: 'catalog'` into a claim recorded before the
 * rule knew what its own origin was is not a migration, it is a fabricated
 * measurement — the exact fault this codebase files under §4.1b and refuses
 * elsewhere. The old rows are unreadable to this build because they genuinely
 * are, and inventing the missing half to make them readable would make every
 * later diff quietly wrong.
 *
 * Retiring keeps the file, whole, byte for byte, under a name that says what
 * it is. Nothing is deleted here and nothing is edited. The scan that
 * triggered it then says out loud where the file went, what version it was,
 * and how many runs it held — because a file that moves without being
 * mentioned is its own kind of data loss.
 */

import { existsSync, renameSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_VERSION, readSchemaVersion } from './schema.js';
import { ScanStore } from './store.js';

/** A history file moved aside, and enough about it to say so in a report. */
export type RetiredHistory = {
  /** Where it used to be, which is where the new file now is. */
  from: string;
  /** Where it is now. It still exists; nothing here deletes. */
  to: string;
  /** The schema version it was written by. */
  version: number;
  /**
   * How many runs it held, or `null` when that could not be read.
   *
   * `null` is not zero. A version so old that it has no `run` table at all
   * still has runs in it in every sense the user cares about, and reporting
   * "0 runs" about a file nobody could read would be the two-denominator bug
   * in miniature.
   */
  runs: number | null;
};

export type OpenedHistory = {
  store: ScanStore;
  /** `null` on the ordinary path, which is almost every call. */
  retired: RetiredHistory | null;
};

/**
 * Reads the version out of an existing file without creating anything.
 *
 * Opened read-only on purpose. `ScanStore.open` would take a write lock and
 * create the schema, and this has to be able to look at a file it may be
 * about to decide is none of its business.
 *
 * Returns `null` for anything it cannot read as one of ours — an empty file,
 * a file that is not SQLite, a SQLite file with no `store_meta`. All of those
 * fall through to the ordinary open path, which is the behaviour that was
 * there before this function existed.
 */
function inspect(path: string): { version: number; runs: number | null } | null {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }

  try {
    const version = readSchemaVersion(db);
    if (version === null) return null;

    let runs: number | null = null;
    try {
      const row = db.prepare(`SELECT count(*) AS n FROM run`).get();
      const n = Number(row?.['n']);
      runs = Number.isInteger(n) ? n : null;
    } catch {
      // No `run` table, or a `run` table shaped differently. The version is
      // the part that decides; the count is only for the sentence.
    }

    return { version, runs };
  } finally {
    db.close();
  }
}

/**
 * The name the old file takes, chosen so it cannot overwrite anything.
 *
 * `history.db` → `history.v1.db`, and `history.v1.2.db` after that. The
 * counter rather than a timestamp: two retirements in the same second would
 * collide, and a name that can collide is a name that can lose a file. When
 * the file was retired is on the file itself.
 */
export function retiredName(path: string, version: number, exists = existsSync): string {
  const dot = path.lastIndexOf('.');
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const hasExt = dot > slash + 1;
  const base = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : '';

  let candidate = `${base}.v${version}${ext}`;
  for (let n = 2; exists(candidate); n += 1) {
    candidate = `${base}.v${version}.${n}${ext}`;
  }
  return candidate;
}

/**
 * Opens a history file, moving an unreadable one aside first.
 *
 * The failure path is deliberately the old behaviour. If the rename cannot
 * happen — no permission, another process holding the file open, which on
 * Windows is most of the ways this goes wrong — this does not invent a second
 * strategy. It opens the original, `applySchema` refuses it exactly as
 * before, and the caller reports that refusal. A fallback that quietly picks
 * a different file to write to would be worse than the problem: the user
 * would have a history, it would be somewhere they never chose, and nothing
 * would have said so.
 */
export function openHistory(path: string): OpenedHistory {
  if (path === ':memory:' || !existsSync(path)) {
    return { store: ScanStore.open(path), retired: null };
  }

  const found = inspect(path);
  if (found === null || found.version === SCHEMA_VERSION) {
    return { store: ScanStore.open(path), retired: null };
  }

  const to = retiredName(path, found.version);
  try {
    renameSync(path, to);
  } catch {
    return { store: ScanStore.open(path), retired: null };
  }

  return {
    store: ScanStore.open(path),
    retired: { from: path, to, version: found.version, runs: found.runs },
  };
}
