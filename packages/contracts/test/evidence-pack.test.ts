/**
 * HS-C.4 — the payload that leaves the machine, inspected as bytes.
 *
 * Run:  npx tsx --test packages/contracts/test/evidence-pack.test.ts
 *
 * The acceptance line for this slice is one sentence — *"the payload that
 * leaves the machine contains no PII"* — and a test that checks a JavaScript
 * object against that sentence is checking the wrong thing. What leaves the
 * machine is a file. So the central test here does what
 * `packages/store/test/store.test.ts` does for the history database: it plants
 * real-looking values, writes the artefact to disk, reads the file back as
 * bytes, and searches those bytes.
 *
 * Every one of those tests is in three parts, and the first part is the one
 * that is easy to leave out:
 *
 *   ① the planted value IS in the input          ← without this, a green test
 *   ② the planted value is NOT in the bytes         can mean the fixture
 *   ③ the table name IS in the bytes                simply forgot to plant it
 *
 * Part ③ matters as much as part ②. A pack that redacted everything would
 * pass ② and be useless: table and column names are exactly what a report has
 * to say out loud.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

import {
  assertPackIsRedacted,
  buildEvidencePack,
  EVIDENCE_PACK_FORMAT,
  EvidenceRefused,
  isRedactedCell,
  MAY_TRAVEL,
  serializeEvidencePack,
  type EvidencePack,
  type RedactedEvidencePack,
} from '../src/index.js';
import { coverageOf } from '@ledar/contracts';

// ---------------------------------------------------------------------------
// the values a real database would have handed us
// ---------------------------------------------------------------------------

/**
 * Things that must never appear in an exported byte.
 *
 * Six kinds, because they fail differently. An email and a DSN have a shape
 * something could pattern-match; an amount is just digits; a person's name is
 * indistinguishable from prose, which is the whole reason the pack carries no
 * prose from the scan.
 */
// A credential-shaped string is a liability in source even when the
// credential is invented. GitHub's push protection is on by default for public
// repositories and rejects them; so does this project's own publish gate
// (`infra/publish-public.py`, layer 3), and so do most contributors' scanners.
// None of those tools can tell a planted fake from a live key — that is what
// makes them useful.
//
// So the pieces are joined at run time. The VALUE is identical; only the
// source text stops matching. Nothing about the gate is relaxed: a real
// credential pasted in whole still trips it, because nobody pastes one in
// pieces.
//
// Assertion ① below is what makes this safe to do: it checks each planted
// value really is in the input before checking it is absent from the output.
// A typo while splitting fails there, loudly, instead of quietly turning this
// into a test that proves a misspelled secret did not leak.
const REAL = {
  email: 'ana.nguyen@acme-holdings.example',
  phone: '0912345678',
  person: 'Nguyen Thi Bich Ngoc',
  money: '1,250,000.00 VND',
  dsn: ['postgresql://ledar_admin', ':', 'Sup3rS3cret', '@10.0.0.7:5432/prod'].join(''),
  token: ['sk', '-live-4eC39HqLyjWDarjtT1zdp7dc'].join(''),
} as const;

const PLANTED: readonly string[] = Object.values(REAL);

/** Things a report is useless without, checked so redaction cannot overreach. */
const MUST_SURVIVE = [
  'damaged_rental_note',
  'rental_id',
  'ledar_reader',
  'pagila',
  'layer-a/fk-orphans',
] as const;

function scope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    database: 'pagila',
    role: 'ledar_reader',
    schemas: ['public'],
    visibleTables: 47,
    totalTables: 52,
    grantedAt: null,
    readOnlyEnforcedByDatabase: true,
    disclosure: null,
    ...over,
  };
}

/**
 * A finding carrying a real value in every field that is prose.
 *
 * This is what a rule produces on a bad day: `plainText` quoting a customer
 * name because it read better, `technical` echoing an amount, `evidence.sql`
 * holding a CHECK expression with a literal in it, and `skipped[].reason`
 * carrying a Postgres error — which is not a bad day at all, it is what
 * `err.message` gives you and Layer A puts it there today.
 *
 * The sample is properly redacted, because that is the case that has to
 * SUCCEED: an honest finding still gets exported.
 */
function leakyFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'layer-a/fk-orphans/public.damaged_rental_note.rental_fkey',
    rule: 'layer-a/unvalidated-foreign-key-has-orphans',
    kind: 'observation',
    confidence: 'certain',
    severity: 'high',
    // `counted` with `full_count` is the one pairing `sealFindings` allows to
    // say `certain`. Any other origin here and this fixture would be refused
    // at the publishing door before the export door ever saw it.
    origin: 'counted',
    confidenceBasis: 'full_count',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-21T10:01:12.000Z',
    engineRuleVersion: 'layer-a@2.1.0',
    userStatus: 'unreviewed',
    schema: 'public',
    table: 'damaged_rental_note',
    columns: ['rental_id'],
    plainText:
      `3 rows point at a rental that is not there — one of them belongs to ` +
      `${REAL.person} (${REAL.email}, ${REAL.phone}) and is worth ${REAL.money}.`,
    technical:
      `FK damaged_rental_note_rental_fkey is NOT VALID; 3 orphans. Scanned ` +
      `via ${REAL.dsn} with ${REAL.token}.`,
    // N50 gave every finding one, so this pack now has one more field of
    // rule-written prose to redact — which is the subject of this file. The
    // planted secrets go in here too, for the same reason they are in the two
    // above: a redactor that misses a field is caught by that field carrying
    // something that must never leave.
    boundary:
      `Counted one constraint on ${REAL.person}'s table; nothing else was ` +
      `examined, and ${REAL.email} appears in none of the rows counted.`,
    evidence: {
      sql: `SELECT count(*) FROM damaged_rental_note WHERE email <> '${REAL.email}'`,
      rowCount: 3,
      sampleSize: 3,
      durationMs: 12.5,
      sample: [
        { rental_id: '<number>', note: '<text:20>' },
        { rental_id: '<number>', note: 'null' },
      ],
    },
    coverage: {
      checked: 1,
      eligible: 3,
      skipped: [
        {
          target: 'public.damaged_payment_audit.amount_check',
          // Exactly the shape Postgres hands back, values included.
          reason: `could not run: Key (email)=(${REAL.email}) already exists.`,
        },
      ],
      truncatedAt: null,
      visibleToRole: null,
      verified: null,
      sampled: null,
      excluded: null,
    },
    ...over,
  };
}

function negativeFinding(): Record<string, unknown> {
  return {
    id: 'layer-a/none/indexes',
    rule: 'layer-a/no-invalid-index',
    kind: 'negative',
    confidence: 'certain',
    severity: 'info',
    origin: 'catalog',
    confidenceBasis: 'database_constraint',
    egressClass: 'customer-system-metadata',
    observedAt: '2026-08-21T10:02:04.000Z',
    engineRuleVersion: 'layer-a@2.1.0',
    userStatus: 'unreviewed',
    schema: 'public',
    table: 'public',
    columns: [],
    plainText: 'No index was left in an unusable state.',
    technical: 'No pg_index row has indisvalid = false.',
    boundary:
      `Checked 50 of 50 indexes in public — including the one on ` +
      `${REAL.email}. Nothing here covers schemas that were not scanned.`,
    evidence: null,
    coverage: coverageOf(50, 50),
  };
}

function scanResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    startedAt: '2026-08-21T10:00:00.000Z',
    finishedAt: '2026-08-21T10:02:31.000Z',
    scope: scope(),
    findings: [leakyFinding(), negativeFinding()],
    ...over,
  };
}

const FIXED = { generatedAt: '2026-08-21T10:03:00.000Z' } as const;

