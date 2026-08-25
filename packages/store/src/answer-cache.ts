/**
 * Answers already paid for — HS-D D.2.
 *
 * ## The rationale changed, so the design did
 *
 * D.2 was written as *"cache by finding_hash → a re-scan barely calls the
 * model"*, back when a model was going to explain every finding. VS-7 removed
 * that job: the rule packs explain, four of five real readers took the right
 * conclusion from them, and explanation was cut from HS-D entirely. Nothing
 * re-explains, so there is nothing for a per-finding cache to save.
 *
 * What does call a model is a QUESTION about a finding, so that is what is
 * keyed:
 *
 * ```text
 * structureHash   what the claim SAYS — rule, kind, confidence, severity,
 *                 origin, basis, schema, table, columns. Already designed to
 *                 be stable across prose edits and across languages.
 * question        the person's words, trimmed and nothing else. Two questions
 *                 that differ by meaning must not collide, and deciding which
 *                 differences are meaningful is a judgement a cache has no
 *                 business making.
 * tier            a different tier is a different model, and a different model
 *                 may answer differently. Same question, different tier, is a
 *                 different answer.
 * ```
 *
 * ## Language is NOT in the key, and that is the design paying off
 *
 * A model returns identifiers; the product renders the sentence. So the cached
 * thing is language-independent — ask in English, serve the answer, render it
 * in Vietnamese. That falls out of `bounded-answer` for free, and it is worth
 * naming because the obvious key would have included a language and quietly
 * halved the hit rate for no reason.
 *
 * ## Its own file, and never a table in the history
 *
 * A cache does not belong in the scan history, and the reason is not tidiness.
 * The history is evidence about somebody's database; its schema bumps retire
 * the file (deliberately, debt N4, no migrator). Putting a cache in there
 * means the day the cache's shape changes, somebody's evidence gets moved
 * aside for it.
 *
 * > A cache must never be able to cost you your evidence.
 *
 * So it lives beside the history in its own file, versioned on its own, and
 * deleting it at any moment is always safe. That is what a cache is.
 *
 * ## Every hit is re-validated
 *
 * `structureHash` does not hash counts, so two findings that hash the same can
 * carry different evidence — and a cached answer citing a fact id that no
 * longer exists is stale. `get` re-runs the caller's own validator over the
 * stored answer against the CURRENT facts, and treats a refusal as a miss. A
 * miss is always safe; a stale hit is a sentence about evidence that is not
 * there any more.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * Bumped when the shape below changes.
 *
 * Unlike the history's version this one carries no obligation: on a mismatch
 * the file is dropped and rebuilt, because everything in it can be recomputed
 * by asking again. That asymmetry is the whole reason it is a separate file.
 */
const CACHE_SCHEMA_VERSION = 1;

const DDL = `
  CREATE TABLE IF NOT EXISTS cache_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS answer (
    structure_hash TEXT NOT NULL,
    question       TEXT NOT NULL,
    tier           TEXT NOT NULL,
    answer_json    TEXT NOT NULL,
    stored_at      TEXT NOT NULL,
    PRIMARY KEY (structure_hash, question, tier)
  ) STRICT;
`;

export type CacheKey = {
  /** What the claim says, from `structureHash`. */
  structureHash: string;
  /** The person's question, verbatim. Trimmed here, not normalised further. */
  question: string;
  /** Which tier answered. A different model is a different answer. */
  tier: string;
};

export class AnswerCache {
  private constructor(private readonly db: DatabaseSync) {}

  /**
   * Opens the cache, rebuilding it from scratch if its shape has moved on.
   *
   * Dropping is correct here and would be indefensible in the history. Nothing
   * in this file is evidence; every row can be had again by asking. A cache
   * that refuses to open because it is old is a cache that has confused itself
   * for a record.
   */
  static open(path: string): AnswerCache {
    let db = new DatabaseSync(path);
    db.exec(DDL);

    const found = db
      .prepare(`SELECT value FROM cache_meta WHERE key = 'schema_version'`)
      .get() as { value?: string } | undefined;
    const version = found?.value === undefined ? null : Number(found.value);

    if (version !== CACHE_SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS answer');
      db.exec('DROP TABLE IF EXISTS cache_meta');
      db.exec(DDL);
      db.prepare(`INSERT INTO cache_meta (key, value) VALUES (?, ?)`).run(
        'schema_version',
        String(CACHE_SCHEMA_VERSION),
      );
    }

    return new AnswerCache(db);
  }

  static memory(): AnswerCache {
    return AnswerCache.open(':memory:');
  }

  /**
   * An answer already paid for, or null.
   *
   * `validate` is the caller's own sealer. Passing it in rather than importing
   * one keeps this package free of a dependency on contracts — the same
   * boundary the rest of the store keeps — and it means the cache can never
   * hand back something the caller would have refused. A throw is a miss.
   */
  get<T>(key: CacheKey, validate: (raw: unknown) => T): T | null {
    const row = this.db
      .prepare(
        `SELECT answer_json FROM answer
         WHERE structure_hash = ? AND question = ? AND tier = ?`,
      )
      .get(key.structureHash, key.question.trim(), key.tier) as
      | { answer_json?: string }
      | undefined;

    if (!row?.answer_json) return null;

    try {
      return validate(JSON.parse(row.answer_json));
    } catch {
      // Stale: the finding's facts have moved and the stored answer no longer
      // validates against them. Dropped rather than kept, so the next miss is
      // a plain miss instead of a repeat of this work.
      this.forget(key);
      return null;
    }
  }

  /**
   * Remembers one answer.
   *
   * Only ever called with an answer the caller already sealed. There is no
   * path here that stores something unvalidated — a cache of unchecked output
   * is a way to make one bad answer permanent.
   */
  put(key: CacheKey, answer: unknown, now = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO answer (structure_hash, question, tier, answer_json, stored_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (structure_hash, question, tier) DO UPDATE SET
           answer_json = excluded.answer_json,
           stored_at   = excluded.stored_at`,
      )
      .run(key.structureHash, key.question.trim(), key.tier, JSON.stringify(answer), now);
  }

  forget(key: CacheKey): void {
    this.db
      .prepare(
        `DELETE FROM answer
         WHERE structure_hash = ? AND question = ? AND tier = ?`,
      )
      .run(key.structureHash, key.question.trim(), key.tier);
  }

  /** How many answers are held. For a person wondering whether it is working. */
  size(): number {
    const row = this.db.prepare(`SELECT count(*) AS n FROM answer`).get() as {
      n: number;
    };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}
