/**
 * The entity map, on its way into the file and back out.
 *
 * Same division of labour as `profile.ts`, and for the same reason — this
 * package holds no runtime dependency on `@ledar/contracts`, because a history
 * file has to be readable on a machine with nothing else installed. So the
 * import below is `import type` and disappears at build time:
 *
 * ```text
 * @ledar/contracts   what an edge may BE
 * the DDL            what this file may HOLD
 * this module        translation, and the one check the DDL cannot reach
 * ```
 *
 * ## Why store it at all, when rebuilding it is free
 *
 * 🟥 Worth stating because the answer is not "to save work". The map costs no
 * query: it is foreign keys and column names that `readSchemaGraph` fetches
 * anyway, so rebuilding it on every scan is free and always will be.
 *
 * What storing it buys is the ability to answer *"what touches this
 * customer?"* **without opening the database at all** — ideal §45. A product
 * that has to connect before it can say anything is a product that re-learns
 * the same system every morning, and the person asking is the one who pays for
 * that in waiting.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { EntityEdge, EntityGraph } from '@ledar/contracts';

import { int, intOrNull, text, textOrNull } from './rows.js';
import type { Row } from './rows.js';
import { STORE_VOCABULARY } from './schema.js';

/**
 * The tiers this build can read back.
 *
 * Derived from `STORE_VOCABULARY` rather than typed out — lesson N50. There is
 * one list, the DDL constrains against it, `vocabulary.test.ts` pins it to the
 * contract, and this reads it. A fourth copy would be invisible precisely
 * because the first three already have a tripwire between them.
 */
const KNOWN_TIERS: ReadonlySet<string> = new Set(STORE_VOCABULARY['edgeTier'] ?? []);

/** Which `scanned_database` row this map is about, or null if none is. */
function databaseIdFor(db: DatabaseSync, fingerprint: string): number | null {
  const row = db.prepare(`SELECT id FROM scanned_database WHERE fingerprint = ?`).get(fingerprint);
  return row === undefined ? null : int(row, 'id');
}

/**
 * Writes one map, replacing whatever this database had before.
 *
 * Called inside `ScanStore.tx`, so a half-written map cannot survive: the edges
 * are deleted and re-inserted, and a throw anywhere in the middle takes the
 * DELETE with it.
 *
 * ## Why DELETE-then-INSERT rather than an upsert per edge
 *
 * The graph handed in is the WHOLE map. An upsert per edge leaves behind every
 * relationship the new map no longer has — a foreign key somebody dropped last
 * week, still sitting there with `tier = 'declared'`, saying the database
 * enforces something it no longer mentions. That is worse than a stale map: it
 * is a stale map that reads as current, filed under a `built_at` claiming
 * otherwise.
 *
 * ## Why an unknown database is refused rather than created
 *
 * Same as `writeProfile`. The `scanned_database` row is created by `openRun`,
 * which takes a LABEL — what a person calls this database. Creating one here
 * would mean inventing that label, and a map filed under a name nobody chose
 * is a map nobody can find again.
 */
