/**
 * The map — what this product knows about a system, and how sure it is.
 *
 * Ideal §23 (Project Profile) built on §22 (the knowledge ladder), and this
 * file is where the two halves of ideal §12's audit finally meet:
 *
 * > *"Scan trước (rẻ, tự động) → Trình bày cái tìm được → User chỉ bấm
 * > Đúng/Sai. Câu hỏi cũ đòi KIẾN THỨC; câu hỏi mới chỉ đòi XÁC NHẬN điều đã
 * > thấy."*
 *
 * The window asks five questions somebody can answer by looking at a screen.
 * The scan goes and looks for itself. Neither half is worth much alone:
 *
 * ```text
 * only asked    you learn what they believe — and they are the ones who told
 *               you they do not understand the system
 * only scanned  you learn what is there, and nothing about what it is FOR
 * both          a disagreement is the most valuable thing on the screen. It
 *               is the question they did not know to ask.
 * ```
 *
 * ## What lives here and what deliberately does not
 *
 * Reconciling is `@ledar/contracts`. Deciding what a name means is
 * `@ledar/contracts`. This file holds the SESSION: which observations belong
 * to which window, what has been saved, and who is allowed to promote a rung.
 *
 * ## 🟥 One rule with no exception
 *
 * `verified` is produced in exactly one place — `confirmArea`, called because
 * a person pressed a button after being shown what was found. Nothing else in
 * this product may write that rung. It means a human signed it, every later
 * screen reads it as settled, and the moment a computation can mint it the
 * word stops meaning anything.
 */

import {
  applyVerdicts,
  PROFILE_AREAS,
  ProfileArea,
  conflictsIn,
  emptyProfile,
  graphFrom,
  observeAreas,
  observeConnection,
  reconcile,
  scanPlanFrom,
} from '@ledar/contracts';
import type {
  CountedEdge,
  AreaKnowledge,
  EntityGraph,
  GraphSource,
  Observation,
  ProjectProfile,
  ScanPlan,
  SchemaShape,
  StatedAnswer,
} from '@ledar/contracts';

import { ScanStore, historyFile } from '@ledar/store';

import type { AreaFacts, AreaReply, ProfileFacts } from '../shared/ipc.js';

/**
 * What the last scan of this window saw, waiting for the answers to arrive.
 *
 * Module state for the same reason `session.ts` holds the DSN there: it lives
 * as long as the window and dies with it. A profile is about ONE database, and
 * this holds the observations of the one the window is looking at.
 *
 * ⚠️ Cleared by `forgetObservations` when a session closes. Observations from
 * a database the window is no longer connected to, reconciled against answers
 * about a different one, would produce a map of a system nobody has.
 */
let seen: readonly Observation[] = [];
let fingerprint: string | null = null;
let profile: ProjectProfile | null = null;
/**
 * This database's map, for the life of the window.
 *
 * Beside `profile` rather than inside it: the profile is what a PERSON said
 * and what the schema showed about five areas, and it is persisted. The map is
 * derived wholly from a scan with nobody's opinion in it, so folding it in
 * would put a re-derivable thing inside the one record this product treats as
 * a person's own words.
 */
let map: EntityGraph | null = null;
/**
 * Which database `map` is of.
 *
 * 🟥 Its own field rather than leaning on `fingerprint`, because the first
 * draft did lean on it and had a hole: `noteMap` set the map without setting
 * `fingerprint`, so a map built for database A survived into a session about
 * database B — `noteObservations` checked `fingerprint`, found it null, and
 * cleared nothing. A person would then have been shown A's relationships under
 * B's name, which is the worst thing this file could produce: not an error, a
 * confident wrong answer.
 *
 * The map carries its own identity so the two can never disagree about which
 * system they describe.
 */
let mapFor: string | null = null;

/**
 * Opens the history, does one thing, and closes it.
 *
 * Short-lived on purpose, exactly as `RunHistory` treats it. A handle held
 * open for the life of the window would sit on the same file the CLI writes
 * to, and this product runs on somebody's laptop where the other half of it
 * is a terminal command they may run at any moment.
 *
 * Swallows failures and says so by returning null. A profile that cannot be
 * saved must not take the report down with it: the report came from their
 * database and is true whatever happens to the map. This is the same bargain
 * `withModelStep` strikes — the addition can fail; the measurement cannot be
 * allowed to fail with it.
 */