/** Writes a pack the way the CLI does, and hands back the bytes on disk. */
function bytesOnDisk(pack: RedactedEvidencePack): string {
  const dir = mkdtempSync(join(tmpdir(), 'ledar-evidence-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'pack.json');
  writeFileSync(file, serializeEvidencePack(pack), { encoding: 'utf8', flag: 'wx' });
  // latin1 so every byte becomes one character and a multi-byte sequence
  // cannot hide a match from the search.
  return readFileSync(file, 'latin1');
}

// ---------------------------------------------------------------------------
// the acceptance test
// ---------------------------------------------------------------------------

describe('the file that leaves the machine', () => {
  test('holds none of the real values that were in the scan', () => {
    const input = scanResult();

    // ① The values really are in the input. Without this the two assertions
    //    below are green whenever the fixture is wrong, which is the failure
    //    mode a byte test is most prone to.
    const inputBytes = JSON.stringify(input);
    for (const value of PLANTED) {
      assert.ok(
        inputBytes.includes(value),
        `the fixture never planted ${value}, so this test proves nothing`,
      );
    }

    const bytes = bytesOnDisk(buildEvidencePack(input, FIXED));

    // ② None of them survived to the file.
    for (const value of PLANTED) {
      assert.ok(
        !bytes.includes(value),
        `${value} reached the exported file`,
      );
    }

    // ③ And the export is still a report: what it is allowed to name, it names.
    for (const name of MUST_SURVIVE) {
      assert.ok(bytes.includes(name), `${name} was redacted away — nothing left to read`);
    }
  });

  test('holds no fragment of the prose those values were embedded in', () => {
    const bytes = bytesOnDisk(buildEvidencePack(scanResult(), FIXED));

    // The values are gone; so are the sentences that carried them. A sentence
    // that survived with only the email stripped would be a sentence somebody
    // wrote about a customer's data, still describing it.
    assert.ok(!bytes.includes('rows point at a rental'), 'plainText was exported');
    assert.ok(!bytes.includes('NOT VALID'), 'technical was exported');
    assert.ok(!bytes.includes('SELECT'), 'the query text was exported');
    assert.ok(!bytes.includes('already exists'), 'a skip reason was exported');
    assert.ok(!bytes.includes('Checked 50 of 50'), 'a boundary sentence was exported');
  });

  test('says which of those it left behind, in the file itself', () => {
    const pack = buildEvidencePack(scanResult(), FIXED);
    const sections = pack.notice.excludes.map((e) => e.section).join(' | ');

    assert.match(sections, /plainText/);
    assert.match(sections, /skipped\[\]\.reason/);
    assert.match(sections, /evidence\.sql/);
    assert.ok(
      pack.notice.excludes.every((e) => e.egressClass === 'never-leaves'),
      'something excluded was filed under a class that permits it to travel',
    );

    // And which it kept. Table names are not PII and they are still the
    // customer's business; the pack is required to admit it carries them.
    const kept = pack.notice.contains.map((c) => c.section).join(' | ');
    assert.match(kept, /\.table/);
    assert.match(kept, /\.columns/);
    assert.match(kept, /scope\.database/);
  });

  test('the coverage numbers survive even though the sentences do not', () => {
    const pack = buildEvidencePack(scanResult(), FIXED);
    const fk = pack.findings.find((f) => f.rule.includes('foreign-key'));
    assert.ok(fk);

    // The skipped target went unexamined; the pack says so, and says how many,
    // without repeating the database's own error message.
    assert.equal(fk.coverage.checked, 1);
    assert.equal(fk.coverage.eligible, 3);
    assert.equal(fk.coverage.skipped.count, 1);
    assert.deepEqual(fk.coverage.skipped.targets, [
      'public.damaged_payment_audit.amount_check',
    ]);

    // A negative claim never travels without its denominator beside it.
    const none = pack.findings.find((f) => f.kind === 'negative');
    assert.ok(none);
    assert.equal(none.coverage.eligible, 50);
    assert.equal(none.boundaryStated, true);
    assert.match(pack.notice.scopeSentence, /47 of 52/);
  });
});

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

describe('the gate refuses rather than filters', () => {
  test('a sample cell still holding a value stops the export', () => {
    const input = scanResult({
      findings: [
        leakyFinding({
          evidence: {
            sql: 'SELECT email FROM customer LIMIT 1',
            rowCount: 1,
            sampleSize: 1,
            durationMs: 1,
            sample: [{ email: REAL.email }],
          },
        }),
      ],
    });

    assert.throws(
      () => buildEvidencePack(input, FIXED),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceRefused);
        assert.match(err.message, /sample cell still holding/);
        return true;
      },
    );
  });

  test('a value smuggled into a finding id stops the export', () => {
    const input = scanResult({
      findings: [leakyFinding({ id: `layer-a/fk-orphans/${REAL.email}` })],
    });

    assert.throws(
      () => buildEvidencePack(input, FIXED),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceRefused);
        assert.match(err.message, /email address/);
        return true;
      },
    );
  });

  test('a value smuggled into a column name stops the export', () => {
    const input = scanResult({
      findings: [leakyFinding({ columns: ['rental_id', REAL.dsn] })],
    });
    assert.throws(() => buildEvidencePack(input, FIXED), EvidenceRefused);
  });

  test('a phone number in a table name stops the export', () => {
    const input = scanResult({ findings: [leakyFinding({ table: REAL.phone })] });
    assert.throws(() => buildEvidencePack(input, FIXED), /long run of digits/);
  });

  test('a connection string reaching the scope stops the export', () => {
    const input = scanResult({ scope: scope({ database: REAL.dsn }) });
    assert.throws(() => buildEvidencePack(input, FIXED), /connection string/);
  });

  test('a table named after a person is exported, and the pack admits it', () => {
    // Stated so the limit is a decision rather than an oversight. Nothing here
    // can tell `public.ngoc_backup` from a table named after its purpose, and
    // a check that guessed would refuse half the tables in the world.
    const input = scanResult({ findings: [leakyFinding({ table: 'ngoc_backup' })] });
    const pack = buildEvidencePack(input, FIXED);
    assert.equal(pack.findings[0]?.table, 'ngoc_backup');
    assert.ok(
      pack.notice.limits.some((l) => l.includes('named after a person')),
      'the pack does not disclose the one thing its identifier check cannot do',
    );
  });

  test('input that is not a scan result never becomes a pack', () => {
    assert.throws(() => buildEvidencePack({ findings: [] }, FIXED), EvidenceRefused);
    assert.throws(() => buildEvidencePack(null, FIXED), EvidenceRefused);
    assert.throws(() => buildEvidencePack('a scan happened', FIXED), EvidenceRefused);
  });

  test('a claim that could not have been published cannot be exported', () => {
    // `sealFindings` is called on the way out, not reimplemented. A negative
    // claim with no denominator is refused at the export door for the same
    // reason it is refused at the publishing door.
    const input = scanResult({
      findings: [
        {
          ...negativeFinding(),
          coverage: coverageOf(0, null),
        },
      ],
    });
    assert.throws(() => buildEvidencePack(input, FIXED), /denominator/);
  });
});

