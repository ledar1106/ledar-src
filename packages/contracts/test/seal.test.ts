/**
 * HS-C.1 / C.2 / C.3 — the gate, not the convention.
 *
 * Run:  npx tsx --test packages/contracts/test/seal.test.ts
 *
 * Every case here is a sentence a user could have been shown. The point of
 * the file is that none of them can be.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertScopeManifest,
  ClaimRefused,
  scopeCoverageSentence,
  sealFinding,
  sealFindings,
  type FindingDraft,
  type ScopeManifest,
} from '../src/index.js';
import { coverageOf } from '@ledar/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

/** A finding with nothing wrong with it, to be spoiled one field at a time. */
function goodObservation(over: Record<string, unknown> = {}): FindingDraft {
  return {
    id: 'test/observation',
    rule: 'test/rule',
    kind: 'observation',
    confidence: 'certain',
    severity: 'low',

    // A counted claim, so `certain` is a confidence it has grounds for. Every
    // test below that spoils one field relies on the rest being coherent:
    // spoil `boundary` and the refusal has to be about `boundary`, not about
    // a provenance pair that never made sense in the first place.
    origin: 'counted',
    confidenceBasis: 'full_count',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-21T10:00:04.000Z',
    engineRuleVersion: 'test@1.0.0',

    schema: 'public',
    table: 'invoice',
    columns: ['customer_id'],
    plainText: '5 rows point at a customer record that is not there.',
    technical: 'public.invoice.customer_id has 5 unmatched values.',
    evidence: {
      sql: 'SELECT count(*) FROM invoice',
      rowCount: 5,
      sampleSize: null,
      durationMs: 1,
      sample: [],
    },
    coverage: coverageOf(1, 1),
    ...over,
  } as FindingDraft;
}

function goodNegative(over: Record<string, unknown> = {}): FindingDraft {
  return {
    id: 'test/negative',
    rule: 'test/nothing-found',
    kind: 'negative',
    confidence: 'certain',
    severity: 'info',
    origin: 'counted',
    confidenceBasis: 'full_count',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-21T10:00:04.000Z',
    engineRuleVersion: 'test@1.0.0',
    schema: 'public',
    table: '—',
    columns: [],
    plainText: 'Every rule this database was told to enforce, it is enforcing.',
    technical: 'No unvalidated constraint had violating rows.',
    boundary: 'Checked 12 of 14 constraints in public; 2 were skipped.',
    evidence: null,
    coverage: coverageOf(12, 14),
    ...over,
  } as FindingDraft;
}

function refusalFrom(draft: unknown, producer = 'test-pack'): ClaimRefused {
  try {
    sealFinding(draft, producer);
  } catch (err) {
    assert.ok(err instanceof ClaimRefused, `expected ClaimRefused, got ${err}`);
    return err;
  }
  throw new assert.AssertionError({ message: 'the gate let it through' });
}

// ---------------------------------------------------------------------------
describe('C.1 — one door', () => {
  test('the gate parses rather than waving through: defaults are applied', () => {
    const draft = goodObservation();
    delete (draft as Record<string, unknown>).columns;

    const [sealed] = sealFindings([draft], 'test-pack');
    assert.deepEqual(sealed?.columns, []);
  });

  test('fields nobody declared do not survive the gate', () => {
    const sealed = sealFinding(
      goodObservation({ smuggled: 'raw customer email' }),
      'test-pack',
    );
    assert.equal('smuggled' in sealed, false);
  });

  test('claim discipline is one clause of the gate, not a separate habit', () => {
    const refusal = refusalFrom(
      goodObservation({
        kind: 'inference',
        confidence: 'unconfirmed',
        plainText: 'This column is broken.',
      }),
    );
    assert.match(refusal.message, /broken/);
    assert.match(refusal.message, /not intended/);
  });

  test('an observation with no evidence is still refused through the gate', () => {
    const refusal = refusalFrom(goodObservation({ evidence: null }));
    assert.match(refusal.message, /observation/);
  });

  test('a refusal names the producer and the finding, and publishes nothing', () => {
    const refusal = refusalFrom(goodNegative({ boundary: undefined }), 'layer-a');
    assert.equal(refusal.producer, 'layer-a');
    assert.equal(refusal.findingId, 'test/negative');
    assert.match(refusal.message, /test\/negative/);
    assert.match(refusal.message, /Nothing from layer-a was published/);
  });

  test('one bad finding stops the batch — no partial publish', () => {
    assert.throws(
      () => sealFindings([goodObservation(), goodNegative({ boundary: '' })], 'layer-a'),
      ClaimRefused,
    );
  });

  // The gate is only a gate if the packs cannot get round it. These read the
  // shipping source of every pack — not a fixed list of files — so a rule
  // added later is covered without anyone remembering to add it here.
  const PACKS = ['packages/packs-layer-a', 'packages/packs-layer-b'];

  function sourcesOf(pack: string): { rel: string; text: string }[] {
    const dir = resolve(REPO, pack, 'src');
    return readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({
        rel: `${pack}/src/${name.replace(/\\/g, '/')}`,
        text: readFileSync(resolve(dir, name), 'utf8'),
      }));
  }

  for (const pack of PACKS) {
    const sources = sourcesOf(pack);

    test(`${pack} publishes through sealFindings`, () => {
      assert.ok(
        sources.some((s) => /sealFindings\(/.test(s.text)),
        `no file in ${pack}/src calls sealFindings`,
      );
    });

    for (const { rel, text } of sources) {
      test(`${rel} does not hand-roll the check it used to`, () => {
        assert.doesNotMatch(text, /assertClaimDiscipline\(/);
      });

      test(`${rel} does not cast its way past the brand`, () => {
        assert.doesNotMatch(text, /as\s+(unknown\s+as\s+)?SealedFinding/);
      });

      // A pack function that hands back plain `Finding[]` has gone round the
      // gate by widening its own return type — the one bypass that does not
      // need a cast, and so the one worth naming.
      test(`${rel} does not return unsealed findings`, () => {
        assert.doesNotMatch(text, /\)\s*:\s*(Promise<)?\s*Finding\[\]/);
        assert.doesNotMatch(text, /findings\s*:\s*Finding\[\]/);
      });
    }
  }
});

