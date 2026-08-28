/**
 * The fixed question set, handed to the window from the contract that owns it.
 *
 * Ideal §14–§18. Five areas, `Yes / No / Don't know`, and a short list of
 * things to recognise after a `yes`. The whole point of the set is that it is
 * the SAME for everyone: a thousand people answering the same five questions
 * is a map, and a thousand people each writing a sentence is a thousand
 * sentences nobody can join up.
 *
 * ## Why this is a channel rather than a constant in the renderer
 *
 * The window cannot import a runtime value from `@ledar/contracts` — nothing
 * bundles zod into a browser context here, and the whole point of `ipc.ts`
 * being type-only is that neither compilation target drags the other's world
 * in. So the choice was: a second copy of the area list living in the
 * renderer, or one round trip.
 *
 * §4.27 is what a second copy costs, measured rather than argued: a third
 * copy of `ClaimKind` sat two hundred lines from the fence built to catch
 * exactly that, and the result was a build that refused to read a row it had
 * written itself. One round trip at startup is cheaper than finding that out
 * again in a different vocabulary.
 *
 * ## What this file deliberately does NOT do
 *
 * It sends no prose. The question a person reads — *"Does this system have
 * user login?"* — is window chrome and lives in the renderer's own catalogue,
 * because it is a sentence about the PRODUCT rather than about anybody's data.
 * The rule at the top of `scan-flow.ts` is about sentences that describe a
 * database, and this file names areas and option ids, which are vocabulary.
 */

import { AREA_OPTIONS, PROFILE_AREAS } from '@ledar/contracts';

import type { InterviewForm } from '../shared/ipc.js';

/**
 * The set, in the order it is asked.
 *
 * The order is `PROFILE_AREAS` and is not re-stated here. Re-ordering is a
 * decision about what a person meets first, and it belongs next to the note
 * in the contract explaining why there are five of them — not in a second
 * list that would agree with the first until somebody edited one.
 */
export function interviewForm(): InterviewForm {
  return {
    questions: PROFILE_AREAS.map((area) => ({
      area,
      // Copied out of the record rather than referenced, so nothing across
      // the bridge holds a live handle on a contract value. `jobs` yields an
      // empty array, which is the §18 decision — asks its question and offers
      // no list — travelling intact rather than arriving as an absence.
      options: [...AREA_OPTIONS[area]],
    })),
  };
}