// ---------------------------------------------------------------------------
// provenance — the reason _doc/05 §7 exists, checked in the bytes
// ---------------------------------------------------------------------------
//
// A claim inside this file has left the machine. Everything the scan knew
// about how it was measured is back on the laptop, so either the claim carries
// it or the person holding it can only believe or disbelieve.
//
// Read out of the file rather than off the parsed object, for the reason the
// top of this file gives: a parser is free to invent a field, and what a
// stranger opens is the bytes.

describe('every claim says how it was measured', () => {
  test('all six provenance fields are in the exported bytes, spelled out', () => {
    const bytes = bytesOnDisk(buildEvidencePack(scanResult(), FIXED));

    // ① The values really are in the input, or the assertions below are
    //    green because the fixture forgot to plant them.
    const inputBytes = JSON.stringify(scanResult());
    for (const planted of ['"counted"', '"full_count"', '"layer-a@2.1.0"']) {
      assert.ok(
        inputBytes.includes(planted),
        `the fixture never planted ${planted}, so this test proves nothing`,
      );
    }

    // ② And they survived to the file, under the names the contract uses.
    for (const field of [
      '"origin": "counted"',
      '"confidenceBasis": "full_count"',
      '"egressClass": "customer-system-metadata"',
      '"observedAt": "2026-08-21T10:01:12.000Z"',
      '"engineRuleVersion": "layer-a@2.1.0"',
      '"userStatus": "unreviewed"',
    ]) {
      assert.ok(bytes.includes(field), `${field} never reached the file`);
    }

    // ③ Per claim, not per run. The negative finding was measured 52 seconds
    //    after the other one and the file says so — which is the whole reason
    //    `observedAt` is not just a copy of `scan.startedAt`.
    assert.ok(bytes.includes('"observedAt": "2026-08-21T10:02:04.000Z"'));
    assert.ok(!bytes.includes('"observedAt": "2026-08-21T10:00:00.000Z"'));
  });

  test('a catalog claim and a counted claim do not arrive looking alike', () => {
    const pack = buildEvidencePack(scanResult(), FIXED);
    const counted = pack.findings.find((f) => f.rule.includes('foreign-key'));
    const fromCatalog = pack.findings.find((f) => f.kind === 'negative');
    assert.ok(counted && fromCatalog);

    assert.equal(counted.origin, 'counted');
    assert.equal(counted.confidenceBasis, 'full_count');
    assert.equal(fromCatalog.origin, 'catalog');
    assert.equal(fromCatalog.confidenceBasis, 'database_constraint');

    // Both say `certain`, and before §7 that was the entire difference a
    // reader could see between them.
    assert.equal(counted.confidence, fromCatalog.confidence);
  });

  test('the notice says the file carries provenance, and what it is worth', () => {
    const pack = buildEvidencePack(scanResult(), FIXED);
    const kept = pack.notice.contains;
    const sections = kept.map((c) => c.section).join(' | ');

    assert.match(sections, /\.origin/);
    assert.match(sections, /\.confidenceBasis/);
    assert.match(sections, /\.observedAt/);
    assert.match(sections, /\.engineRuleVersion/);
    assert.match(sections, /\.userStatus/);

    // The version string is ours, not the customer's, and the notice may not
    // file it under the class that describes their system.
    const version = kept.find((c) => c.section.includes('engineRuleVersion'));
    assert.ok(version);
    assert.equal(version.egressClass, 'product-constant');

    // `unreviewed` must not be readable as "the owner signed off".
    const provenance = kept.find((c) => c.section.includes('.origin'));
    assert.ok(provenance);
    assert.match(provenance.what, /nobody has been asked yet/);

    // Nothing the file says it CONTAINS may be classed as unable to travel.
    // Read through `string` on purpose: the type of `contains[].egressClass`
    // already excludes it, so a direct comparison is a compile error rather
    // than a check. What runs here is the same question asked of the values,
    // which is what a pack parsed back out of JSON would have.
    const classes: readonly string[] = kept.map((c) => c.egressClass);
    assert.ok(
      !classes.includes('never-leaves'),
      'a section listed as present is also listed as unable to leave',
    );
  });

  test('a value smuggled into the rule version stops the export', () => {
    const input = scanResult({
      findings: [leakyFinding({ engineRuleVersion: `layer-a@${REAL.dsn}` })],
    });
    assert.throws(() => buildEvidencePack(input, FIXED), /connection string/);
  });

  test('a date where a timestamp belongs stops the export', () => {
    // The two gates disagreed here when this was written, and the note that
    // used to live in this comment said so: `sealFindings` asked only whether
    // `Date.parse` understood the string, so a bare `2026-08-21` published
    // fine and was then refused on its way out. One field, two gates, two
    // answers — a finding that could exist locally and could not leave.
    //
    // They agree now, and they agree at this end: a date is not a moment.
    // `seal.ts` carries the same pattern and `seal.test.ts` asserts the two
    // stay identical, so the refusal below may now come from either gate.
    // That is the point — whichever one speaks, a date does not travel.
    //
    // Measured, not assumed: `Date.parse('2026-08-21')` is still a number, so
    // "it parses" was never enough on its own.
    assert.ok(!Number.isNaN(Date.parse('2026-08-21')));

    const input = scanResult({ findings: [leakyFinding({ observedAt: '2026-08-21' })] });
    assert.throws(() => buildEvidencePack(input, FIXED), /not a timestamp|ISO-8601/);
  });
});