export function writeMap(db: DatabaseSync, fingerprint: string, graph: EntityGraph, at: string): void {
  const databaseId = databaseIdFor(db, fingerprint);
  if (databaseId === null) {
    throw new Error(
      `No scanned database with fingerprint ${fingerprint}. A map is filed against a ` +
        `database this history has opened a run on, and creating that row here would ` +
        `mean inventing the label a person is supposed to have chosen.`,
    );
  }

  db.prepare(
    `
    INSERT INTO entity_map (database_id, built_at)
    VALUES (?, ?)
    ON CONFLICT (database_id) DO UPDATE SET built_at = excluded.built_at
    `,
  ).run(databaseId, at);

  db.prepare(`DELETE FROM entity_edge WHERE database_id = ?`).run(databaseId);

  const insert = db.prepare(
    `
    INSERT INTO entity_edge (
      database_id, from_schema, from_table, to_schema, to_table,
      via, tier, why, matched_of, matched_found,
      join_from_json, join_to_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  for (const edge of graph.edges) {
    insert.run(
      databaseId,
      edge.from.schema,
      edge.from.table,
      edge.to.schema,
      edge.to.table,
      edge.via,
      edge.tier,
      edge.why,
      edge.matched === null ? null : edge.matched.of,
      edge.matched === null ? null : edge.matched.found,
      // N58. Stringified here rather than in the contract: the contract holds
      // lists because that is what a join is, and JSON is this file's way of
      // putting a list in a column — the same shape `coverage_skipped_json`
      // and `stated_picked_json` already use.
      edge.join === null ? null : JSON.stringify(edge.join.from),
      edge.join === null ? null : JSON.stringify(edge.join.to),
    );
  }
}

/**
 * Reads one map back, or null because nobody has built one.
 *
 * 🟥 Null is not an error and is not an empty map. `entity_map` exists as a
 * separate row for exactly this: *"this database has no relationships"* and
 * *"nobody has looked"* are opposite things to say to somebody who has just
 * inherited a system, and a reader that returned `{ edges: [] }` for both would
 * say the first when it meant the second.
 *
 * An unreadable row is DROPPED rather than repaired or thrown on. A tier this
 * build does not know is a file written by a newer version, and guessing what
 * it meant would put an edge on screen whose strength nobody here can name.
 */
export function readMap(db: DatabaseSync, fingerprint: string): EntityGraph | null {
  const databaseId = databaseIdFor(db, fingerprint);
  if (databaseId === null) return null;

  const head = db.prepare(`SELECT built_at FROM entity_map WHERE database_id = ?`).get(databaseId);
  if (head === undefined) return null;

  const rows = db
    .prepare(
      `
      SELECT from_schema, from_table, to_schema, to_table,
             via, tier, why, matched_of, matched_found,
             join_from_json, join_to_json
        FROM entity_edge
       WHERE database_id = ?
       ORDER BY from_schema, from_table, via, to_schema, to_table
      `,
    )
    .all(databaseId) as Row[];

  const edges: EntityEdge[] = [];
  for (const row of rows) {
    const tier = text(row, 'tier');
    if (!KNOWN_TIERS.has(tier)) continue;

    const of = intOrNull(row, 'matched_of');
    const found = intOrNull(row, 'matched_found');
    const base = {
      from: { schema: text(row, 'from_schema'), table: text(row, 'from_table') },
      to: { schema: text(row, 'to_schema'), table: text(row, 'to_table') },
      via: text(row, 'via'),
      why: text(row, 'why'),
    };

    // N58. Two columns back into one pair, and a row that cannot produce a
    // usable pair is DROPPED for the same reason an unknown tier is: an edge
    // whose join does not line up would join on the wrong columns, and a
    // wrong join returns rows that look exactly like right ones.
    const joinFrom = readColumnList(row, 'join_from_json');
    const joinTo = readColumnList(row, 'join_to_json');
    const joinBroken =
      (joinFrom === null) !== (joinTo === null) ||
      (joinFrom !== null && joinTo !== null && joinFrom.length !== joinTo.length);
    if (joinBroken) continue;
    const join = joinFrom === null || joinTo === null ? null : { from: joinFrom, to: joinTo };

    // The one check the DDL cannot reach from here: the contract's union pairs
    // `measured` with a rate and every other tier with null, and this is where
    // a row that satisfied `rate_belongs_to_measured` still has to be turned
    // into one arm of that union rather than the other. The join goes the same
    // way — `guessed` takes null and the other two take a pair.
    if (tier === 'guessed') {
      if (of !== null || found !== null || join !== null) continue;
      edges.push({ ...base, tier: 'guessed', matched: null, join: null });
      continue;
    }
    if (tier === 'measured') {
      // A measured edge with no join is a rate nobody could have counted, so
      // the row is dropped rather than promoted to a weaker tier — the same
      // reasoning as the missing rate on the line above it.
      if (of === null || found === null || join === null) continue;
      edges.push({ ...base, tier: 'measured', matched: { of, found }, join });
      continue;
    }
    if (of !== null || found !== null) continue;
    edges.push({ ...base, tier: 'declared', matched: null, join });
  }

  return { edges };
}

/**
 * A stored JSON list of column names, or null when the column is null.
 *
 * Returns null for anything that is not a list of non-empty strings, which
 * the caller treats as a broken row rather than an empty join. The DDL
 * already refuses those shapes; this is the second lock, for a file written
 * by something that was not this build.
 */
function readColumnList(row: Row, column: string): string[] | null {
  const raw = textOrNull(row, column);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return null;
  if (!parsed.every((c) => typeof c === 'string' && c.trim() !== '')) return null;
  return parsed as string[];
}
