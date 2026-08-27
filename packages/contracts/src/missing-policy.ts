/**
 * What "empty" means for one column — decided once, said once, run once.
 *
 * ## Why this file exists
 *
 * `is-never-missing` had its meaning written down twice: as a sentence in the
 * message catalogue (*"no row leaves this column empty"*) and as a predicate
 * in `@ledar/rule-runner` (`IS NULL`). They disagreed, and the disagreement
 * shipped: on stock Pagila, `public.address.address2` holds 4 nulls and 999
 * empty strings in 1003 rows, so the product answered **4** to a sentence a
 * reader would price at **1003**.
 *
 * Making the two copies agree by hand was the first fix and it was not
 * enough — Sol's audit said so, and said why: two implementations of one
 * meaning drift, and the next drift happens before anyone is watching. So the
 * meaning is a closed value here, and both the sentence and the SQL are
 * derived from it rather than restated beside it.
 *
 * ## Why the SQL is not in this file
 *
 * This package contains no SQL, deliberately, and `infra/check-sql.py` is
 * built around that. So the closed value crosses the boundary instead of the
 * string: `@ledar/rule-runner` switches on `MissingAdmission` exhaustively to
 * build the predicate, this package switches on it exhaustively to pick the
 * sentence, and a test in the runner proves the two agree on real rows for
 * every member. Adding a member breaks both switches at compile time, which
 * is the property a shared string could never have.
 *
 * ## 🟥 What refusal is for
 *
 * `unsupported` is not an error path bolted on for tidiness. A type nobody
 * has decided about is a type this product must decline rather than cast to
 * `::text` and hope — casting to guess is how a check comes to report a
 * confident number about a question nobody asked.
 *
 * ## 🟥 What decides, and what only labels — settled 2026-08-27
 *
 * Until this revision the decision was made on
 * `information_schema.columns.data_type`, and that string files **every**
 * enum, composite, range, multirange and extension type under the single
 * label `USER-DEFINED`. The policy refused all of them, which was safe and
 * too broad: *`USER-DEFINED` is a label about ORIGIN, not about MEANING;
 * refusing an enum because enums and composites share a label is coarse
 * metadata deciding what the product can do.*
 *
 * So `data_type` no longer reaches this file at all. It is a label the
 * refusal message quotes, nothing more, and the shape of `admitMissing`
 * enforces that: it takes the column's type chain out of `pg_type` and has no
 * parameter the label could arrive in. A future edit cannot quietly let the
 * label decide again, because there is nowhere to put it.
 */

import type { Lang, MessageKey } from './i18n.js';
import { t } from './i18n.js';

/**
 * How a column's type decides what counts as missing.
 *
 * Closed, and short. Every member is a decision somebody made on purpose;
 * a type that does not map to one of them is refused, not defaulted.
 */
export type MissingAdmission =
  /**
   * Text-like: `NULL`, the empty string, and a value that is nothing but
   * whitespace.
   *
   * Whitespace counts because a column holding `'   '` is empty to the person
   * who asked whether every member has an email on file, and that person is
   * the one the sentence is written for.
   */
  | 'text'
  /**
   * Every other supported scalar: `NULL` and nothing else.
   *
   * An integer, a timestamp, a boolean or an ENUM has no empty form that the
   * database would hand back, so the text rule would be a clause that can
   * never fire — and a clause that cannot fire still has to be explained to
   * whoever reads the sentence.
   */
  | 'scalar'
  /**
   * Structured values: array, json, jsonb, range, multirange.
   *
   * An empty array is a VALUE. So is an empty range. Somebody wrote `{}` or
   * `empty` there, and reporting it as a missing value would be the product
   * disagreeing with the database about what was recorded.
   */
  | 'structured'
  /** Nothing has been decided for this type. The check does not run. */
  | 'unsupported';

export const MISSING_ADMISSIONS: readonly MissingAdmission[] = [
  'text',
  'scalar',
  'structured',
  'unsupported',
];