function withStore<T>(body: (store: ScanStore) => T): T | null {
  let store: ScanStore | null = null;
  try {
    store = ScanStore.open(historyFile());
    return body(store);
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/**
 * Writes the map, and says nothing to the caller if it could not.
 *
 * 🟥 The silence is deliberate and it is NOT the product hiding a failure. A
 * map that failed to save is a map that will be rebuilt from the next scan and
 * the next set of answers — nothing is lost that cannot be re-derived. What
 * would be lost by throwing is the report, which was measured from a real
 * database and owes nothing to this file.
 *
 * ⚠️ What the person is NOT told, said here so it is a decision rather than an
 * oversight: they are not warned that their answers did not persist. That is a
 * gap, and it belongs to the screen that shows the map rather than to this
 * function — a sentence about it has to sit where they can see it, not in a
 * log. Written down so the next slice can close it on purpose.
 */
function persist(p: ProjectProfile): void {
  withStore((store) => {
    store.saveProfile(p);
  });
}

/**
 * Called by the scan once it has read the schema graph.
 *
 * Takes a shape rather than the graph itself: `SchemaShape` is what
 * `observeAreas` needs and nothing more, and passing the whole graph would
 * hand a pure function a connection's worth of detail it has no business
 * reading.
 */
export function noteObservations(
  databaseFingerprint: string,
  shape: SchemaShape,
  at: string,
  /**
   * The database this window is connected to.
   *
   * 🟥 Required, not optional. `observeAreas` cannot settle the `database`
   * area by reading names and says so; for six days nothing settled it at all,
   * and a person who had just watched LEDAR scan their Postgres was told *"you
   * said yes, I could not see it"* about the database it was connected to.
   * Optional here would let the same silence come back the first time somebody
   * added a second caller.
   */
  connectedTo: string,
): void {
  // A different database means a different map. Checked against the map's OWN
  // fingerprint, not the session's — see `mapFor`.
  if (mapFor !== null && mapFor !== databaseFingerprint) {
    map = null;
    mapFor = null;
  }
  seen = [observeConnection(connectedTo, at), ...observeAreas(shape, at)];
  fingerprint = databaseFingerprint;
  // A fresh scan of a different database starts a fresh map. Keeping the old
  // one would let answers about one system be reconciled against sightings
  // from another.
  if (profile !== null && profile.databaseFingerprint !== databaseFingerprint) profile = null;

  // 🟩 The memory. Ideal §45: what this product learned about a system must
  // outlive the window it learned it in, or every session starts by asking the
  // same person the same five questions and calls that a fresh start.
  //
  // Loaded only when this window has nothing — a map already in hand is newer
  // than the file, because it is the one the person has been editing.
  profile ??= withStore((store) => store.loadProfile(databaseFingerprint)) ?? null;
  profile ??= emptyProfile(databaseFingerprint, at);

  // The map from the last time anybody scanned this database — the other half
  // of §45. Loaded only when this session has none, because a map in hand came
  // from a scan that just ran and the stored one is older by definition.
  //
  // ⚠️ This is the ONLY path by which a map outlives the window that built it,
  // and it runs before the scan finishes. So what a person sees during a scan
  // is the PREVIOUS map until `noteMap` replaces it — which is right (the map
  // is not half-built and shown) and is worth knowing, because it means a
  // freshly dropped foreign key is still on screen until the scan completes.
  if (map === null) {
    const stored = withStore((store) => store.loadMap(databaseFingerprint)) ?? null;
    if (stored !== null) {
      map = stored;
      mapFor = databaseFingerprint;
    }
  }
}

/**
 * Called by the scan with the graph it already read.
 *
 * 🟥 Separate from `noteObservations`, which takes a `SchemaShape` — the three
 * fields `observeAreas` needs and nothing more. The map needs constraints and
 * partition parentage too, so widening that parameter would have handed a pure
 * function a connection's worth of detail to justify one caller. Two callers,
 * two shapes, one scan.
 *
 * It costs no query. Everything here came out of `readSchemaGraph`, which the
 * scan runs regardless, so building the map touches nobody's database a second
 * time and cannot slow one down.
 */
export function noteMap(databaseFingerprint: string, source: GraphSource, at: string): void {
  // 🟥 A map naming a database this session is not about is REFUSED, not
  // stored and filtered on the way out. Storing it would put another system's
  // relationships in this process for something later to find, and the whole
  // point of the check is that they should not be here at all.
  if (fingerprint !== null && fingerprint !== databaseFingerprint) return;
  map = graphFrom(source);
  mapFor = databaseFingerprint;

  // 🟩 Ideal §45. Written for the same reason the profile is, and silently for
  // the same reason: a map that failed to save is rebuilt by the next scan at
  // no cost, so throwing here would lose a report measured from a real
  // database to protect a file that owes it nothing.
  withStore((store) => {
    store.saveMap(databaseFingerprint, map!, at);
  });
}

/**
 * The map again, once the scan has finished counting.
 *
 * 🟥 A SECOND call rather than moving `noteMap` later, and the ordering is the
 * reason. `noteMap` runs early so a map exists while the scan is still going —
 * that is deliberate and its comment says so. Layer B's counts do not exist
 * until the end. So the map is built from NAMES first and corrected by COUNTS
 * after, which is exactly what the three rungs mean.
 *
 * What this fixes: nothing in the product ever created a `measured` edge. The
 * rung was in the contract type, in a SQL CHECK constraint, in `pathTier`, in
 * `timelineTier`, and beside every hop on the S6 screen — and no code path
 * could put an edge on it, while layer B counted and discarded the numbers.
 *
 * Measured on Pagila: 24 declared, 11 guessed, 0 measured. After this: 24
 * declared, 8 measured, 2 guessed, and one edge REMOVED —
 * `damaged_external_ref.staff_id -> staff.staff_id`, which held nought of
 * thirty values and which G3 would otherwise have walked.
 *
 * Silent on failure for the same reason `noteMap` is: a map that failed to
 * save is rebuilt by the next scan at no cost, and throwing here would lose a
 * report measured from a real database to protect a file that owes it nothing.
 */
export function refineMap(
  databaseFingerprint: string,
  verdicts: readonly CountedEdge[],
  at: string,
): { promoted: number; dropped: number; unmatched: number } | null {
  if (fingerprint !== null && fingerprint !== databaseFingerprint) return null;
  if (map === null || mapFor !== databaseFingerprint) return null;

  const out = applyVerdicts(map, verdicts);
  map = out.graph;
  withStore((store) => {
    store.saveMap(databaseFingerprint, out.graph, at);
  });
  return { promoted: out.promoted, dropped: out.dropped, unmatched: out.unmatched };
}

/**
 * The map of this database, or `null` before a scan has read one.
 *
 * ⚠️ Rebuilt from each scan and held for the window's life — it is NOT yet
 * memory in the sense ideal §45 means. Free to rebuild, because it is derived
 * from a read the scan does anyway; the reason to persist it is to answer a
 * question WITHOUT scanning, and that is what G3 needs rather than what G2
 * delivers. Written down here so the gap is a decision with a date on it and
 * not something discovered later by someone expecting it to be there.
 */
export function currentMap(): EntityGraph | null {
  // No filtering here on purpose. A wrong-database map is refused by `noteMap`
  // and dropped by `noteObservations`, so if one were still standing at this
  // point a check here would only hide it — and hiding it is what let both
  // guards pass their tests while neither was doing anything provable. Every
  // guard now sits where its absence changes what this returns.
  return map;
}

/** Drops everything, when the window's session ends. */
export function forgetObservations(): void {
  seen = [];
  fingerprint = null;
  profile = null;
  map = null;
  mapFor = null;
}

/**
 * Puts what was said beside what was seen, and hands back the map.
 *
 * Returns `null` when no scan has happened. That is not an error state to
 * dress up: the answers are about a database, and until one has been read
 * there is nothing for them to be about.
 */
export function saveProfile(replies: readonly AreaReply[], at: string): ProfileFacts | null {
  if (fingerprint === null || profile === null) return null;

  const said: StatedAnswer[] = replies.map((r) => ({
    area: r.area,
    answer: r.answer,
    picked: r.picked,
  }));

  profile = reconcile(profile, said, seen, at);
  persist(profile);
  return factsOf(profile);
}

/**
 * The person looked at what was found for one area and agreed.
 *
 * 🟥 The only path to `verified` in the product.
 *
 * ⚠️ Refuses to promote a rung that has nothing behind it. A person can only
 * agree with something they were SHOWN, and `unknown` and `stated` were never
 * shown any evidence — there is no card for them to have read. Letting a
 * confirmation land on those would mean `verified` sometimes meant "a human
 * agreed with a measurement" and sometimes "a human clicked next to a blank
 * space", and no later screen could tell which.
 */
export function confirmArea(area: ProfileArea, at: string): ProfileFacts | null {
  if (profile === null) return null;

  const known = profile.areas[area];
  // 🟥 Only a rung that was SEEN can be confirmed, and the map is returned
  // unchanged rather than throwing: a confirm button for an area that cannot
  // be confirmed should not exist, so arriving here means the window and the
  // profile disagree, and the profile is the one that is right.
  //
  // The `known === undefined` branch that used to sit above this is gone —
  // `areas` is a closed object over the five now, so the case cannot arise and
  // a branch for it would look like a considered decision about a state that
  // does not exist.
  if (known.state !== 'observed' && known.state !== 'suspected') return factsOf(profile);

  const promoted: AreaKnowledge = {
    state: 'verified',
    evidence: known.evidence,
    confirmedAt: at,
  };

  profile = {
    ...profile,
    version: profile.version + 1,
    updatedAt: at,
    areas: { ...profile.areas, [area]: promoted },
  };
  persist(profile);
  return factsOf(profile);
}

/**
 * What to look at first, or null because nothing is known yet.
 *
 * Null on the first scan of a database nobody has answered about, and the
 * caller passes that straight through rather than substituting a default
 * order. The difference matters: a plan derived from an empty profile is a
 * real plan that says "declaration order", and one that does not exist says
 * "nobody has told me anything" — and only the second is true before the
 * questions have been asked.
 */
export function currentPlan(): ScanPlan | null {
  return profile === null ? null : scanPlanFrom(profile);
}

/** The current map, or null if no scan has happened in this window yet. */
export function currentFacts(): ProfileFacts | null {
  return profile === null ? null : factsOf(profile);
}

/**
 * The profile as the window renders it.
 *
 * Flattens the ladder's union into one shape per area with a `state` field,
 * because a renderer switching on a discriminant is easier to keep exhaustive
 * than one probing for fields. The rung's NAME travels, so nothing on the far
 * side has to infer which one it is from what happens to be present — that
 * inference is debt N49, and it cost a slice.
 */
function factsOf(p: ProjectProfile): ProfileFacts {
  const areas: AreaFacts[] = PROFILE_AREAS.map((area) => {
    // No fallback, same reason as `scanPlanFrom`: `areas` is closed over the
    // five, and manufacturing an `unknown` for a missing one would report
    // "nobody has been asked about this" about an area that went missing.
    const known = p.areas[area];
    switch (known.state) {
      case 'unknown':
        return { area, state: known.state, evidence: [], stated: null, statedPicked: [] };
      case 'stated':
        return {
          area,
          state: known.state,
          evidence: [],
          stated: known.answer,
          statedPicked: known.picked,
        };
      case 'suspected':
      case 'observed':
        return {
          area,
          state: known.state,
          evidence: known.evidence.map((e) => ({ where: e.where, why: e.why })),
          stated: known.stated,
          statedPicked: known.statedPicked,
        };
      case 'verified':
        // The person agreed, so what they originally said is no longer the
        // interesting half — the agreement supersedes it. Kept null rather
        // than backfilled with a guess about which answer they had given.
        return {
          area,
          state: known.state,
          evidence: known.evidence.map((e) => ({ where: e.where, why: e.why })),
          stated: null,
          statedPicked: [],
        };
    }
  });

  return { version: p.version, areas, conflicts: conflictsIn(p) };
}
