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
import { VI } from '../src/messages/vi.js';

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
  it('covers every key in both languages', () => {
    // Belt and braces over the compiler. `Catalog` already forces this, but a
    // future `Partial<Catalog>` or an `as Catalog` would quietly remove the
    // guarantee, and this is the assertion that would notice.
    assert.deepEqual(
      Object.keys(EN).sort(),
      Object.keys(VI).sort(),
      'the two catalogues do not carry the same keys',
    );
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

  it('never leaves an English sentence in the Vietnamese catalogue', () => {
    // The failure this file exists for. A key pasted from en.ts into vi.ts
    // compiles, passes every other assertion here, and ships a report that is
    // Vietnamese apart from one paragraph.
    const untranslated = KEYS.filter(
      (key) => t('vi', key, EVERY_PARAM) === t('en', key, EVERY_PARAM),
    );

    assert.deepEqual(
      untranslated,
      [],
      `these messages read identically in both languages, which means they ` +
        `were never translated:\n  ${untranslated.join('\n  ')}\n\n` +
        `If a message genuinely must be identical — a bare identifier, say — ` +
        `it does not belong in the catalogue at all; interpolate it into a ` +
        `message that does.`,
    );
  });

  it('does not leave English function words in Vietnamese prose', () => {
    // Coarser than the check above and catches a different mistake: a message
    // translated halfway, with an English clause left inside a Vietnamese
    // sentence. Deliberately a short list of words that cannot appear in a
    // Postgres identifier, so table and column names passed in as parameters
    // do not trip it.
    const ENGLISH_ONLY = [
      ' the ',
      ' that ',
      ' which ',
      ' would ',
      ' cannot ',
      ' nothing ',
      ' because ',
      ' whether ',
    ];

    const offenders: string[] = [];
    for (const key of KEYS) {
      const said = ` ${t('vi', key, EVERY_PARAM).toLowerCase()} `;
      for (const word of ENGLISH_ONLY) {
        if (said.includes(word)) offenders.push(`${key} contains "${word.trim()}"`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `English clauses survive inside Vietnamese messages:\n  ` +
        `${offenders.join('\n  ')}`,
    );
  });

  it('groups numbers the way each language reads them', () => {
    // 45,822,187 shown to a Vietnamese reader asks them to parse a decimal
    // point in the wrong place.
    assert.equal(num(45822187, 'en'), '45,822,187');
    assert.equal(num(45822187, 'vi'), '45.822.187');
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
    assert.equal(langFromEnv({ LEDAR_LANG: 'vi' }), 'vi');
    assert.equal(langFromEnv({ LEDAR_LANG: ' VI ' }), 'vi');
  });

  it('knows which strings name a language', () => {
    assert.ok(isLang('en'));
    assert.ok(isLang('vi'));
    assert.ok(!isLang('en-GB'));
  });

  it('refuses an unknown key instead of printing it', () => {
    // Returning the key would put `scan.cost` on the page where a sentence
    // belongs, and a report that shipped saying `scan.cost` is a report a test
    // only catches if it happens to read that line.
    const T = translator('vi');
    assert.throws(
      () => T('scan.definitely-not-a-key' as MessageKey),
      /No message for/,
    );
  });
});
