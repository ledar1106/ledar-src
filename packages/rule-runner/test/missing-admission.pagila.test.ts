/**
 * What "empty" means for one column — proved on rows, not asserted in prose.
 *
 * ## What this suite is for
 *
 * `is-never-missing` had its meaning written down twice: a sentence in the
 * message catalogue and a predicate in this package. They disagreed and it
 * shipped. Making them agree by hand was rejected as the fix, and rightly:
 * two implementations of one meaning drift, and the next drift happens before
 * anyone is watching.
 *
 * So both now derive from one closed value, `MissingAdmission`. The compiler
 * proves each side is TOTAL over that value — add a member and both switches
 * fail to build. What the compiler cannot prove is that the two sides say the
 * SAME THING about a row, and that is the only property anybody was ever
 * hurt by. That is this file.
 *
 * ## 🟥 What changed on 2026-08-27, and what this suite had to grow
 *
 * The admission used to be decided on `information_schema.columns.data_type`,
 * which files every enum, composite, range, multirange and extension type
 * under the single label `USER-DEFINED`. The policy refused all of them. Safe,
 * and too broad: that label is about ORIGIN, not about MEANING, and refusing
 * an enum because enums and composites share a label is coarse metadata
 * deciding what the product can do.
 *
 * The decision now reads `pg_type.typtype` and follows a domain to its base.
 * So this suite has to measure three things it never did before:
 *
 * ```text
 * ① the LETTERS are what the policy thinks they are   — asked of Postgres
 * ② every TYPE in this database lands where its kind  — swept, not sampled
 *   says it should
 * ③ the domain WALK is the one the product runs       — `readColumnType`,
 *                                                       not a copy of it
 * ```
 *
 * ## 🟥 Why the probes exist, and why they are not a convenience
 *
 * The sentence the audit asked for by name promises that *a value of nothing
 * but blank spaces counts as nothing recorded*. Measured on the fixture,
 * 2026-08-27:
 *
 * ```text
 * every text column in every base table of Pagila
 *   rows with a whitespace-only value ................ 0
 * ```
 *
 * There is no row anywhere in the fixture that can tell a predicate counting
 * blanks apart from one that does not. Against live rows alone, that half of
 * the sentence is unmeasurable — and a suite that reports it as covered would
 * be §4.24 exactly: green because nothing changed.
 *
 * So the predicate is put to the database over a set of PROBE VALUES, bound
 * as parameters, on the same read-only connection. Nothing is written. The
 * probe supplies the case the fixture does not hold, and it is the only
 * instrument here that can measure the axis the drift actually happened on.
 * The same instrument now carries an enum value, an empty range and a
 * domain-typed value, for the same reason.
 *
 * ## Where the type comes from, and how this suite pins that
 *
 * `SchemaCatalog` carries column NAMES and nothing else — there is no type in
 * it to trust or distrust. So when three columns of the SAME table, sealed
 * against the SAME catalogue entry, are admitted three different ways, the
 * difference cannot have come from anywhere but a live read of the catalog on
 * the connection the count runs on.
 *
 * ## ⚠️ What this fixture cannot show, said once, up front
 *
 * Measured on `ledar-pagila` (PostgreSQL 18.6) on 2026-08-27, and asserted
 * below rather than left as a claim:
 *
 * ```text
 * columns declared with a COMPOSITE type ....................... 0
 * columns declared with a RANGE or MULTIRANGE type ............. 0
 * base types outside pg_catalog that are not array types ....... 0
 * types belonging to any extension ............................. 0
 * domains whose base type is itself a domain ................... 0
 * ```
 *
 * Those five decisions therefore have no live COLUMN to run against here.
 * Each is measured on real catalog rows instead — every composite type in the
 * database is put to the classifier, not a hand-written stand-in — and the
 * REFUSAL ORDERING they share is measured end to end on the two live columns
 * that do exercise it: `public.film.fulltext` (a base type nobody decided)
 * and `pg_catalog.pg_attribute.attmissingval` (a pseudo-type).
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import type { Client } from 'pg';

import { QueryBudget, quoteIdent } from '@ledar/connector-postgres';
import {
  DOMAIN_FOLLOW_LIMIT,
  LANGS,
  MISSING_ADMISSIONS,
  admitMissing,
  followDomains,
  missingMeaningSentence,
  sealRule,
} from '@ledar/contracts';
import type { Lang, MissingAdmission, PgTypeLink, SchemaCatalog } from '@ledar/contracts';
import { announceSkip, openPagila } from '@ledar/test-fixtures';

import {
  USER_RULE_VERSION,
  UnsupportedColumnType,
  buildRuleQuery,
  missingPredicate,
  readColumnType,
  runRule,
} from '../src/index.js';

const SUITE = 'what missing means, against Pagila';

/**
 * Names only. This is the whole point of the arrangement: there is no type
 * here for the runner to read, so any type it acts on came off the wire.
 */
const CATALOG: SchemaCatalog = {
  'public.address': ['address_id', 'address2', 'district'],
  'public.film': [
    'film_id',
    'title',
    'original_language_id',
    'special_features',
    'rating',
    'release_year',
    'fulltext',
  ],
  // Not Pagila. A pseudo-typed column, which the fixture has nowhere else and
  // which is one of the kinds the policy refuses on purpose. `pg_attribute` is
  // world-readable, so this costs no privilege the scan does not already have.
  'pg_catalog.pg_attribute': ['attname', 'attmissingval'],
  // A domain over a text type. No BASE TABLE in this fixture has one; this
  // view column is the only live example, and saying so is cheaper than
  // pretending the base tables cover it.
  'information_schema.columns': ['column_name', 'data_type'],
};

// ---------------------------------------------------------------------------
// The probes.
//
// One named value per case any of the four sentences says something about.
// `cast` is a fixed string written here — never assembled from anything read
// — and the VALUE is always bound, so a probe cannot become a way to put
// something into a query.
// ---------------------------------------------------------------------------

type ProbeCast =
  | '::text'
  | '::int'
  | '::text[]'
  | '::jsonb'
  | '::public.mpaa_rating'
  | '::int4range'
  | '::public.year';

type Probe = {
  readonly label: string;
  readonly cast: ProbeCast;
  readonly value: unknown;
};