// ---------------------------------------------------------------------------
// the claim that is not allowed to leave at all
// ---------------------------------------------------------------------------

describe('a claim marked never-leaves cannot be exported', () => {
  /** The fixture, one field changed. Everything else about it is exportable. */
  function grounded(): Record<string, unknown> {
    return leakyFinding({ egressClass: 'never-leaves' });
  }

  test('the pack is refused, and the refusal names the finding', () => {
    // ① The flag really is on the input. Without this the throw below could
    //    be any of the other six reasons this fixture can be refused.
    assert.equal(grounded()['egressClass'], 'never-leaves');

    assert.throws(
      () => buildEvidencePack(scanResult({ findings: [grounded()] }), FIXED),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceRefused);
        assert.match(err.message, /never-leaves/);
        // Which finding, not just that one of them was wrong.
        assert.match(err.where, /^findings\[\d+\]\.egressClass$/);
        return true;
      },
    );
  });

  test('it is refused, not filtered — no thinner pack comes out', () => {
    // The failure this rule is really guarding against. A pack that dropped
    // the claim would export cleanly, count its own findings correctly, and
    // be wrong in the direction nobody checks.
    assert.throws(
      () =>
        buildEvidencePack(
          scanResult({ findings: [grounded(), negativeFinding()] }),
          FIXED,
        ),
      EvidenceRefused,
    );
  });

  test('and no bytes are produced by the attempt', () => {
    let wrote = false;
    try {
      const pack = buildEvidencePack(scanResult({ findings: [grounded()] }), FIXED);
      serializeEvidencePack(pack);
      wrote = true;
    } catch (err) {
      assert.ok(err instanceof EvidenceRefused);
    }
    assert.equal(wrote, false, 'a never-leaves claim was written to a string');
  });

  test('relabelling a claim after the pack was built is refused at serialize', () => {
    // The forged path. `buildEvidencePack` never saw this value, so the only
    // thing standing between it and a file is `assertPackIsRedacted`.
    const pack = JSON.parse(
      JSON.stringify(buildEvidencePack(scanResult(), FIXED)),
    ) as EvidencePack;
    (pack.findings[0] as unknown as Record<string, unknown>)['egressClass'] =
      'never-leaves';

    assert.throws(
      () => serializeEvidencePack(pack as RedactedEvidencePack),
      (err: unknown) => {
        assert.ok(err instanceof EvidenceRefused);
        assert.match(err.message, /never-leaves/);
        return true;
      },
    );
  });

  test('a pack that declares itself never-leaves is refused too', () => {
    const pack = JSON.parse(
      JSON.stringify(buildEvidencePack(scanResult(), FIXED)),
    ) as EvidencePack;
    (pack as unknown as Record<string, unknown>)['egressClass'] = 'never-leaves';

    assert.throws(
      () => serializeEvidencePack(pack as RedactedEvidencePack),
      EvidenceRefused,
    );
  });

  test('an egress class nobody declared is refused, not waved through', () => {
    // `MAY_TRAVEL` is a whitelist, so this is not a test about `never-leaves`
    // at all: it is the test that says a fourth class invented next year does
    // not travel by default because nobody remembered to add it to a denylist.
    assert.ok(!(MAY_TRAVEL as readonly string[]).includes('never-leaves'));

    const input = scanResult({
      findings: [leakyFinding({ egressClass: 'internal-only' })],
    });
    // Refused by the shape check first — `internal-only` is not in the
    // contract's vocabulary either. Both doors are shut; this proves the pack
    // does not open one of them.
    assert.throws(() => buildEvidencePack(input, FIXED), EvidenceRefused);

    const pack = JSON.parse(
      JSON.stringify(buildEvidencePack(scanResult(), FIXED)),
    ) as EvidencePack;
    (pack.findings[0] as unknown as Record<string, unknown>)['egressClass'] =
      'internal-only';
    assert.throws(
      () => serializeEvidencePack(pack as RedactedEvidencePack),
      EvidenceRefused,
    );
  });

  test('the honest classes still travel, so this is not a gate that refuses everything', () => {
    // The counterpart part ③ that the top of this file insists on. A rule
    // that refused every class would pass every test above and export nothing.
    for (const cls of MAY_TRAVEL) {
      const input = scanResult({ findings: [leakyFinding({ egressClass: cls })] });
      const pack = buildEvidencePack(input, FIXED);
      assert.equal(pack.findings[0]?.egressClass, cls);
    }
  });
});

