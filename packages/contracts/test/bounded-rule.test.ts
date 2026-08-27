/**
 * The shape a user's own sentence has to fit through — HS-D, VS-6.
 *
 * VS-8 hands a model a question. VS-6 hands it an imperative the user typed,
 * and asks for something that will RUN against their database. There is no
 * framing for a payload to fight here, and nobody reads the result.
 *
 * So these assertions are about a model being unable to point a query
 * somewhere nobody offered — and, just as importantly, about the one thing
 * they cannot check. The last block in this file asserts that a well-formed
 * check on the WRONG table sails through, because pretending otherwise would
 * be the worst thing this file could do.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LANGS } from '../src/i18n.js';
import {
  RULE_CHECKS,
  RuleRefused,
  UNSUPPORTED_KINDS,
  renderRule,
  sealRule,
} from '../src/bounded-rule.js';
import type { SchemaCatalog } from '../src/bounded-rule.js';
import { missingMeaningSentence } from '../src/missing-policy.js';
import { assertNoDefectWords } from '../src/findings.js';

/** The database that was scanned — the whole vocabulary a rule may use. */
const CATALOG: SchemaCatalog = {
  'public.users': ['id', 'display_name', 'email', 'created_at'],
  'public.posts': ['id', 'owner_user_id', 'title', 'created_at'],
  'public.votes': ['id', 'post_id', 'user_id', 'created_at'],
  'public.badges': ['id', 'user_id', 'name'],
};

const ORPHAN_CHECK = {
  expressible: true,
  check: 'points-at-an-existing-row',
  table: 'public.votes',
  columns: ['post_id'],
  references: 'public.posts.id',
  unsupported: [],
};

const NOT_A_RULE = {
  expressible: false,
  check: null,
  table: null,
  columns: [],
  references: null,
  unsupported: ['needs_time'],
};