const NO_VALUE_AT_ALL: Probe = { label: 'no value at all', cast: '::text', value: null };
const AN_EMPTY_STRING: Probe = { label: 'an empty string', cast: '::text', value: '' };
const ONLY_BLANK_SPACES: Probe = { label: 'three blank spaces', cast: '::text', value: '   ' };
const AN_ORDINARY_WORD: Probe = { label: 'an ordinary word', cast: '::text', value: 'ledar' };
const NO_NUMBER_AT_ALL: Probe = { label: 'no number at all', cast: '::int', value: null };
const THE_NUMBER_ZERO: Probe = { label: 'the number zero', cast: '::int', value: 0 };
const NO_LIST_AT_ALL: Probe = { label: 'no list at all', cast: '::text[]', value: null };
const AN_EMPTY_LIST: Probe = { label: 'an empty list', cast: '::text[]', value: [] };
const A_LIST_OF_ONE: Probe = { label: 'a list holding one item', cast: '::text[]', value: ['a'] };
const AN_EMPTY_JSON_OBJECT: Probe = {
  label: 'an empty json object',
  cast: '::jsonb',
  value: '{}',
};
// The enum. `mpaa_rating` is `film.rating`'s type, and `G` is one of its
// labels — a value a real row of Pagila holds.
const NO_CHOICE_AT_ALL: Probe = {
  label: 'no choice at all',
  cast: '::public.mpaa_rating',
  value: null,
};
const A_CHOICE_FROM_THE_LIST: Probe = {
  label: 'a choice from the list',
  cast: '::public.mpaa_rating',
  value: 'G',
};
// The range. `'empty'` is the empty range, and it is the case the structured
// sentence had to be rewritten to promise something about.
const NO_RANGE_AT_ALL: Probe = { label: 'no range at all', cast: '::int4range', value: null };
const AN_EMPTY_RANGE: Probe = { label: 'an empty range', cast: '::int4range', value: 'empty' };
const A_RANGE_OF_ONE: Probe = { label: 'a range holding one number', cast: '::int4range', value: '[1,2)' };
// A DOMAIN-typed value. `public.year` is a domain over `integer`, and it is
// the type of `film.release_year`.
const NO_YEAR_AT_ALL: Probe = { label: 'no year at all', cast: '::public.year', value: null };
const AN_ORDINARY_YEAR: Probe = { label: 'an ordinary year', cast: '::public.year', value: 2006 };

type Promised = {
  /** Whether a query is built at all. `unsupported` builds none. */
  readonly runs: boolean;
  /** Values this admission's sentence promises to count as nothing recorded. */
  readonly counts: readonly Probe[];
  /** Values it promises to leave alone, because somebody recorded them. */
  readonly keeps: readonly Probe[];
};

/**
 * What each sentence promises, as rows a database can be asked about.
 *
 * `satisfies Record<MissingAdmission, …>` on purpose: adding a member to the
 * union breaks this table at compile time, so a new admission cannot arrive
 * with its behaviour unmeasured.
 *
 * 🟥 `scalar` is probed with a blank even though a number column cannot hold
 * one. That is deliberate and it is the point: a type that cannot express
 * blankness can never demonstrate that the rule DECLINES to count it, so the
 * probe supplies the case the type forbids and asks the predicate what it
 * would say. This is the exact axis the two implementations drifted on.
 *
 * 🟥 `scalar` is also probed with an ENUM and a DOMAIN value, and `structured`
 * with a RANGE, because those three joined their groups on 2026-08-27. A
 * group that widened without its probes widening is a group whose new members
 * are unmeasured.
 */
const PROMISE = {
  text: {
    runs: true,
    counts: [NO_VALUE_AT_ALL, AN_EMPTY_STRING, ONLY_BLANK_SPACES],
    keeps: [AN_ORDINARY_WORD],
  },
  scalar: {
    runs: true,
    counts: [NO_NUMBER_AT_ALL, NO_CHOICE_AT_ALL, NO_YEAR_AT_ALL],
    keeps: [
      THE_NUMBER_ZERO,
      AN_EMPTY_STRING,
      ONLY_BLANK_SPACES,
      A_CHOICE_FROM_THE_LIST,
      AN_ORDINARY_YEAR,
    ],
  },
  structured: {
    runs: true,
    counts: [NO_LIST_AT_ALL, NO_RANGE_AT_ALL],
    keeps: [AN_EMPTY_LIST, A_LIST_OF_ONE, AN_EMPTY_JSON_OBJECT, AN_EMPTY_RANGE, A_RANGE_OF_ONE],
  },
  unsupported: { runs: false, counts: [], keeps: [] },
} satisfies Record<MissingAdmission, Promised>;

/**
 * How each language writes the case that started all of this.
 *
 * ⚠️ Stated limit, so nobody reads more into the assertion below than it
 * carries: this half reads WORDS. It catches the sentence being deleted, or
 * pasted between admissions, or a predicate quietly gaining or losing the
 * blank clause. It does not catch a rephrase into a synonym. The half that
 * measures behaviour is the probe run, and that one is not a word check.
 */
const BLANK_IN_WORDS: Record<Lang, string> = { en: 'blank spaces', vi: 'dấu cách' };

/**
 * The words each rewritten sentence had to gain when its group widened.
 *
 * Same stated limit as `BLANK_IN_WORDS`: a word check catches a revert, not a
 * rephrase. It is here because the revert is the realistic accident — the old
 * scalar sentence said *"a number, a date or a yes-or-no"*, which is FALSE of
 * `film.rating`, and it would read perfectly well to anyone not holding an
 * enum column in mind.
 */
const WIDENED_IN_WORDS: Record<Lang, { scalar: string; structured: string }> = {
  en: { scalar: 'choice', structured: 'range' },
  vi: { scalar: 'lựa chọn', structured: 'khoảng' },
};

/**
 * 🟥 The join between a kind of type and the words its group promises.
 *
 * Neither half of this is new; the JOIN is. `WIDENED_IN_WORDS` asks whether a
 * sentence contains a word, and the sweep asks whether a type lands in a
 * group. Neither notices when a type is moved into a group whose sentence
 * says nothing about it — and `text` and `structured` share no probe that can
 * tell them apart on rows, so moving ranges into `text` is invisible to every
 * behavioural assertion in this file.
 *
 * Stated as a law it is visible from both directions: a range must land in a
 * group whose sentence mentions a range, so changing the CLASSIFICATION goes
 * red, and so does deleting the word from the SENTENCE.
 *
 * ⚠️ Still a word check, with the limit `BLANK_IN_WORDS` already carries: it
 * catches a revert or a move, not a rephrase into a synonym.
 */
