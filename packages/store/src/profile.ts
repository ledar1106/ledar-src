/**
 * The map, on its way into the file and back out.
 *
 * `store.ts` owns the transaction and the public method; this owns the
 * translation between five rows and one `ProjectProfile`. Split for the reason
 * `snapshot.ts` was: a row-mapper that lives inside the class it serves ends up
 * with two copies the first time a second reader needs one, and the two agree
 * until the branch nobody runs.
 *
 * ## What this file is NOT allowed to do
 *
 * It does not validate a profile. It cannot: `packages/store` holds no runtime
 * dependency on `@ledar/contracts` — a history file has to be readable on a
 * machine with nothing else installed — so `ProjectProfile.parse` is not
 * reachable from here and never will be. The import below is `import type`,
 * which disappears at build time.
 *
 * The division of labour that follows from that is worth saying once:
 *
 * ```text
 * @ledar/contracts   what a profile may BE
 * the DDL            what this file may HOLD
 * this module        translation, and the two checks the DDL cannot reach
 * ```
 *
 * The middle line is the one that had to be built rather than assumed. A store
 * that only translated would happily write a `verified` rung with no evidence
 * whenever a caller handed it one, and the resulting file would be a record of
 * a human agreement that never happened. `schema.ts` refuses that in four named
 * CHECK constraints; this module's job is to hand SQLite the columns those
 * constraints are written against, and to say something useful when they fire.
 */

import type { DatabaseSync } from 'node:sqlite';

import type {
  AreaAnswer,
  AreaKnowledge,
  ProfileArea,
  ProfileEvidence,
  ProjectProfile,
} from '@ledar/contracts';

import { int, json, text, textOrNull } from './rows.js';
import type { Row } from './rows.js';
import { STORE_VOCABULARY } from './schema.js';

/**
 * The areas this build can read back.
 *
 * Derived from `STORE_VOCABULARY` rather than typed out, which is lesson N50's
 * whole content: the third copy of a list is invisible precisely BECAUSE the
 * first two already have a tripwire between them, so the question *"is this
 * vocabulary watched?"* looks answered. There is one list, the DDL constrains
 * against it, `vocabulary.test.ts` pins it to the contract, and this reads it.
 */
const KNOWN_AREAS: ReadonlySet<string> = new Set(STORE_VOCABULARY['profileArea'] ?? []);

/**
 * Refuses evidence that cannot be gone and looked at.
 *
 * This is one of the two checks the file itself cannot make, and the DDL
 * comment says why: reaching inside a JSON array needs `json_each`, which is a
 * table-valued function, and a CHECK may not contain a subquery. So the fence
 * around the ITEMS is here, in the one writer, and it is weaker than the fence
 * around the array — a second writer at 2am gets the array rule enforced and
 * this one not.
 *
 * Stated rather than glossed. The alternative was to leave it out entirely on
 * the grounds that a partial fence is untidy, and a partial fence is worth more
 * than none as long as nobody is told it is total.
 *
 * `why` is trimmed and `where` is not, matching the contract exactly: a
 * whitespace reason passes every presence check and explains nothing, while a
 * schema object with an odd name is still a place somebody can go and look at.
 */
function assertEvidence(
  area: ProfileArea,
  state: string,
  evidence: readonly ProfileEvidence[],
): void {
  evidence.forEach((item, index) => {
    const bad =
      typeof item?.where !== 'string' || item.where === ''
        ? 'where'
        : typeof item.why !== 'string' || item.why.trim() === ''
          ? 'why'
          : typeof item.observedAt !== 'string' || item.observedAt === ''
            ? 'observedAt'
            : null;
    if (bad === null) return;

    throw new Error(
      `The ${state} rung for "${area}" carries an item of evidence with no ` +
        `usable \`${bad}\` (item ${index}). An observation nobody can go and ` +
        `check is an assertion, and this product does not get to make those: ` +
        `\`where\` is the schema object they would look at, \`why\` is what ` +
        `about it pointed this way, and \`observedAt\` is when — a profile ` +
        `read back in March is about March. Nothing was written.`,
    );
  });
}