/**
 * One link in a column's type chain, straight out of `pg_type`.
 *
 * Facts, not judgements. Every field is a column of the catalog read verbatim
 * on the connection the count is about to run on; nothing here is derived,
 * normalised or guessed by the reader. The judgement is `admitMissing`, and
 * it is the only thing in this package allowed to make one.
 */
export type PgTypeLink = {
  /**
   * `pg_type.typtype`, one letter, verbatim.
   *
   * 🟥 The letters were not taken on trust. Confirmed by query against the
   * live `ledar-pagila` fixture (PostgreSQL 18.6) on 2026-08-27, each one
   * against a type whose kind is known independently:
   *
   * ```text
   * b  base        pg_catalog.text, pg_catalog.tsvector
   * c  composite   information_schema.information_schema_catalog_name
   * d  domain      information_schema.cardinal_number  (typbasetype -> integer)
   * e  enum        public.mpaa_rating                  (film.rating)
   * m  multirange  pg_catalog.int4multirange
   * p  pseudo      pg_catalog.record, pg_catalog.anyelement
   * r  range       pg_catalog.int4range, pg_catalog.numrange
   * ```
   *
   * Typed as `string` rather than a union of those seven on purpose. The set
   * belongs to Postgres, not to this build: a later server may add a letter,
   * and a union would make that a compile error in a package that cannot know
   * about it. A letter this build does not recognise is refused instead,
   * which is the same answer with none of the pretence.
   */
  readonly typtype: string;
  /** `pg_type.typname` — `int4`, `citext`, `mpaa_rating`. */
  readonly name: string;
  /** The schema the type lives in. `pg_catalog` for everything built in. */
  readonly schema: string;
  /**
   * `format_type(oid, NULL)` — the SQL spelling, e.g. `character varying`.
   *
   * This is the same function `information_schema` itself calls to produce
   * `data_type`, so for a `pg_catalog` type the two strings are identical.
   * Measured, not assumed: all 24 spellings in the tables below were compared
   * against `format_type` output on the fixture and matched byte for byte.
   */
  readonly spelling: string;
  /**
   * `typelem <> 0 AND typlen = -1` — `information_schema`'s own test for an
   * array, applied to the type actually reached rather than one level down.
   */
  readonly isArray: boolean;
  /** The extension this type belongs to, or `null` when it belongs to none. */
  readonly extension: string | null;
};

/**
 * How many domains deep the walk will follow before it gives up.
 *
 * A domain over a domain is legal, so the walk has to be a walk. It does not
 * have to be an unbounded one: `CREATE DOMAIN` requires its base type to
 * exist already, so a chain cannot contain a cycle and every chain in a
 * server that started up terminates at a non-domain. The cap is therefore not
 * a cycle breaker — it is a limit on how much catalog this product will read
 * for one column, and on how strange a catalog it will keep reasoning about.
 *
 * Eight, because it is far past anything a schema does on purpose and still
 * bounded. A chain that has not reached a real type by then is **refused**,
 * not followed further and not defaulted: `followDomains` returns `null` and
 * `admitMissing` answers `unsupported`. Fail closed, the same as every other
 * thing this file cannot finish classifying.
 */
export const DOMAIN_FOLLOW_LIMIT = 8;

/**
 * The `typtype` letters this build knows, named.
 *
 * A letter written once, beside what it means. The switch below reads as the
 * classification the auditor wrote down rather than as seven string literals
 * a reader has to decode.
 */
const TYPTYPE = {
  base: 'b',
  composite: 'c',
  domain: 'd',
  enum: 'e',
  multirange: 'm',
  pseudo: 'p',
  range: 'r',
} as const;

/**
 * Postgres type names that carry text semantics.
 *
 * Matched against `format_type`, which spells them out in full — `character
 * varying`, not `varchar`. Read at execution time from the database rather
 * than from a catalogue snapshot: the snapshot can be older than the column.
 *
 * ⚠️ `citext` used to be in this set and could never match. `citext` is an
 * extension type, so `information_schema` reported it as `USER-DEFINED` and
 * the name in here was unreachable — a decision that read as taken and had
 * never once been applied. It now lives in `DECIDED_EXTENSION_TYPES`, where
 * it is reached by a path that exists.
 */