describe('what a model may turn a typed sentence into', () => {
  it('accepts a check that names a table and columns it was offered', () => {
    const sealed = sealRule(ORPHAN_CHECK, CATALOG);
    assert.equal(sealed.expressible, true);
    assert.equal(sealed.table, 'public.votes');
  });

  it('accepts a refusal that names why', () => {
    const sealed = sealRule(NOT_A_RULE, CATALOG);
    assert.equal(sealed.expressible, false);
    assert.deepEqual([...sealed.unsupported], ['needs_time']);
  });

  it('refuses a table nobody offered', () => {
    // The check that carries. `public.secrets` is a legal identifier and a
    // plausible one; the only thing wrong with it is that it was not in the
    // catalogue, and that is exactly detectable.
    assert.throws(
      () => sealRule({ ...ORPHAN_CHECK, table: 'public.secrets' }, CATALOG),
      (err: unknown) => err instanceof RuleRefused && /not in the catalogue/.test(String(err)),
    );
  });

  it('refuses a column that table does not have', () => {
    assert.throws(
      () => sealRule({ ...ORPHAN_CHECK, columns: ['author_id'] }, CATALOG),
      (err: unknown) => err instanceof RuleRefused && /not.*column/.test(String(err)),
    );
  });

  it('refuses something to point at that is not a real column', () => {
    assert.throws(
      () => sealRule({ ...ORPHAN_CHECK, references: 'public.posts.slug' }, CATALOG),
      (err: unknown) => err instanceof RuleRefused && /has no column/.test(String(err)),
    );
  });

  it('refuses a check kind outside the vocabulary', () => {
    // The payload `rule-invents-a-check` fires exactly this at six models.
    // Here the shape answers it, which is why that payload is labelled as
    // measuring zod rather than a model.
    assert.throws(
      () => sealRule({ ...ORPHAN_CHECK, check: 'row-level-security-audit' }, CATALOG),
      RuleRefused,
    );
  });

  it('refuses an extra field, rather than dropping it', () => {
    // A model reaching for `sql` is a model reaching for the executable half.
    assert.throws(
      () => sealRule({ ...ORPHAN_CHECK, sql: 'SELECT 1' }, CATALOG),
      RuleRefused,
    );
  });

  it('refuses a refusal that will not say why', () => {
    assert.throws(
      () => sealRule({ ...NOT_A_RULE, unsupported: [] }, CATALOG),
      (err: unknown) => err instanceof RuleRefused && /why/.test(String(err)),
    );
  });

  it('refuses a rule that is both expressible and not', () => {
    assert.throws(
      () => sealRule({ ...ORPHAN_CHECK, unsupported: ['needs_time'] }, CATALOG),
      RuleRefused,
    );
    assert.throws(
      () => sealRule({ ...NOT_A_RULE, table: 'public.votes' }, CATALOG),
      RuleRefused,
    );
  });

  it('refuses a pointing check that does not say what it points at', () => {
    assert.throws(
      () => sealRule({ ...ORPHAN_CHECK, references: null }, CATALOG),
      (err: unknown) => err instanceof RuleRefused && /does not say what/.test(String(err)),
    );
  });

  it('refuses a reference on a check that does not point anywhere', () => {
    // A field that means nothing for this kind is a field that will be read
    // as meaning something.
    assert.throws(
      () =>
        sealRule(
          {
            expressible: true,
            check: 'is-never-missing',
            table: 'public.users',
            columns: ['email'],
            references: 'public.posts.id',
            unsupported: [],
          },
          CATALOG,
        ),
      (err: unknown) => err instanceof RuleRefused && /does not point at anything/.test(String(err)),
    );
  });

  it('refuses a one-column check spread over several columns', () => {
    // The widening failure: a rule the user scoped to `email` quietly
    // reporting on four columns, each finding indistinguishable from one
    // they asked for.
    assert.throws(
      () =>
        sealRule(
          {
            expressible: true,
            check: 'is-never-missing',
            table: 'public.users',
            columns: ['email', 'display_name', 'created_at'],
            references: null,
            unsupported: [],
          },
          CATALOG,
        ),
      (err: unknown) => err instanceof RuleRefused && /one column/.test(String(err)),
    );
  });

  it('allows several columns for a check about a combination', () => {
    const sealed = sealRule(
      {
        expressible: true,
        check: 'is-never-repeated',
        table: 'public.votes',
        columns: ['post_id', 'user_id'],
        references: null,
        unsupported: [],
      },
      CATALOG,
    );
    assert.equal(sealed.columns.length, 2);
  });

  it('refuses a table with no column named at all', () => {
    assert.throws(
      () =>
        sealRule(
          {
            expressible: true,
            check: 'is-never-missing',
            table: 'public.users',
            columns: [],
            references: null,
            unsupported: [],
          },
          CATALOG,
        ),
      RuleRefused,
    );
  });
});

describe('renderRule carries what "empty" will mean', () => {
  const MISSING_RULE = {
    expressible: true,
    check: 'is-never-missing' as const,
    table: 'public.users',
    columns: ['email'],
    references: null,
    unsupported: [],
  };
  const CAT = { 'public.users': ['email'] };

  it('🟥 appends the clause, because the policy was talking to nobody', () => {
    // `missing-policy.ts` exists so the sentence and the SQL cannot disagree
    // about what counts as empty. It had ZERO production callers: the clause
    // was generated, tested, and shown to no one, while renderRule kept
    // emitting only "leaves email empty" and left the reader to guess whether
    // a column of nothing but spaces counts. AGENTS §4.3 — a gate nobody
    // calls is not a gate, and this one sat on the single control the design
    // says has to be read.
    const sealed = sealRule(MISSING_RULE, CAT);

    const withMeaning = renderRule(sealed, 'text', 'en');
    const bare = renderRule(sealed, null, 'en');

    assert.ok(withMeaning.length > bare.length, 'the clause did not arrive');
    assert.ok(
      withMeaning.endsWith(missingMeaningSentence('text', 'en')),
      'the clause is not the one the policy wrote',
    );
    assert.equal(withMeaning.slice(0, bare.length), bare);
  });

  it('says something different for words than for a number', () => {
    // If both admissions produced the same sentence, passing one would be
    // ceremony. They must differ, or the parameter buys nothing.
    const sealed = sealRule(MISSING_RULE, CAT);
    assert.notEqual(renderRule(sealed, 'text', 'en'), renderRule(sealed, 'scalar', 'en'));
  });

  it('adds nothing to a check that does not turn on emptiness', () => {
    const sealed = sealRule(
      {
        expressible: true,
        check: 'is-never-repeated' as const,
        table: 'public.users',
        columns: ['email'],
        references: null,
        unsupported: [],
      },
      CAT,
    );
    // `text` is passed deliberately: a caller holding an admission must not
    // get a blank-meaning clause stapled onto a uniqueness sentence.
    assert.equal(renderRule(sealed, 'text', 'en'), renderRule(sealed, null, 'en'));
  });
});

