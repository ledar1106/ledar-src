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
  PROFILE_AREAS,
  ProfileArea,
  conflictsIn,
  emptyProfile,
  observeAreas,
  reconcile,
  scanPlanFrom,
} from '@ledar/contracts';
import type {
  AreaKnowledge,
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
): void {
  seen = observeAreas(shape, at);
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
}

/** Drops everything, when the window's session ends. */
export function forgetObservations(): void {
  seen = [];
  fingerprint = null;
  profile = null;
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
  if (known === undefined) return factsOf(profile);
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
    const known = p.areas[area] ?? { state: 'unknown' as const };
    switch (known.state) {
      case 'unknown':
        return { area, state: known.state, evidence: [], stated: null };
      case 'stated':
        return { area, state: known.state, evidence: [], stated: known.answer };
      case 'suspected':
      case 'observed':
        return {
          area,
          state: known.state,
          evidence: known.evidence.map((e) => ({ where: e.where, why: e.why })),
          stated: known.stated,
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
        };
    }
  });

  return { version: p.version, areas, conflicts: conflictsIn(p) };
}