const TEXT_TYPES = new Set([
  'text',
  'character varying',
  'character',
  'name',
]);

/**
 * Scalars with no empty form.
 *
 * Listed rather than inferred. An allowlist that has to be extended by hand
 * fails closed — a type nobody thought about lands in `unsupported` and the
 * check declines, which is the failure this product prefers.
 */
const SCALAR_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'real',
  'double precision',
  'boolean',
  'uuid',
  'date',
  'time without time zone',
  'time with time zone',
  'timestamp without time zone',
  'timestamp with time zone',
  'interval',
  'bytea',
  'inet',
  'cidr',
  'macaddr',
]);

/**
 * Values with internal structure, where empty is still something written.
 *
 * Short now, and that is the point: arrays are recognised by `isArray` and
 * ranges by their `typtype`, so neither has to be listed by name. What is
 * left is the two types whose structure is only visible in their name.
 */
const STRUCTURED_TYPES = new Set(['json', 'jsonb']);

/**
 * Extension base types somebody has decided about, one at a time.
 *
 * 🟥 Keyed on `extension.typname`, not on the name alone, and that is the
 * whole design. A base type outside `pg_catalog` is a type this product has
 * never seen the source of; accepting it because it is *called* `citext`
 * would be §4.23 exactly — a label is not a gate. The key is answerable only
 * by `pg_depend`: this type is a member of that extension, or it is not.
 *
 * ⚠️ Stated limit, measured on the fixture 2026-08-27: `ledar-pagila` has
 * `plpgsql` installed and nothing else, and **no type in it belongs to any
 * extension**. So the accepting branch of this table has no live example on
 * the fixture and is proved over catalog-shaped facts instead. The refusing
 * branch — an extension type nobody decided — is the default and is the one
 * that matters more.
 */
const DECIDED_EXTENSION_TYPES = new Map<string, MissingAdmission>([
  ['citext.citext', 'text'],
]);

/**
 * The first link in the chain that is not a domain — the type whose policy a
 * domain column actually follows.
 *
 * `null` means the question could not be finished: an empty chain (the column
 * is not visible to this role, or does not exist) or a chain still sitting on
 * a domain at its last link, which is what hitting `DOMAIN_FOLLOW_LIMIT`
 * looks like from here. Both are refusals, and refusing is what the caller
 * does with a `null`.
 *
 * The chain is ordered from the column's own type outward — index 0 is the
 * type the column is declared as, index 1 its base, and so on. That ordering
 * is the reader's contract with whoever built the chain.
 */
export function followDomains(chain: readonly PgTypeLink[]): PgTypeLink | null {
  for (const link of chain) {
    if (link.typtype !== TYPTYPE.domain) return link;
  }
  return null;
}

/**
 * What a base type admits, once the domains have been walked off.
 *
 * Split out because the three questions it asks are genuinely different — is
 * this a list, is this something Postgres ships, is this something an
 * extension shipped — and running them together in `admitMissing` hid which
 * one had answered.
 */
function admitBaseType(link: PgTypeLink): MissingAdmission {
  // Any array, whatever its element type. An array of a type this product
  // refuses is still a list, and an empty list is still a value somebody
  // wrote — the element type changes nothing about either sentence.
  if (link.isArray) return 'structured';

  if (link.schema === 'pg_catalog') {
    // `format_type` leaves a `pg_catalog` type unqualified, because that
    // schema is always searched. Stripping the prefix anyway costs one line
    // and stops a server with an unusual `search_path` from silently
    // narrowing every text column in the database to `unsupported`.
    const spelled = link.spelling.trim().toLowerCase().replace(/^pg_catalog\./, '');
    if (TEXT_TYPES.has(spelled)) return 'text';
    if (SCALAR_TYPES.has(spelled)) return 'scalar';
    if (STRUCTURED_TYPES.has(spelled)) return 'structured';
    return 'unsupported';
  }

  // Outside `pg_catalog`. Either an extension shipped it — in which case
  // somebody may have decided about it by name and extension together — or
  // somebody at this site wrote a base type by hand, which nobody here has
  // decided about and which is refused.
  if (link.extension === null) return 'unsupported';
  return DECIDED_EXTENSION_TYPES.get(`${link.extension}.${link.name}`) ?? 'unsupported';
}