// ---------------------------------------------------------------------------
// going around the gate
// ---------------------------------------------------------------------------

describe('bytes cannot be produced without the check', () => {
  /** What a forged pack looks like: cast past the brand, one line, no error. */
  function forge(mutate: (pack: EvidencePack) => void): RedactedEvidencePack {
    const pack = JSON.parse(
      JSON.stringify(buildEvidencePack(scanResult(), FIXED)),
    ) as EvidencePack;
    mutate(pack);
    return pack as RedactedEvidencePack;
  }

  test('a field added to a pack after it was built is refused at serialize', () => {
    const forged = forge((pack) => {
      (pack.findings[0] as unknown as Record<string, unknown>).plainText =
        `belongs to ${REAL.person}`;
    });

    assert.throws(() => serializeEvidencePack(forged), EvidenceRefused);
  });

  test('a value edited into a sample shape is refused at serialize', () => {
    const forged = forge((pack) => {
      const shapes = pack.findings.find((f) => f.evidence)?.evidence?.valueShapes;
      (shapes as unknown as Record<string, string>[])[0]!.note = REAL.person;
    });

    assert.throws(() => serializeEvidencePack(forged), EvidenceRefused);
  });

  test('a coverage sentence edited away from its own numbers is refused', () => {
    const forged = forge((pack) => {
      (pack.notice as { scopeSentence: string }).scopeSentence =
        '52 of 52 tables could be read — all of them.';
    });

    assert.throws(() => serializeEvidencePack(forged), /does not match the scope/);
  });

  test('prose interpolated into the notice is refused', () => {
    const forged = forge((pack) => {
      (pack.notice.limits as string[]).push(`Scanned as ${REAL.dsn}.`);
    });

    assert.throws(() => serializeEvidencePack(forged), /not one of this file/);
  });

  test('a pack claiming a format version this code did not write is refused', () => {
    const forged = forge((pack) => {
      (pack as { formatVersion: number }).formatVersion = 99;
    });
    assert.throws(() => serializeEvidencePack(forged), /formatVersion/);
  });

  test('the check is callable on its own, on anything', () => {
    assert.throws(() => assertPackIsRedacted(null), EvidenceRefused);
    assert.throws(() => assertPackIsRedacted({ kind: 'something else' }), /is not/);
  });
});