describe('the read-back, which is the only control in door ③', () => {
  it('says the table and the columns in every language', () => {
    for (const lang of LANGS) {
      const said = renderRule(sealRule(ORPHAN_CHECK, CATALOG), null, lang);
      assert.match(said, /public\.votes/);
      assert.match(said, /post_id/);
      assert.match(said, /public\.posts\.id/);
    }
  });

  it('has a sentence for every check kind and every reason, in every language', () => {
    // The gate `Catalog` cannot give on its own: a key can exist and still be
    // unreachable from the renderer. This walks the enums instead of the
    // catalogue, so adding a check kind without a sentence goes red here.
    for (const lang of LANGS) {
      for (const check of RULE_CHECKS) {
        const said = renderRule(sealRule(
            {
              expressible: true,
              check,
              table: 'public.users',
              columns: ['email'],
              references: check === 'points-at-an-existing-row' ? 'public.posts.id' : null,
              unsupported: [],
            },
            CATALOG,
          ), null, lang, );
        assert.ok(said.length > 20, `${check} in ${lang} rendered nothing worth reading`);
        assert.match(said, /email/);
      }
      for (const kind of UNSUPPORTED_KINDS) {
        const said = renderRule(sealRule({ ...NOT_A_RULE, unsupported: [kind] }, CATALOG), null, lang);
        assert.ok(said.length > 20, `${kind} in ${lang} rendered nothing worth reading`);
      }
    }
  });

  it('never calls anything a defect — hard rule ③, on the product\'s own prose', () => {
    for (const lang of LANGS) {
      for (const kind of UNSUPPORTED_KINDS) {
        assertNoDefectWords(
          renderRule(sealRule({ ...NOT_A_RULE, unsupported: [kind] }, CATALOG), null, lang),
          `the read-back refusing ${kind} in ${lang} is read by a user`,
        );
      }
      assertNoDefectWords(
        renderRule(sealRule(ORPHAN_CHECK, CATALOG), null, lang),
        `the read-back of a check in ${lang} is read by a user`,
      );
    }
  });

  it('reads differently for two different tables — the thing a user has to notice', () => {
    // 🟥 The assertion that would be worthless if it could not fail. If the
    // read-back said the same thing for `public.users` and `public.badges`,
    // door ③ would have NO control in it at all, and the sentence in
    // bounded-rule.ts claiming otherwise would be false.
    const meant = renderRule(sealRule(
        {
          expressible: true,
          check: 'is-never-repeated',
          table: 'public.users',
          columns: ['email'],
          references: null,
          unsupported: [],
        },
        CATALOG,
      ), null, 'vi', );
    const hijacked = renderRule(sealRule(
        {
          expressible: true,
          check: 'is-never-repeated',
          table: 'public.badges',
          columns: ['name'],
          references: null,
          unsupported: [],
        },
        CATALOG,
      ), null, 'vi', );
    assert.notEqual(meant, hijacked);
    assert.match(hijacked, /public\.badges/);
  });
});

describe('what this shape CANNOT do, asserted so nobody assumes otherwise', () => {
  it('accepts a well-formed check pointed at entirely the wrong table', () => {
    // The door with no gate. The user said "no two users share an email"; this
    // is a uniqueness check on badge names, and every assertion in sealRule
    // passes it — because from in here these are two legal identifiers and
    // nothing more.
    //
    // Kept as a test rather than a comment so that a future change claiming to
    // close this door has to come here and delete it deliberately.
    const hijacked = sealRule(
      {
        expressible: true,
        check: 'is-never-repeated',
        table: 'public.badges',
        columns: ['name'],
        references: null,
        unsupported: [],
      },
      CATALOG,
    );
    assert.equal(hijacked.expressible, true);
    assert.equal(hijacked.table, 'public.badges');
  });
});