/** Which `scanned_database` row this profile is about, or null if none is. */
function databaseIdFor(db: DatabaseSync, fingerprint: string): number | null {
  const row = db
    .prepare(`SELECT id FROM scanned_database WHERE fingerprint = ?`)
    .get(fingerprint);
  return row === undefined ? null : int(row, 'id');
}

/**
 * Writes one profile, replacing whatever this database had before.
 *
 * Called inside `ScanStore.tx`, so a half-written map cannot survive: the areas
 * are deleted and re-inserted, and a throw anywhere in the middle takes the
 * DELETE with it.
 *
 * ## Why DELETE-then-INSERT rather than an upsert per area
 *
 * The profile handed in is the WHOLE map, not a patch. An upsert per area
 * leaves behind any area the new profile no longer mentions, and the row it
 * leaves behind is the most dangerous kind there is: a rung from an older
 * version of the map, sitting beside four current ones, with a `version`
 * column claiming all five were written together. Replacing the set says what
 * a save actually is.
 *
 * ## Why an unknown database is refused rather than created
 *
 * The row this needs is created by `openRun`, which takes a LABEL — what the
 * person calls this database, the one field in `scanned_database` meant for a
 * human to read. A profile carries no label, so creating the row from here
 * would mean inventing one, and an invented label is the store answering a
 * question nobody asked it.
 *
 * It costs nothing in the product's own order of events: the scan opens a run
 * before it reads the schema graph, and the profile is built from what that
 * graph showed. A fingerprint with no run behind it is a profile about a
 * database this history has never seen.
 */
export function writeProfile(db: DatabaseSync, profile: ProjectProfile): void {
  const fingerprint = profile.databaseFingerprint;
  const databaseId = databaseIdFor(db, fingerprint);
  if (databaseId === null) {
    throw new Error(
      `This history has no record of the database fingerprinted ` +
        `"${fingerprint}", so there is nothing for a profile about it to hang ` +
        `on. A profile is what this product believes about a database it has ` +
        `read; open a run against it first. Creating the row from here would ` +
        `mean inventing the label a person is supposed to have chosen. ` +
        `Nothing was written.`,
    );
  }

  db.prepare(
    `
    INSERT INTO project_profile (database_id, version, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (database_id) DO UPDATE SET
      version    = excluded.version,
      updated_at = excluded.updated_at
    `,
  ).run(
    databaseId,
    profile.version,
    // Written through, not normalised. `isoTime` exists for `run.started_at`
    // because runs are SORTED by that string and two timezones sort wrongly.
    // There is one profile per database and nothing orders by this, so
    // rewriting the caller's timestamp would cost the round trip its
    // exactness and buy nothing.
    profile.updatedAt,
  );

  db.prepare(`DELETE FROM project_profile_area WHERE database_id = ?`).run(databaseId);

  const insert = db.prepare(
    `
    INSERT INTO project_profile_area (
      database_id, area, state, answer, picked_json, evidence_json,
      stated_answer, confirmed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  for (const [name, known] of Object.entries(profile.areas)) {
    const area = name as ProfileArea;
    if (known === undefined) continue;

    // Every column not named by this rung is NULL, and the CHECK constraints
    // in `schema.ts` are written against exactly that. Spelling out all eight
    // per branch rather than building a partial object: a field left off by
    // accident would arrive as `undefined`, which `node:sqlite` refuses to
    // bind at all — a TypeError naming a parameter index, thrown before the
    // constraint that would have named the column ever runs.
    switch (known.state) {
      case 'unknown':
        insert.run(databaseId, area, 'unknown', null, null, null, null, null);
        break;

      case 'stated':
        insert.run(
          databaseId,
          area,
          'stated',
          known.answer,
          // `?? []` reproduces the contract's own `.default([])` rather than
          // inventing anything: an absent `picked` IS the empty list there, so
          // a profile that went through `AreaKnowledge.parse` round-trips
          // byte for byte and one that did not is stored as the contract
          // would have read it.
          JSON.stringify(known.picked ?? []),
          null,
          null,
          null,
        );
        break;

      case 'suspected':
      case 'observed':
        assertEvidence(area, known.state, known.evidence);
        insert.run(
          databaseId,
          area,
          known.state,
          null,
          null,
          JSON.stringify(known.evidence),
          // `known.stated` is nullable and the null is load-bearing: it means
          // the person was never asked about an area the scan found something
          // in. Passed through, never coalesced.
          known.stated,
          null,
        );
        break;

      case 'verified':
        assertEvidence(area, 'verified', known.evidence);
        insert.run(
          databaseId,
          area,
          'verified',
          null,
          null,
          JSON.stringify(known.evidence),
          null,
          known.confirmedAt,
        );
        break;
    }
  }
}

/**
 * The profile for one database, or null because there is not one.
 *
 * Null is a normal state and is returned as one. Nobody has answered anything
 * about most databases, and a product that threw here would be treating "we
 * have not asked yet" as a failure — the same mistake the ladder's `unknown`
 * rung exists to refuse.
 */
export function readProfile(
  db: DatabaseSync,
  fingerprint: string,
): ProjectProfile | null {
  const head = db
    .prepare(
      `
      SELECT p.version, p.updated_at, p.database_id
      FROM project_profile p
      JOIN scanned_database d ON d.id = p.database_id
      WHERE d.fingerprint = ?
      `,
    )
    .get(fingerprint);
  if (head === undefined) return null;

  const rows = db
    .prepare(`SELECT * FROM project_profile_area WHERE database_id = ? ORDER BY area`)
    .all(int(head, 'database_id'));

  const areas = {} as Record<ProfileArea, AreaKnowledge>;
  for (const row of rows) {
    const area = text(row, 'area');
    // The column is CHECK-constrained, so this can only fire for a file
    // written past that fence — a newer build, or somebody who turned the
    // constraints off. Both are reasons to stop rather than to widen: reading
    // an area this build does not render as one it does would file somebody
    // else's answer under the wrong question.
    if (!KNOWN_AREAS.has(area)) {
      throw new Error(
        `This profile holds an area called "${area}", which this build does ` +
          `not know. It was probably written by a newer version; guessing at ` +
          `which of the five it meant would put a person's answer under a ` +
          `question they were never asked.`,
      );
    }
    areas[area as ProfileArea] = knowledgeFrom(row, area);
  }

  return {
    version: int(head, 'version'),
    updatedAt: text(head, 'updated_at'),
    databaseFingerprint: fingerprint,
    // Exactly the areas the file holds, and no filling-in. The contract says
    // all five are always present and `emptyProfile` makes them, so a file
    // missing one was written by something that did not; manufacturing an
    // `unknown` here would hide that, and `unknown` is a claim about a system
    // rather than a placeholder.
    areas,
  };
}

