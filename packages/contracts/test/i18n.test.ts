/**
 * The gate on a half-translated report.
 *
 * `i18n.ts` claims that a report which is Vietnamese except for three
 * sentences nobody remembered is worse than an English one, because the reader
 * stops trusting the half they can read. A claim like that is worth nothing
 * unless something fails when it stops being true.
 *
 * Two things could make it stop being true, and they fail differently:
 *
 *   a key added to `MessageKey` and to only one catalogue   → does not compile
 *   a key added to both, with the English pasted into `vi`  → this file
 *
 * The first needs no test: `Catalog` is `Record<MessageKey, …>` over a closed
 * union, so the compiler refuses. The second compiles perfectly and ships a
 * report with an English sentence in the middle of it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGS, isLang, langFromEnv, num, t, translator } from '../src/i18n.js';
import type { MessageKey, Params } from '../src/i18n.js';
import { EN } from '../src/messages/en.js';

/**
 * Arguments broad enough that every message renders.
 *
 * One object for all keys rather than a table per key: a message that ignores
 * a parameter is unharmed by its presence, and a table would have to be
 * updated in step with the catalogue — which is the maintenance burden this
 * test exists to remove.
 */
const EVERY_PARAM: Params = {
  user: 'ledar_reader',
  // Parameters that carry ALREADY-TRANSLATED text are neutral placeholders,
  // not English. `enforcement`, `problem`, `held` and `boundary` are filled at
  // runtime with the output of another `t()` call, so putting English prose in
  // them here makes the function-word check below fail on the fixture rather
  // than on the catalogue — which is a test reporting its own arguments.
  enforcement: '<<enforcement>>',
  // `share` is one of them: shareInWords() renders it through this same
  // catalogue before it is interpolated.
  share: '<<share>>',
  empty: 18,
  total: 36,
  checked: 12,
  eligible: 12,
  count: 3,
  rules: 1,
  visible: 8,
  unexamined: 2,
  tables: 8,
  readable: 8,
  schemas: 'public',
  more: '',
  rule: 'layer-a/index-not-enforcing',
  hole: '',
  where: 'public',
  name: 'some_fkey',
  table: 'public.votes',
  parent: 'posts',
  parentColumn: 'public.posts.id',
  column: 'post_id',
  columns: 'post_id',
  rows: '6459',
  definition: 'CHECK (x >= 0)',
  detail: '<<detail>>',
  boundary: '<<boundary>>',
  target: 'public.votes.post_id',
  severity: 'high',
  considered: 1,
  verified: 1,
  smallest: '9,828',
  floor: '0.03',
  queries: '14',
  seconds: '0.4',
  residual: '6,459',
  present: '49,148',
  carry: '<<carry>>',
  pct: '13.1',
  rate: '86.9',
  distinct: 15157,
  how: '<<how>>',
  aside: '',
  valid: 'false',
  ready: 'true',
  unique: 1,
  sentence: 'x',
  run: 4,
  file: 'C:\\ledar\\history.db',
  problem: '<<problem>>',
  version: 1,
  to: 'C:\\ledar\\history.v1.db',
  held: '<<held>>',
  seed: 537039,
  estimated: '60,000',
  runs: 11,
};

const KEYS = Object.keys(EN) as MessageKey[];

describe('the message catalogues', () => {
  // 🟥 FOUR TESTS STOOD IN THIS BLOCK UNTIL 2026-08-27 and went with `vi.ts`.
  // Named, not deleted quietly — three of them were the reason this file
  // exists, and what they watched is now unwatched:
  //
  //   'covers every key in both languages'
  //       Belt and braces over `Catalog`. The compiler half still holds for
  //       whatever languages exist, so this lost the least.
  //   'never leaves an English sentence in the Vietnamese catalogue'
  //       The one this file was written for: a key pasted from en.ts into
  //       vi.ts compiles, passes everything else, and ships a report that is
  //       translated apart from one paragraph.
  //   'does not leave English function words in Vietnamese prose'
  //       The half-translated message — an English clause inside a translated
  //       sentence. Coarser, and caught a different mistake.
  //   'groups numbers the way each language reads them'
  //       Replaced rather than lost: `num` now reads a `Record<Lang, string>`,
  //       so a language added without a locale fails to COMPILE, which is
  //       stronger than the assertion was.
  //
  // ⚠️ A second language must not arrive without the first three arriving with
  // it. They are cheap, they are written down here, and the fault they catch —
  // a report that is one language except for the parts nobody remembered — is
  // the one `i18n.ts` calls worse than not translating at all.

  it('has the keys the compiler was told it has, and enough of them', () => {
    assert.ok(KEYS.length > 60, `only ${KEYS.length} messages — did a merge drop some?`);
  });

  it('renders every message in every language without throwing', () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        const out = t(lang, key, EVERY_PARAM);
        assert.equal(typeof out, 'string', `${lang}/${key} did not return a string`);
        assert.ok(out.trim().length > 0, `${lang}/${key} rendered empty`);
      }
    }
  });

  it('groups numbers the way this language reads them', () => {
    assert.equal(num(45822187, 'en'), '45,822,187');
  });
});

describe('choosing a language', () => {
  it('defaults to English when nothing asks otherwise', () => {
    // English even for a Vietnamese operator. A report is evidence about
    // someone's database, and the person reading it later may not be the
    // person who ran it, so the choice is explicit rather than inferred.
    assert.equal(langFromEnv({}), 'en');
    assert.equal(langFromEnv({ LEDAR_LANG: '' }), 'en');
    assert.equal(langFromEnv({ LEDAR_LANG: 'klingon' }), 'en');
  });

  it('takes the language it was given', () => {
    assert.equal(langFromEnv({ LEDAR_LANG: 'en' }), 'en');
    assert.equal(langFromEnv({ LEDAR_LANG: ' EN ' }), 'en');
  });

  it('🟥 a language that was removed lands where any unknown one lands', () => {
    // `LEDAR_LANG=vi` worked until 2026-08-27 and is in shell profiles and in
    // old runbooks. It renders English now, silently, exactly as `klingon`
    // does — and that is the decided behaviour rather than an oversight: a
    // function returning a `Lang` has nowhere to put a warning, and one
    // channel invented for one retired value outlives its reason.
    //
    // Pinned so the silence is a choice somebody made and can find, not a gap.
    assert.equal(langFromEnv({ LEDAR_LANG: 'vi' }), 'en');
  });

  it('knows which strings name a language', () => {
    assert.ok(isLang('en'));
    assert.ok(!isLang('vi'), 'vi was removed 2026-08-27 and must not name a language');
    assert.ok(!isLang('en-GB'));
  });

  it('refuses an unknown key instead of printing it', () => {
    // Returning the key would put `scan.cost` on the page where a sentence
    // belongs, and a report that shipped saying `scan.cost` is a report a test
    // only catches if it happens to read that line.
    const T = translator('en');
    assert.throws(
      () => T('scan.definitely-not-a-key' as MessageKey),
      /No message for/,
    );
  });
});