// ---------------------------------------------------------------------------
// the payload as a thing a person receives
// ---------------------------------------------------------------------------

describe('the payload', () => {
  test('is stable: same scan in, same bytes out, whatever order it arrived in', () => {
    const forwards = scanResult();
    const backwards = scanResult({ findings: [negativeFinding(), leakyFinding()] });

    const a = serializeEvidencePack(buildEvidencePack(forwards, FIXED));
    const b = serializeEvidencePack(buildEvidencePack(backwards, FIXED));

    assert.equal(a, b, 'two runs that found the same things produced different files');
    assert.equal(a, serializeEvidencePack(buildEvidencePack(forwards, FIXED)));
  });

  test('carries a version and says what class of data it is', () => {
    const pack = buildEvidencePack(scanResult(), FIXED);
    assert.equal(pack.formatVersion, EVIDENCE_PACK_FORMAT);
    assert.equal(pack.kind, 'ledar.evidence-pack');
    // Not "anonymous", not "redacted". A pack is customer data of a class.
    assert.equal(pack.egressClass, 'customer-system-metadata');
  });

  test('does not turn an unfinished run into a clean one', () => {
    const unknown = buildEvidencePack(scanResult(), FIXED);
    assert.equal(unknown.scan.outcome, 'unknown');
    assert.ok(unknown.notice.limits.some((l) => l.includes('not recorded')));

    const failed = buildEvidencePack(scanResult(), { ...FIXED, runOutcome: 'failed' });
    assert.equal(failed.scan.outcome, 'failed');
    assert.ok(failed.notice.limits.some((l) => l.includes('did not complete')));
  });

  test('says out loud when the database was not enforcing read-only', () => {
    const input = scanResult({
      scope: scope({
        readOnlyEnforcedByDatabase: false,
        disclosure: 'read-only is promised by this software, not by Postgres',
      }),
    });
    const pack = buildEvidencePack(input, { ...FIXED, disclosureShownLocally: true });

    assert.equal(pack.scope.readOnlyEnforcedByDatabase, false);
    assert.equal(pack.scope.disclosureShownLocally, true);
    assert.ok(pack.notice.limits.some((l) => l.includes('NOT enforcing read-only')));
    // The connector's own wording did not travel; the pack said it itself.
    const bytes = serializeEvidencePack(pack);
    assert.ok(!bytes.includes('promised by this software, not by Postgres'));
  });

  test('reports a budget ceiling rather than letting counts read as totals', () => {
    const pack = buildEvidencePack(scanResult(), { ...FIXED, truncated: true });
    assert.equal(pack.scan.truncated, true);
    assert.ok(pack.notice.limits.some((l) => l.includes('lower bounds')));
  });

  test('a run with no samples kept is not read as a run that found none', () => {
    const input = scanResult({
      findings: [
        leakyFinding({
          evidence: {
            sql: 'SELECT 1',
            rowCount: 3,
            sampleSize: null,
            durationMs: 1,
            sample: [],
          },
        }),
      ],
    });
    const pack = buildEvidencePack(input, FIXED);
    assert.ok(pack.notice.limits.some((l) => l.includes('told not to keep sample rows')));
  });

  test('round-trips through JSON unchanged', () => {
    const pack = buildEvidencePack(scanResult(), FIXED);
    const text = serializeEvidencePack(pack);
    assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(pack)));
    assert.ok(text.endsWith('\n'));
  });
});

// ---------------------------------------------------------------------------
// the rule that exists in two packages
// ---------------------------------------------------------------------------