// ---------------------------------------------------------------------------
describe('C.2 — a negative claim without a boundary is refused at run time', () => {
  test('missing boundary', () => {
    const refusal = refusalFrom(goodNegative({ boundary: undefined }));
    assert.match(refusal.message, /boundary/);
  });

  test('the refusal says why, not just what', () => {
    const refusal = refusalFrom(goodNegative({ boundary: undefined }));
    // The reader of this message is the person who has to fix it.
    assert.match(refusal.message, /there is nothing to find/);
    assert.match(refusal.message, /one sentence naming what was examined/);
  });

  test('a boundary of whitespace is a missing boundary', () => {
    const refusal = refusalFrom(goodNegative({ boundary: '   \n\t ' }));
    assert.match(refusal.message, /boundary/);
    assert.match(refusal.message, /empty/);
  });

  test('an empty plainText is refused too — a finding nobody can act on', () => {
    const refusal = refusalFrom(goodObservation({ plainText: '  ' }));
    assert.match(refusal.message, /plainText/);
  });

  // The case the type system cannot reach: nothing was compiled against
  // these shapes on the way in. This is the store in C.5 and the model in
  // HS-D, both of which hand over plain JSON.
  test('an untyped source gets no discount', () => {
    const stored = JSON.parse(
      JSON.stringify({
        id: 'store/replayed',
        rule: 'layer-a/no-declared-constraint-violations',
        kind: 'negative',
        confidence: 'certain',
        severity: 'info',
        origin: 'counted',
        confidenceBasis: 'full_count',
        egressClass: 'customer-system-metadata',
        observedAt: '2026-08-21T10:00:04.000Z',
        engineRuleVersion: 'test@1.0.0',
        schema: 'public',
        table: '—',
        columns: [],
        plainText: 'Nothing wrong here.',
        technical: 'No violations.',
        evidence: null,
        coverage: coverageOf(3, 3),
      }),
    ) as unknown;

    const refusal = refusalFrom(stored, 'store');
    assert.match(refusal.message, /boundary/);
    assert.equal(refusal.producer, 'store');
  });

  test('a negative claim that does say where it looked goes through', () => {
    const sealed = sealFinding(goodNegative(), 'layer-a');
    assert.equal(sealed.kind, 'negative');
  });
});