const SENTENCE_MUST_NAME: readonly {
  readonly what: string;
  readonly member: (t: CatalogType) => boolean;
  readonly words: Record<Lang, string>;
}[] = [
  {
    what: 'an enum',
    member: (t) => t.typtype === 'e',
    words: { en: 'choice', vi: 'lựa chọn' },
  },
  {
    what: 'a range or multirange',
    member: (t) => t.typtype === 'r' || t.typtype === 'm',
    words: { en: 'range', vi: 'khoảng' },
  },
  {
    what: 'an array',
    member: (t) => t.typtype === 'b' && t.isArray,
    words: { en: 'list', vi: 'danh sách' },
  },
];

/** One row of the whole-catalog sweep: a type, its facts, and its base. */
type CatalogType = PgTypeLink & { readonly oid: string; readonly baseOid: string };

const gate = await openPagila();

if (!gate.ok) {
  announceSkip(SUITE, gate.reason);
  // An `it`-level skip, never a `describe`-level one: a `describe` skip moves
  // no counter and reads as a clean pass. HANDOFF-STATUS §1b leans on
  // `skipped > 0` being visible.
  describe(`${SUITE} — not run`, () => {
    it('no admission was measured against a real database', { skip: gate.reason }, () => {
      // Deliberately empty. `skipped > 0` is not green.
    });
  });
} else {
  const client: Client = gate.client;
  after(async () => {
    await client.end().catch(() => undefined);
  });

  /** Asks the database what the real predicate says about one probe value. */
  async function saysMissing(admission: MissingAdmission, probe: Probe): Promise<boolean> {
    const predicate = missingPredicate(quoteIdent('v'), admission);
    const res = await client.query(
      `SELECT (${predicate}) AS missing FROM (SELECT $1${probe.cast} AS v) t`,
      [probe.value],
    );
    return (res.rows[0] as { missing: boolean }).missing === true;
  }

  /** What `information_schema` says today, on this connection. */
  async function liveDataType(
    schema: string,
    table: string,
    column: string,
  ): Promise<string | null> {
    const res = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3`,
      [schema, table, column],
    );
    return res.rows.length === 0 ? null : String((res.rows[0] as { data_type: string }).data_type);
  }

  /** One number out of the fixture, for a claim this file makes about it. */
  async function countOf(sql: string, params: readonly unknown[] = []): Promise<number> {
    const res = await client.query(sql, [...params]);
    return Number((res.rows[0] as { n: number }).n);
  }

  /** Every type in this database, with the facts the policy is allowed to see. */
  async function everyType(): Promise<CatalogType[]> {
    const res = await client.query(`
      SELECT t.oid::text AS oid,
             t.typbasetype::text AS base_oid,
             t.typtype AS typtype,
             t.typname AS type_name,
             n.nspname AS type_schema,
             pg_catalog.format_type(t.oid, NULL) AS spelling,
             (t.typelem <> 0 AND t.typlen = -1) AS is_array,
             (SELECT e.extname
                FROM pg_catalog.pg_depend d
                JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
               WHERE d.classid = 'pg_type'::regclass
                 AND d.objid = t.oid
                 AND d.refclassid = 'pg_extension'::regclass
                 AND d.deptype = 'e'
               LIMIT 1) AS extension
      FROM pg_catalog.pg_type t
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    `);
    return (res.rows as Record<string, unknown>[]).map((r) => ({
      oid: String(r.oid),
      baseOid: String(r.base_oid),
      typtype: String(r.typtype),
      name: String(r.type_name),
      schema: String(r.type_schema),
      spelling: String(r.spelling),
      isArray: r.is_array === true,
      extension: r.extension === null ? null : String(r.extension),
    }));
  }

  describe(SUITE, () => {
    // -----------------------------------------------------------------------
    // 🟥 The agreement guard. The reason the refactor exists.
    // -----------------------------------------------------------------------

    it('🟥 every admission behaves the way its own sentence promises', async () => {
      // Iterating MISSING_ADMISSIONS rather than a list written here: a member
      // added to the union arrives in this loop whether or not anybody
      // remembered to add it, and `PROMISE` refuses to compile without it.
      assert.ok(MISSING_ADMISSIONS.length > 0, 'nothing to check — an empty set always passes');

      for (const admission of MISSING_ADMISSIONS) {
        const promised = PROMISE[admission];

        if (!promised.runs) {
          // No predicate exists to measure, and that IS the promise.
          assert.throws(
            () => missingPredicate(quoteIdent('v'), admission),
            UnsupportedColumnType,
            `${admission} produced a predicate; it promised to produce none`,
          );
          continue;
        }

        assert.ok(
          promised.counts.length > 0 && promised.keeps.length > 0,
          `${admission} has nothing on one side of the line, so nothing is discriminated`,
        );

        for (const probe of promised.counts) {
          assert.equal(
            await saysMissing(admission, probe),
            true,
            `${admission} does not count ${probe.label}, but its sentence says it does:\n` +
              `  ${missingMeaningSentence(admission, 'en')}`,
          );
        }
        for (const probe of promised.keeps) {
          assert.equal(
            await saysMissing(admission, probe),
            false,
            `${admission} counts ${probe.label} as missing, but its sentence says ` +
              `somebody recorded it:\n  ${missingMeaningSentence(admission, 'en')}`,
          );
        }
      }
    });

    it('🟥 an empty range, an empty list and an empty json object are VALUES', async () => {
      // Named on its own because the audit named it on its own, and because
      // the three are the whole reason `structured` is not `text`. The loop
      // above already runs them; this one fails with a sentence that says what
      // was actually promised, to whoever reads the failure.
      for (const probe of [AN_EMPTY_RANGE, AN_EMPTY_LIST, AN_EMPTY_JSON_OBJECT]) {
        assert.equal(
          await saysMissing('structured', probe),
          false,
          `${probe.label} was counted as nothing recorded. Somebody wrote it there, ` +
            `and counting it would be this product disagreeing with the database ` +
            `about what the row holds.`,
        );
      }
      // And the same values are not vacuously non-missing: the admission does
      // still count the absence of one. §4.3 — an assertion that can only pass
      // proves nothing.
      assert.equal(await saysMissing('structured', NO_RANGE_AT_ALL), true);
      assert.equal(await saysMissing('structured', NO_LIST_AT_ALL), true);
    });

    it('🟥 the sentence and the predicate name the same blank, in both languages', async () => {
      // The other direction of the same guard. Above asks whether the
      // predicate does what the sentence says; this asks whether the sentence
      // that says it is the only sentence that says it — and whether the
      // predicate that does it is the only predicate that does it.
      const predicateCountsBlank: MissingAdmission[] = [];
      for (const admission of MISSING_ADMISSIONS) {
        if (!PROMISE[admission].runs) continue;
        if (await saysMissing(admission, ONLY_BLANK_SPACES)) predicateCountsBlank.push(admission);
      }

      assert.ok(
        predicateCountsBlank.length > 0,
        'no predicate counts a blank at all, so this assertion compares two empty sets',
      );

      for (const lang of LANGS) {
        const sentenceNamesBlank = MISSING_ADMISSIONS.filter((admission) =>
          missingMeaningSentence(admission, lang).toLowerCase().includes(BLANK_IN_WORDS[lang]),
        );
        assert.deepEqual(
          sentenceNamesBlank,
          predicateCountsBlank,
          `in ${lang}, the admissions whose sentence names blank spaces are not the ` +
            `admissions whose predicate counts one. One side moved without the other, ` +
            `which is the drift this whole arrangement exists to stop.`,
        );
      }
    });

    it('says something different, in both languages, for every admission', async () => {
      // A key deleted, emptied, or pasted from one admission to another. The
      // catalogue-wide EN/VI gate lives in `@ledar/contracts`; this is the
      // narrower claim that these four in particular are four sentences.
      const seen = new Map<string, MissingAdmission>();
      for (const lang of LANGS) {
        seen.clear();
        for (const admission of MISSING_ADMISSIONS) {
          const said = missingMeaningSentence(admission, lang);
          assert.ok(said.trim().length > 0, `${lang}/${admission} rendered empty`);
          const already = seen.get(said);
          assert.equal(
            already,
            undefined,
            `${lang}: ${admission} and ${already} read identically, so one of them ` +
              `describes behaviour it does not have`,
          );
          seen.set(said, admission);
        }
        assert.notEqual(
          missingMeaningSentence('text', 'en'),
          missingMeaningSentence('text', 'vi'),
          'the two languages carry the same bytes, so one was never translated',
        );
      }
    });

    it('the blank-spaces sentence exists and says so in plain words', async () => {
      // Asked for by name in the audit. The person confirming a rule is
      // entitled to the narrower reading of "empty" in writing, before the
      // query runs.
      for (const lang of LANGS) {
        assert.match(
          missingMeaningSentence('text', lang).toLowerCase(),
          new RegExp(BLANK_IN_WORDS[lang]),
          `the ${lang} sentence for a text column does not mention blank spaces`,
        );
      }
    });

    it('🟥 the sentence an enum inherits is not one that is false about an enum', async () => {
      // `film.rating` now runs under the `scalar` sentence. The sentence it
      // would have inherited said "this column holds a number, a date or a
      // yes-or-no", which is false of an enum — and the read-back is the one
      // control in this design that has to be READ, so a sentence that is
      // wrong about the column it describes is the failure mode, not a typo.
      //
      // Same for `structured` and a range: the old wording promised only that
      // "an empty list" is a value and said nothing about an empty range.
      for (const lang of LANGS) {
        assert.match(
          missingMeaningSentence('scalar', lang).toLowerCase(),
          new RegExp(WIDENED_IN_WORDS[lang].scalar),
          `the ${lang} scalar sentence never mentions a choice from a fixed set, so it ` +
            `is describing only the types that were in this group before enums joined it`,
        );
        assert.match(
          missingMeaningSentence('structured', lang).toLowerCase(),
          new RegExp(WIDENED_IN_WORDS[lang].structured),
          `the ${lang} structured sentence never mentions a range, so it promises ` +
            `nothing about the empty range the predicate keeps`,
        );
      }
    });

    // -----------------------------------------------------------------------
    // 🟥 The letters. The brief said not to take anybody's word for them.
    // -----------------------------------------------------------------------

    it('🟥 pg_type.typtype spells each kind the way this policy reads it', async () => {
      // Every row here is checked TWICE: once for the letter, and once against
      // a catalog fact that identifies the kind without using `typtype` at
      // all. A letter alone would be this test believing the same thing the
      // policy believes.
      const expected: readonly {
        schema: string;
        name: string;
        letter: string;
        kind: string;
        /** A second, independent way of knowing what kind this type is. */
        corroboration: string;
      }[] = [
        {
          schema: 'pg_catalog',
          name: 'text',
          letter: 'b',
          kind: 'base',
          corroboration: `t.typbasetype = 0 AND t.typrelid = 0 AND t.typtype <> 'p'`,
        },
        {
          // ⚠️ The rowtype of the `film` table, and that is not a second-best
          // example: measured 2026-08-27, every one of the composite types in
          // this database is a relation's rowtype, because nothing here was
          // built with `CREATE TYPE … AS (…)`. A column CAN be declared
          // `public.film`, which is exactly the case the policy refuses.
          schema: 'public',
          name: 'film',
          letter: 'c',
          kind: 'composite',
          // `typrelid` points at the relation whose shape this type is, and it
          // is 0 for every other kind. Measured on this fixture: 0 composites
          // with `typrelid = 0`, and 0 non-composites with `typrelid <> 0`.
          corroboration: `t.typrelid <> 0`,
        },
        {
          schema: 'information_schema',
          name: 'cardinal_number',
          letter: 'd',
          kind: 'domain',
          corroboration: `t.typbasetype <> 0`,
        },
        {
          schema: 'public',
          name: 'mpaa_rating',
          letter: 'e',
          kind: 'enum',
          corroboration: `EXISTS (SELECT 1 FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid)`,
        },
        {
          schema: 'pg_catalog',
          name: 'int4multirange',
          letter: 'm',
          kind: 'multirange',
          corroboration: `EXISTS (SELECT 1 FROM pg_catalog.pg_range r
                                   WHERE r.rngmultitypid = t.oid)`,
        },
        {
          schema: 'pg_catalog',
          name: 'record',
          letter: 'p',
          kind: 'pseudo',
          corroboration: `t.typcategory = 'P'`,
        },
        {
          schema: 'pg_catalog',
          name: 'int4range',
          letter: 'r',
          kind: 'range',
          corroboration: `EXISTS (SELECT 1 FROM pg_catalog.pg_range r WHERE r.rngtypid = t.oid)`,
        },
      ];

      for (const want of expected) {
        const res = await client.query(
          `SELECT t.typtype AS typtype, (${want.corroboration}) AS corroborated
             FROM pg_catalog.pg_type t
             JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
            WHERE n.nspname = $1 AND t.typname = $2`,
          [want.schema, want.name],
        );
        assert.equal(
          res.rows.length,
          1,
          `${want.schema}.${want.name} is not in this database, so the ${want.kind} ` +
            `letter was never actually checked against anything`,
        );
        const row = res.rows[0] as { typtype: string; corroborated: boolean };
        assert.equal(
          row.corroborated,
          true,
          `${want.schema}.${want.name} was picked as the ${want.kind} example and the ` +
            `catalog does not agree that it is one`,
        );
        assert.equal(
          row.typtype,
          want.letter,
          `Postgres spells ${want.kind} as ${JSON.stringify(row.typtype)}, and this ` +
            `policy reads ${JSON.stringify(want.letter)}`,
        );
      }
    });

    // -----------------------------------------------------------------------
    // 🟥 Every type in the database, not a handful somebody chose.
    // -----------------------------------------------------------------------

    it('🟥 every type in this database is admitted by what it IS', async () => {
      const types = await everyType();
      assert.ok(types.length > 0, 'no types were read, so this sweep examined nothing');

      const byOid = new Map(types.map((t) => [t.oid, t]));
      // The sweep builds chains in memory, and that is a SECOND walk beside
      // the one `COLUMN_TYPE_SQL` runs. Deliberate, and the two measure
      // different claims: this one asks whether the POLICY obeys its own
      // classification over every type that exists, and the live-column tests
      // below ask whether the QUERY hands the policy the right chain. Neither
      // stands in for the other. The cap is shared so the two agree on what
      // "too deep" means.
      const chainOf = (t: CatalogType): PgTypeLink[] => {
        const out: PgTypeLink[] = [];
        let cur: CatalogType | undefined = t;
        for (let hop = 0; cur !== undefined && hop <= DOMAIN_FOLLOW_LIMIT; hop += 1) {
          out.push(cur);
          if (cur.typtype !== 'd') break;
          cur = byOid.get(cur.baseOid);
        }
        return out;
      };

      /** Runs one class law, and refuses to be green over an empty class. */
      const law = (
        what: string,
        member: (t: CatalogType) => boolean,
        expect: MissingAdmission,
      ): number => {
        const group = types.filter(member);
        assert.ok(group.length > 0, `no ${what} in this database, so its law proved nothing`);
        for (const t of group) {
          assert.equal(
            admitMissing(chainOf(t)),
            expect,
            `${t.schema}.${t.name} is ${what} and was admitted as ` +
              `${admitMissing(chainOf(t))}, not ${expect}`,
          );
        }
        return group.length;
      };

      law('an enum', (t) => t.typtype === 'e', 'scalar');
      law('a range', (t) => t.typtype === 'r', 'structured');
      law('a multirange', (t) => t.typtype === 'm', 'structured');
      law('a composite', (t) => t.typtype === 'c', 'unsupported');
      law('a pseudo-type', (t) => t.typtype === 'p', 'unsupported');
      law('an array', (t) => t.typtype === 'b' && t.isArray, 'structured');

      // The domain law is an equation rather than a constant: a domain gets
      // whatever its base type gets. Stated this way it stays true when the
      // base's own answer changes, and it goes red the moment a domain stops
      // following anything.
      const domains = types.filter((t) => t.typtype === 'd');
      assert.ok(domains.length > 0, 'no domains in this database, so the follow law proved nothing');
      for (const d of domains) {
        const chain = chainOf(d);
        assert.ok(chain.length > 1, `${d.schema}.${d.name} is a domain with no base in the chain`);
        assert.equal(
          admitMissing(chain),
          admitMissing(chain.slice(1)),
          `${d.schema}.${d.name} does not answer the way its base type ` +
            `${chain[1]!.spelling} answers`,
        );
      }
      // And the follow law is not vacuous: the domains in this database do not
      // all land on one admission. §4.24 — an equation both sides of which are
      // always the same value would be green for the wrong reason.
      const domainAnswers = new Set(domains.map((d) => admitMissing(chainOf(d))));
      assert.ok(
        domainAnswers.size > 1,
        `every domain in this database admits as ${[...domainAnswers].join('/')}, so ` +
          `a policy that ignored base types entirely would pass this law`,
      );

      // 🟥 This asserted `=== 0` until 2026-08-27, and CI proved it wrong the
      // first time it ran: the public workflow builds Pagila on
      // `pgvector/pgvector:pg18`, which ships `vector`, `halfvec` and
      // `sparsevec`. The local fixture is `postgres:18-alpine` and carries
      // none, so the claim held here and failed there — debt N9 exactly, a
      // thing measured on ONE environment.
      //
      // Asserting the absence of examples was the weaker test anyway. It now
      // CLASSIFIES whatever the server happens to carry: true on both
      // fixtures, and stronger on the one that carries more.
      const extensionCandidates = types.filter(
        (t) => t.typtype === 'b' && !t.isArray && t.schema !== 'pg_catalog',
      );
      for (const t of extensionCandidates) {
        const want = t.extension === 'citext' ? 'text' : 'unsupported';
        assert.equal(
          admitMissing([t]),
          want,
          `${t.schema}.${t.name} belongs to ${t.extension ?? 'no extension'} and should ` +
            `admit as ${want}. An extension type nobody has decided about must decline, ` +
            `never be cast to text and hoped over.`,
        );
      }
      // §4.3 — a loop over an empty set is always green, so say which it was.
      // Not asserted either way: one of the two fixtures legitimately has none.
      console.error(
        `    [note] extension base types measured: ${extensionCandidates.length}` +
          (extensionCandidates.length === 0
            ? ' (this server carries none; the CI fixture does)'
            : ` (${extensionCandidates.map((t) => `${t.schema}.${t.name}`).join(', ')})`),
      );
    });

    it('🟥 every kind of type lands in a group whose sentence mentions it', async () => {
      // The join the two halves of this file were missing. `text` and
      // `structured` share no probe that can tell them apart on rows — every
      // structured value this fixture can express renders with visible
      // characters, so the `btrim` clause cannot fire on one — which means
      // moving ranges into `text` changes no measured behaviour anywhere.
      // What it does change is the sentence the person confirming reads, and
      // that is the control this whole policy exists to protect.
      const types = await everyType();
      assert.ok(types.length > 0, 'no types were read, so this law examined nothing');

      for (const rule of SENTENCE_MUST_NAME) {
        const group = types.filter(rule.member);
        assert.ok(
          group.length > 0,
          `no ${rule.what} in this database, so its sentence was never checked`,
        );
        const admissions = new Set(group.map((t) => admitMissing([t])));
        assert.equal(
          admissions.size,
          1,
          `${rule.what} lands in more than one group (${[...admissions].join(', ')}), so ` +
            `no single sentence can be true of all of them`,
        );
        const admission = [...admissions][0]!;
        assert.notEqual(
          admission,
          'unsupported',
          `${rule.what} is refused, so nothing here promises anything about it`,
        );

        for (const lang of LANGS) {
          assert.match(
            missingMeaningSentence(admission, lang).toLowerCase(),
            new RegExp(rule.words[lang]),
            `${rule.what} is admitted as ${admission}, and the ${lang} sentence for ` +
              `${admission} never mentions it:\n  ${missingMeaningSentence(admission, lang)}`,
          );
        }
      }
    });

    // -----------------------------------------------------------------------
    // The mapping, against what the live catalog actually holds.
    // -----------------------------------------------------------------------

    it('🟥 admits on the catalog fact, not on the label information_schema prints', async () => {
      // `data_type` and the admission are asserted side by side on purpose.
      // The row that matters is `film.rating`: one label, `USER-DEFINED`, that
      // used to decide the answer, and an admission that no longer comes from
      // it.
      const expected: readonly [string, string, string, string, MissingAdmission][] = [
        ['public', 'address', 'address2', 'text', 'text'],
        ['public', 'address', 'district', 'text', 'text'],
        ['public', 'film', 'original_language_id', 'integer', 'scalar'],
        ['public', 'film', 'special_features', 'ARRAY', 'structured'],
        // The enum. The label is the same one Postgres puts on composites,
        // ranges and extension types; the admission is not.
        ['public', 'film', 'rating', 'USER-DEFINED', 'scalar'],
        // A domain over `integer`. `information_schema` unwraps exactly one
        // level and only into `pg_catalog`, which is why this label looks
        // ordinary; the admission is reached by following the base type.
        ['public', 'film', 'release_year', 'integer', 'scalar'],
        // A base type in `pg_catalog` that nobody has decided about.
        ['public', 'film', 'fulltext', 'tsvector', 'unsupported'],
        // A pseudo-type, on the only column in the fixture that has one.
        ['pg_catalog', 'pg_attribute', 'attmissingval', 'anyarray', 'unsupported'],
        // A domain over a text type, on the only column in the fixture that
        // has one. No BASE TABLE here exercises this.
        ['information_schema', 'columns', 'column_name', 'name', 'text'],
      ];

      let labelledUserDefinedAndAdmitted = 0;
      for (const [schema, table, column, label, want] of expected) {
        const read = await readColumnType(client, schema, table, column);
        assert.notEqual(
          read.dataType,
          null,
          `${schema}.${table}.${column} is not visible to this role`,
        );
        assert.equal(
          read.dataType,
          label,
          `${schema}.${table}.${column} no longer reports ${label} — the label this ` +
            `test was written against has moved`,
        );
        assert.equal(
          admitMissing(read.chain),
          want,
          `${schema}.${table}.${column} reports data_type ${JSON.stringify(read.dataType)} ` +
            `and resolves to ${read.chain.map((l) => `${l.typtype}:${l.spelling}`).join(' -> ')}`,
        );
        if (label === 'USER-DEFINED' && want !== 'unsupported') labelledUserDefinedAndAdmitted += 1;
      }

      assert.ok(
        labelledUserDefinedAndAdmitted > 0,
        'not one column in this table carries the USER-DEFINED label and still gets an ' +
          'answer, so nothing here measures the change this revision is about',
      );
    });

    it('🟥 a domain follows its base type, and the two live domains disagree', async () => {
      // ⚠️ Only `public.film.release_year` is a BASE TABLE column. The other
      // live domain in this fixture sits on an `information_schema` view. No
      // base table here exercises a domain over a text type, and no relation
      // anywhere exercises a domain over a domain — both stated, both
      // asserted below rather than left as a claim.
      const overInteger = await readColumnType(client, 'public', 'film', 'release_year');
      const overName = await readColumnType(client, 'information_schema', 'columns', 'column_name');

      for (const [what, read] of [
        ['public.film.release_year', overInteger],
        ['information_schema.columns.column_name', overName],
      ] as const) {
        assert.ok(read.chain.length >= 2, `${what} came back with no base type to follow`);
        assert.equal(read.chain[0]!.typtype, 'd', `${what} is not a domain any more`);
        assert.equal(
          followDomains(read.chain),
          read.chain[1],
          `${what} did not resolve to the very next link, so the walk skipped something`,
        );
      }

      assert.equal(admitMissing(overInteger.chain), 'scalar');
      assert.equal(admitMissing(overName.chain), 'text');
      // 🟥 §4.24. Two domains that answered the same way would be passed by a
      // policy that pinned every domain to one admission. They do not.
      assert.notEqual(
        admitMissing(overInteger.chain),
        admitMissing(overName.chain),
        'both live domains admit the same way, so this test cannot tell a policy that ' +
          'follows base types from one that ignores them',
      );

      // The predicate, put to the database over a DOMAIN-typed value. The
      // fixture holds no NULL in `film.release_year`, so the counting query
      // cannot show that the rule would have counted one; the probe can.
      assert.equal(await saysMissing('scalar', NO_YEAR_AT_ALL), true);
      assert.equal(await saysMissing('scalar', AN_ORDINARY_YEAR), false);

      // And the fixture fact the notes above rest on.
      const nestedDomains = await countOf(`
        SELECT count(*)::int AS n
        FROM pg_catalog.pg_type d
        JOIN pg_catalog.pg_type b ON b.oid = d.typbasetype
        WHERE d.typtype = 'd' AND b.typtype = 'd'
      `);
      assert.equal(
        nestedDomains,
        0,
        `this fixture now has ${nestedDomains} domains over domains, so the walk has a ` +
          `live example and the note above is stale`,
      );
    });

    it('a domain chain that never reaches a real type is refused', async () => {
      // No relation in any database on this machine has one, so the case is
      // built out of facts. It is the only branch of the walk that decides
      // what happens when the answer cannot be finished, and fail-closed is
      // not a property that gets to go unmeasured because it is inconvenient
      // to reproduce.
      const domainLink = (n: number): PgTypeLink => ({
        typtype: 'd',
        name: `d${n}`,
        schema: 'public',
        spelling: `public.d${n}`,
        isArray: false,
        extension: null,
      });
      const realText: PgTypeLink = {
        typtype: 'b',
        name: 'text',
        schema: 'pg_catalog',
        spelling: 'text',
        isArray: false,
        extension: null,
      };

      const neverEnds = Array.from({ length: DOMAIN_FOLLOW_LIMIT + 1 }, (_, i) => domainLink(i));
      assert.equal(followDomains(neverEnds), null);
      assert.equal(admitMissing(neverEnds), 'unsupported');

      // And a chain that DOES end resolves, so the assertion above is about
      // the walk running out rather than about domains being refused.
      const endsJustInTime = [...neverEnds.slice(0, DOMAIN_FOLLOW_LIMIT), realText];
      assert.equal(followDomains(endsJustInTime), realText);
      assert.equal(admitMissing(endsJustInTime), 'text');

      // An empty chain is the other way the question cannot be finished: the
      // column is not visible to this role, or is not there at all.
      assert.equal(followDomains([]), null);
      assert.equal(admitMissing([]), 'unsupported');
    });

    it('an extension type nobody decided is refused; citext is the one that is not', async () => {
      // 🟥 This asserted `=== 0` and CI disagreed on its first run: the public
      // fixture is built on `pgvector/pgvector:pg18` and owns six extension
      // types, while the local one is plain `postgres:18-alpine`. The count is
      // still read — a reader should know whether this ran against live
      // examples — but it is no longer a claim about how many a server may
      // have. The classification itself is asserted in the catalog sweep.
      const extensionTypes = await countOf(`
        SELECT count(*)::int AS n
        FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_type'::regclass
          AND d.refclassid = 'pg_extension'::regclass
          AND d.deptype = 'e'
      `);
      console.error(
        `    [note] extension-owned types on this server: ${extensionTypes}` +
          (extensionTypes === 0 ? ' (decision measured over facts below)' : ''),
      );

      const asExtension = (name: string, extension: string | null): PgTypeLink[] => [
        {
          typtype: 'b',
          name,
          schema: 'public',
          spelling: `public.${name}`,
          isArray: false,
          extension,
        },
      ];

      // Decided, and reached by the path that exists. Before this revision
      // `citext` sat in the text list and could never match: the label for an
      // extension type is `USER-DEFINED`, so the name in that list had never
      // once been applied.
      assert.equal(admitMissing(asExtension('citext', 'citext')), 'text');
      // 🟥 A label is not a gate — §4.23. A type CALLED citext that no
      // extension owns is a type somebody at this site wrote by hand.
      assert.equal(admitMissing(asExtension('citext', null)), 'unsupported');
      // And an extension type nobody has decided about.
      assert.equal(admitMissing(asExtension('hstore', 'hstore')), 'unsupported');
    });

    // -----------------------------------------------------------------------
    // End to end, on rows, with the counts derived from the fixture.
    // -----------------------------------------------------------------------

    /** Every rule in this file is the same shape apart from the column. */
    const missingRule = (table: string, column: string) =>
      sealRule(
        {
          expressible: true,
          check: 'is-never-missing',
          table,
          columns: [column],
          references: null,
          unsupported: [],
        },
        CATALOG,
      );

    it('text: counts a blank string — 3 of 1003 in address.district', async () => {
      // Read off the fixture, not off the implementation: `district` holds 3
      // empty strings and 0 nulls in 1003 rows. It is here because address2
      // cannot make this distinction visible in the SMALL — 1003 of 1003 is
      // also what a broken rule that counted every row would say. 3 is not.
      //
      // The scalar rule on this same column would answer 0. That gap is the
      // whole subject of this file, on live rows.
      const out = await runRule(client, missingRule('public.address', 'district'), new QueryBudget());
      assert.equal(out.findings[0]!.evidence?.rowCount, 3);
    });

    it('scalar: NULL only — film.original_language_id is 1000 of 1000', async () => {
      const out = await runRule(
        client,
        missingRule('public.film', 'original_language_id'),
        new QueryBudget(),
      );
      assert.equal(out.findings[0]!.evidence?.rowCount, 1000);
    });

    it('structured: an empty list is a value — film.special_features is 0 of 1000', async () => {
      // ⚠️ Read this number for what it is. Pagila holds 0 nulls and 0 empty
      // arrays in `special_features`, so this count does NOT discriminate a
      // structured rule from a text one — both answer 0 (§4.24). What it does
      // prove is that an ARRAY column RUNS rather than being refused, and
      // that it lands on the negative branch with a boundary.
      //
      // The discriminating claim — an empty list is a VALUE — is measured by
      // the probe run at the top of this file, on a value the fixture does
      // not contain.
      const out = await runRule(
        client,
        missingRule('public.film', 'special_features'),
        new QueryBudget(),
      );
      const f = out.findings[0]!;
      assert.equal(f.evidence?.rowCount, 0);
      assert.equal(f.kind, 'negative');
    });

    it('🟥 enum: film.rating runs as scalar, where 1.2.0 refused it outright', async () => {
      // The headline of this revision, end to end. `film.rating` is an
      // `mpaa_rating` enum; under `user-rules@1.2.0` this threw, because
      // `information_schema` files enums under the same label it gives
      // composites. It now answers.
      const budget = new QueryBudget();
      const out = await runRule(client, missingRule('public.film', 'rating'), budget);
      const f = out.findings[0]!;

      assert.equal(f.evidence?.rowCount, 0);
      assert.equal(f.kind, 'negative');
      assert.equal(f.coverage.eligible, 1);
      assert.equal(f.coverage.checked, 1);
      // Read the type, count the matches, count the eligible rows. Three, and
      // the number matters: the refusal cases below spend ONE, and a 1 that is
      // never compared against a 3 proves nothing about what did not run.
      assert.equal(budget.spend.queries, 3);

      // The rows behind the 0: every one of the 1000 films holds a real enum
      // label, and not one of them was counted as nothing recorded.
      const withAChoice = await countOf(
        `SELECT count(*)::int AS n FROM public.film WHERE rating IS NOT NULL`,
      );
      assert.equal(withAChoice, 1000);

      // The version this finding is stamped with. Not decoration: `diffRuns`
      // refuses to attribute change across a version boundary, and without the
      // bump the finding above APPEARS between two runs of an unchanged
      // database and reads as something going wrong in the data.
      assert.equal(f.engineRuleVersion, USER_RULE_VERSION);
      assert.equal(USER_RULE_VERSION, 'user-rules@1.3.0');
    });

    it('🟥 refused before the counting query — the budget says which queries ran', async () => {
      // Two live columns, two different reasons to refuse, and neither is an
      // enum any more:
      //
      //   public.film.fulltext                  tsvector    a base type nobody decided
      //   pg_catalog.pg_attribute.attmissingval anyarray    a pseudo-type
      //
      // ⚠️ Neither is a COMPOSITE. This fixture has no column declared with a
      // composite type — asserted below — so the composite decision is
      // measured over every composite type in the catalog by the sweep above,
      // and the ORDERING it shares with these two is measured here.
      const refusals: readonly [string, string, string][] = [
        ['public.film', 'fulltext', 'tsvector'],
        ['pg_catalog.pg_attribute', 'attmissingval', 'anyarray'],
      ];

      for (const [table, column, typeName] of refusals) {
        const budget = new QueryBudget();
        await assert.rejects(
          () => runRule(client, missingRule(table, column), budget),
          (err: unknown) =>
            err instanceof UnsupportedColumnType &&
            err.dataType === typeName &&
            err.typeName === typeName &&
            new RegExp(`${table.replace('.', '\\.')}\\.${column}`).test(err.message),
          `${table}.${column} did not refuse the way its type says it should`,
        );

        // The counting query never ran. One query was spent, and it was the
        // one that read the type — the read is what DISCOVERS the refusal, so
        // it cannot be avoided, and saying so is better than implying none
        // ran. The enum test above spends 3 on the same path when the column
        // is admitted, which is what makes this 1 mean something.
        assert.equal(
          budget.spend.queries,
          1,
          `${table}.${column} spent ${budget.spend.queries} queries before refusing`,
        );
      }

      const compositeColumns = await countOf(`
        SELECT count(*)::int AS n
        FROM pg_catalog.pg_attribute a
        JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
        JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND c.relkind IN ('r', 'v', 'm', 'f', 'p')
          AND t.typtype = 'c'
      `);
      assert.equal(
        compositeColumns,
        0,
        `this fixture now has ${compositeColumns} composite-typed columns, so the ` +
          `composite refusal can be measured end to end and this note is stale`,
      );
    });

    it('four columns of ONE table are admitted three different ways', async () => {
      // The catalogue this rule was sealed against carries names and no
      // types. Four different answers for four columns of `public.film`
      // cannot have come from it, which is what "read at execution time"
      // means in practice.
      const answers = new Map<string, MissingAdmission>();
      for (const column of ['original_language_id', 'special_features', 'fulltext', 'rating']) {
        const read = await readColumnType(client, 'public', 'film', column);
        answers.set(column, admitMissing(read.chain));
      }
      assert.deepEqual(
        [...answers],
        [
          ['original_language_id', 'scalar'],
          ['special_features', 'structured'],
          ['fulltext', 'unsupported'],
          ['rating', 'scalar'],
        ],
      );
      assert.equal(
        new Set(answers.values()).size,
        3,
        'four columns of one table collapsed onto fewer answers than they used to',
      );
    });

    it('a column this role cannot see is refused, not defaulted', async () => {
      // `information_schema.columns` shows a role only what it holds some
      // privilege on, so an absent row is "not visible from here". Either way
      // the type is unknown, and unknown refuses.
      const read = await readColumnType(client, 'public', 'film', 'no_such_column');
      assert.equal(read.dataType, null);
      assert.deepEqual(read.chain, []);
      assert.equal(admitMissing(read.chain), 'unsupported');
      assert.equal(await liveDataType('public', 'film', 'no_such_column'), null);
    });
  });
}

describe('building the query for an admission', () => {
  it('refuses to build anything for a type nobody has decided about', () => {
    // No database needed, and that is the assertion: there is no string in
    // existence for `unsupported`, so no caller can run one by mistake.
    const rule = sealRule(
      {
        expressible: true,
        check: 'is-never-missing',
        table: 'public.film',
        columns: ['fulltext'],
        references: null,
        unsupported: [],
      },
      { 'public.film': ['film_id', 'fulltext'] },
    );

    assert.throws(() => buildRuleQuery(rule, 'unsupported'), UnsupportedColumnType);
  });

  it('refuses to build a missing check when nobody read the type', () => {
    // Fails closed. The bug being fixed was a query built with no type
    // information at all, so "no type information" must not be a path that
    // reaches SQL.
    const rule = sealRule(
      {
        expressible: true,
        check: 'is-never-missing',
        table: 'public.film',
        columns: ['original_language_id'],
        references: null,
        unsupported: [],
      },
      { 'public.film': ['film_id', 'original_language_id'] },
    );

    assert.throws(() => buildRuleQuery(rule, null), /without knowing the column's type/);
  });

  it('does not ask for an admission the check has no use for', () => {
    // The other two checks never consult it, and reading a type for them
    // would be a query spent on somebody's database for nothing.
    const rule = sealRule(
      {
        expressible: true,
        check: 'is-never-repeated',
        table: 'public.film',
        columns: ['title'],
        references: null,
        unsupported: [],
      },
      { 'public.film': ['film_id', 'title'] },
    );

    const sql = buildRuleQuery(rule, null);
    assert.match(sql, /GROUP BY/);
  });

  it('names the type it resolved, not only the label it was filed under', () => {
    // `USER-DEFINED` is what `information_schema` calls a composite, an enum,
    // a range and an extension type alike. A refusal that reported only that
    // would be the product hiding what it had already read, and leaving the
    // reader with nothing to go and decide about.
    const refusal = new UnsupportedColumnType(
      'public.orders.shipping',
      'USER-DEFINED',
      'public.postal_address',
    );
    assert.match(refusal.message, /USER-DEFINED \(public\.postal_address\)/);
    assert.equal(refusal.dataType, 'USER-DEFINED');
    assert.equal(refusal.typeName, 'public.postal_address');

    // And it does not say the same thing twice when the two agree.
    const plain = new UnsupportedColumnType('public.film.fulltext', 'tsvector', 'tsvector');
    assert.match(plain.message, /of type tsvector\./);
  });
});