/**
 * Which rule applies to a column of this type.
 *
 * Takes the column's type chain as read from `pg_type` on the live
 * connection — never the `information_schema` label. Anything this cannot
 * finish classifying is `unsupported`, and that is the point of the function:
 * the default is refusal, not a cast.
 *
 * The classification, in the words it was decided in:
 *
 * ```text
 * enum                  scalar       an enum value is one whole value; NULL only
 * range / multirange    structured   an EMPTY range is still a value
 * domain                follow the base type and apply that type's policy
 * composite             REFUSE       Postgres gives a row type its own IS NULL
 *                                    semantics — `(NULL,NULL) IS NULL` is true
 *                                    and `x IS NULL` on a row means something
 *                                    else again. Defaulting it to the json or
 *                                    array rule would be guessing at exactly
 *                                    the point Postgres stops agreeing with us.
 * extension base type   REFUSE unless decided one at a time; `citext` is
 * pseudo-type           REFUSE
 * unfinished walk       REFUSE
 * ```
 *
 * ⚠️ This is a controlled WIDENING of admission. It does not soften the
 * fail-closed principle by one letter: everything above that is not on a list
 * somebody wrote by hand still refuses, including a `typtype` letter a future
 * Postgres invents.
 */
export function admitMissing(chain: readonly PgTypeLink[]): MissingAdmission {
  const resolved = followDomains(chain);
  if (resolved === null) return 'unsupported';

  switch (resolved.typtype) {
    case TYPTYPE.enum:
      // One whole value out of a fixed set. There is no empty enum label —
      // `''` is not a member of any enum — so `IS NULL` is the entire
      // question, exactly as it is for an integer.
      return 'scalar';
    case TYPTYPE.range:
    case TYPTYPE.multirange:
      // `'empty'::int4range` is a value somebody wrote. Counting it as
      // missing would be this product disagreeing with the database about
      // what was recorded, which is the same reason `{}` is a value.
      return 'structured';
    case TYPTYPE.composite:
      return 'unsupported';
    case TYPTYPE.pseudo:
      return 'unsupported';
    case TYPTYPE.base:
      return admitBaseType(resolved);
    default:
      // Includes `TYPTYPE.domain`, which `followDomains` has already ruled
      // out, and any letter a later Postgres adds. Neither is a case this
      // build can answer, and both answer the same way.
      return 'unsupported';
  }
}

/**
 * The sentence for what this admission will count, keyed off the same value
 * the predicate is built from.
 *
 * Exhaustive on purpose: adding a member to `MissingAdmission` makes this
 * fail to compile, which is the whole reason the admission is a closed union
 * rather than a string.
 */
export function missingMeaningKey(admission: MissingAdmission): MessageKey {
  switch (admission) {
    case 'text':
      return 'rule.missing-means.text';
    case 'scalar':
      return 'rule.missing-means.scalar';
    case 'structured':
      return 'rule.missing-means.structured';
    case 'unsupported':
      return 'rule.missing-means.unsupported';
  }
}

/**
 * The clause the read-back adds so the person confirming knows what will be
 * counted — including that blank spaces count as nothing recorded.
 *
 * The audit asked for that sentence by name. It exists because "empty" is a
 * word two people read differently, and the one deciding whether to let a
 * query run is entitled to the narrower reading in writing.
 *
 * 🟥 `scalar` and `structured` were both rewritten on 2026-08-27, when enums
 * joined `scalar` and ranges joined `structured`. The old scalar sentence
 * said *"this column holds a number, a date or a yes-or-no"*, which is FALSE
 * of `film.rating`; the old structured sentence promised only that *"an empty
 * list"* is a value, which says nothing about an empty range. Inheriting
 * either would have been the exact failure this policy exists to prevent — a
 * sentence that is wrong about the column it describes, printed as the one
 * control that has to be read.
 */
export function missingMeaningSentence(
  admission: MissingAdmission,
  lang: Lang = 'en',
): string {
  return t(lang, missingMeaningKey(admission));
}