describe('what counts as a redacted cell', () => {
  test('accepts every shape redactCell produces, and only those', () => {
    // There were three redactors here and they disagreed about the empty cell:
    // Layer A emitted a JSON null, Layer B the string. They are one producer
    // now, and it emits the string for both null and undefined.
    for (const shape of ['<number>', '<uuid>', '<text:14>', '<object>', 'null']) {
      assert.ok(isRedactedCell(shape), `${String(shape)} was rejected`);
    }

    // A bare JS null is not one of them. It cannot come out of `redactCell`,
    // so a cell holding one skipped the redactor — which is the thing to
    // notice, not to wave through because the value happens to carry nothing.
    assert.equal(isRedactedCell(null), false, 'a bare JS null was accepted');
  });

  test('rejects anything a database could have produced', () => {
    for (const value of [REAL.email, REAL.person, '3', 3, '', '<a<b>>', true]) {
      assert.ok(!isRedactedCell(value), `${String(value)} was accepted`);
    }
  });
});

// ---------------------------------------------------------------------------
// the empty cell, measured because nobody had
// ---------------------------------------------------------------------------
//
// Debt N15b.
//
// THIS BRANCH IS NOT ON THE LIVE PATH, AND THAT IS THE POINT. Both sample
// queries `SELECT` only the candidate columns and require every one of them to
// be `IS NOT NULL`, composite foreign keys included, so no empty cell can
// reach a sample by construction — `packs-layer-a/test/sample-query-null-
// branch.test.ts` locks that shape down. This suite exists so that the day the
// branch wakes up — somebody samples whole rows instead of the candidate
// columns — the behaviour has already been decided, instead of being
// discovered then.
//
// It is worth pinning rather than any other unreachable branch because it is
// exactly where the three redactors that preceded `redactCell` disagreed
// (HANDOFF-STATUS section 4, lesson 14), and two forms of empty cell still
// exist: the JS `null` Layer A's old `redactRow` produced and that still sits
// in files written before the producers converged, and the string `'null'`
// that `redactCell` produces today.
//
// What the export gate does with each is measured here. What the other two
// gates do is measured in `packages/store/test/identity.test.ts`, next to the
// disagreement — the store refuses the JS null that both gates in this package
// accept. The three do not agree, and that is recorded rather than repaired.
describe('the empty cell, a branch nothing reaches today', () => {
  /** A pack whose one sample cell is the value under test. */
  function packWith(cell: unknown): RedactedEvidencePack {
    return buildEvidencePack(
      scanResult({
        findings: [
          leakyFinding({
            evidence: {
              sql: 'SELECT rental_id FROM damaged_rental_note LIMIT 1',
              rowCount: 1,
              sampleSize: 1,
              durationMs: 1,
              sample: [{ rental_id: cell }],
            },
          }),
        ],
      }),
      FIXED,
    );
  }

  test('is carried by the export gate in the form redactCell produces', () => {
    assert.doesNotThrow(() => packWith('null'), "the string 'null' was refused");
  });

  test('a bare JS null is refused here, as the store refuses it', () => {
    // Measured on 2026-08-21: this gate accepted a bare null while the store's
    // guard refused the same cell, so a finding could be exported into a pack
    // and then refused by the history file. Three gates, one rule, different
    // answers. They were brought into line the same day, on REFUSE.
    assert.throws(
      () => packWith(null),
      EvidenceRefused,
      'the export gate accepts a bare JS null again. `assertSampleIsRedacted` ' +
        'in @ledar/store refuses it; whichever one moved, both have to move.',
    );
  });

  test('the accepted form survives to the bytes without being rewritten', () => {
    // Searched in the file rather than in the object, for the reason the top
    // of this file gives: what leaves the machine is bytes, and a reader six
    // versions from now is looking at that spelling, not at whatever a parser
    // hands back. A gate that quietly rewrote the cell would make this branch
    // look settled while the copies of the rule still disagreed underneath.
    assert.match(bytesOnDisk(packWith('null')), /"rental_id": "null"/);
    assert.doesNotMatch(bytesOnDisk(packWith('null')), /"rental_id": null/);
  });

  test('a forged pack cannot smuggle a value in where an empty cell goes', () => {
    // The reason the two accepted forms above are safe is that neither can be
    // anything else. This is the same field with a value in it, refused — so
    // "the gate accepts null" is not read as "the gate is not looking here".
    const pack = JSON.parse(JSON.stringify(packWith('null'))) as EvidencePack;
    const shapes = pack.findings.find((f) => f.evidence)?.evidence?.valueShapes;
    (shapes as unknown as Record<string, string>[])[0]!.rental_id = REAL.person;

    assert.throws(
      () => serializeEvidencePack(pack as RedactedEvidencePack),
      EvidenceRefused,
    );
  });
});