// ---------------------------------------------------------------------------
describe('C.3 — two denominators, and the right to say "I do not know"', () => {
  test('a negative claim with an unknown denominator is refused', () => {
    const refusal = refusalFrom(
      goodNegative({
        coverage: coverageOf(0, null),
      }),
    );
    assert.match(refusal.message, /denominator is unknown/);
    assert.match(refusal.message, /out of\s*\n?how many/);
  });

  test('a rule that does not know its denominator may still observe', () => {
    // Not knowing how many were eligible does not invalidate a thing that
    // was counted. It invalidates only the claim that nothing else exists.
    const sealed = sealFinding(
      goodObservation({
        coverage: coverageOf(1, null),
      }),
      'layer-a',
    );
    assert.equal(sealed.coverage.eligible, null);
  });

  test('zero eligible is a real answer, not the unknown one', () => {
    const sealed = sealFinding(
      goodNegative({
        boundary: 'There were no unvalidated constraints in public to check.',
        coverage: coverageOf(0, 0),
      }),
      'layer-a',
    );
    assert.equal(sealed.coverage.eligible, 0);
  });

  test('checked cannot exceed eligible', () => {
    const refusal = refusalFrom(
      goodObservation({
        coverage: coverageOf(9, 4),
      }),
    );
    assert.match(refusal.message, /9 checked out of 4 eligible/);
  });

  // This is the shape Layer A used to emit: `checked: eligible` while the
  // boundary sentence beside it said `eligible - skipped.length`. The prose
  // was right and the number was not, and the number is what a machine reads.
  test('a target that was skipped cannot also be counted as checked', () => {
    const refusal = refusalFrom(
      goodNegative({
        coverage: {
          checked: 14,
          eligible: 14,
          skipped: [{ target: 'public.a.fk', reason: 'ran out of budget' }],
          truncatedAt: null,
          visibleToRole: null,
          verified: null,
          sampled: null,
          excluded: null,
        },
      }),
    );
    assert.match(refusal.message, /14 checked and 1 skipped, out of 14 eligible/);
  });

  test('checked plus skipped adding up exactly is fine', () => {
    const sealed = sealFinding(
      goodNegative({
        coverage: {
          checked: 13,
          eligible: 14,
          skipped: [{ target: 'public.a.fk', reason: 'ran out of budget' }],
          truncatedAt: null,
          visibleToRole: null,
          verified: null,
          sampled: null,
          excluded: null,
        },
      }),
      'layer-a',
    );
    assert.equal(sealed.coverage.checked, 13);
  });

  // ---- the scope manifest's own two denominators --------------------------
  function scope(over: Partial<ScopeManifest> = {}): ScopeManifest {
    return {
      database: 'pagila',
      role: 'ledar_reader',
      schemas: ['public'],
      visibleTables: 39,
      totalTables: 52,
      grantedAt: null,
      readOnlyEnforcedByDatabase: true,
      disclosure: null,
      ...over,
    };
  }

  test('an unknown total is said out loud, never filled in from what is visible', () => {
    const sentence = scopeCoverageSentence(scope({ totalTables: null }));
    assert.match(sentence, /do not know/);
    // The failure this exists to stop: 39 quietly becoming the denominator,
    // the way GREATEST(reltuples, 0) turned "never analysed" into "0 rows".
    assert.doesNotMatch(sentence, /of 39/);
    assert.doesNotMatch(sentence, /all of them/);
  });

  test('a known total is stated as a fraction, with the remainder named', () => {
    const sentence = scopeCoverageSentence(scope());
    assert.match(sentence, /39 of 52/);
    assert.match(sentence, /13/);
  });

  test('a manifest cannot see more tables than exist', () => {
    assert.throws(
      () => assertScopeManifest(scope({ visibleTables: 60, totalTables: 52 })),
      /Both cannot be true/,
    );
  });

  test('not knowing the total is legal; that is the whole point of null', () => {
    const m = assertScopeManifest(scope({ totalTables: null }));
    assert.equal(m.totalTables, null);
  });

  test('a read-only promise made by software must say so', () => {
    assert.throws(
      () =>
        assertScopeManifest(
          scope({ readOnlyEnforcedByDatabase: false, disclosure: null }),
        ),
      /every report has to say so/,
    );

    const disclosed = assertScopeManifest(
      scope({
        readOnlyEnforcedByDatabase: false,
        disclosure:
          'The read-only promise here is made by this software, not by the database.',
      }),
    );
    assert.equal(disclosed.readOnlyEnforcedByDatabase, false);
  });
});

// ---------------------------------------------------------------------------
// the two timestamp rules, kept in step
//
// Debt N26. `seal.ts` and `evidence-pack.ts` each hold a copy of the same
// pattern, and until today they disagreed: this gate asked only whether
// `Date.parse` understood the string, so `'2026-08-21'` published cleanly and
// was then refused on its way out of the machine. One field, two gates, two
// answers — the shape lesson 14 is about.
//
// The copy is not forced the way the store's is; `seal.ts` could import from
// `evidence-pack.ts`. It does not, because that reverses the dependency: a
// pack is built out of sealed findings, so the pack knows about the gate and
// not the other way round. What is forced is that they agree, and that is
// what these two tests are.

describe('observedAt means the same thing at both gates', () => {
  test('a date with no time is refused here, as the export gate refuses it', () => {
    const refusal = refusalFrom(goodObservation({ observedAt: '2026-08-21' }));
    assert.match(refusal.message, /not a timestamp/);
    assert.match(refusal.message, /the moment thrown away/);
  });

  test('the pattern in seal.ts is the pattern in evidence-pack.ts', () => {
    const read = (file: string): string => {
      const text = readFileSync(resolve(HERE, '..', 'src', file), 'utf8');
      const m = /ISO_TIMESTAMP\s*=\s*\n?\s*(\/\^.*?\$\/)/s.exec(text);
      assert.ok(m?.[1], `no ISO_TIMESTAMP found in ${file}`);
      return m[1];
    };

    assert.equal(
      read('seal.ts'),
      read('evidence-pack.ts'),
      'the two timestamp patterns have drifted. A value one gate calls a ' +
        'moment and the other calls a day is a finding that publishes and ' +
        'then cannot leave — which is how they were when this was written.',
    );
  });
});