/** One row, back into the rung it was written from. */
function knowledgeFrom(row: Row, area: string): AreaKnowledge {
  const state = text(row, 'state');

  switch (state) {
    case 'unknown':
      return { state: 'unknown' };

    case 'stated':
      return {
        state: 'stated',
        answer: text(row, 'answer') as AreaAnswer,
        picked: json<string[]>(text(row, 'picked_json'), 'picked_json'),
      };

    case 'suspected':
    case 'observed':
      return {
        state,
        evidence: evidenceFrom(row),
        // `textOrNull`, never coalesced to a value. A stored NULL means
        // nobody was asked; reading it back as 'dont_know' would turn a
        // question never put to anybody into an answer they gave.
        stated: textOrNull(row, 'stated_answer') as AreaAnswer | null,
      };

    case 'verified':
      return {
        state: 'verified',
        evidence: evidenceFrom(row),
        confirmedAt: text(row, 'confirmed_at'),
      };

    default:
      // Same reasoning as the area guard above, and the more dangerous of the
      // two: a rung this build cannot place is a rung whose strength it cannot
      // read, and every screen downstream treats one of the five as settled.
      throw new Error(
        `The profile's "${area}" area is on a rung called "${state}", which ` +
          `this build does not know. It was probably written by a newer ` +
          `version; reading it as one of the five we do know would be a guess ` +
          `about how strongly somebody's system was claimed to be understood.`,
      );
  }
}

function evidenceFrom(row: Row): ProfileEvidence[] {
  return json<ProfileEvidence[]>(text(row, 'evidence_json'), 'evidence_json');
}
