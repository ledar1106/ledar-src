/**
 * The one door anything leaves the machine through.
 *
 * Nothing in this product has ever made a network call, so rule 6 — "no byte
 * of real data leaves the user's machine except in a redacted Evidence Pack"
 * — has so far been true by accident. This file is where it stops being an
 * accident: an Evidence Pack is the artefact a user hands to somebody else,
 * their DBA, whoever is helping them, later a model behind a proxy. The
 * moment one can be written to a file is the moment rule 6 has something to
 * govern.
 *
 * `seal.ts` is the model for how. A finding cannot be published without going
 * through `sealFindings`, because the type a pack must return is one only the
 * gate can produce. The same shape is used here, one turn tighter:
 *
 *   - `buildEvidencePack` is the only thing that can produce a
 *     `RedactedEvidencePack`, and it refuses rather than filters.
 *   - `serializeEvidencePack` — the only function here that produces bytes —
 *     accepts nothing else, and re-runs the whole check on what it was given.
 *     A forged `as unknown as RedactedEvidencePack` gets past the compiler and
 *     still does not get past this.
 *
 * ## What the pack holds, and why the answer is "less than you expect"
 *
 * A `Finding` has two kinds of string in it. Identifiers — schema, table,
 * column, rule id — are generated from the schema graph and hold no row data.
 * Prose — `plainText`, `technical`, `boundary`, `coverage.skipped[].reason` —
 * is written by rule code, and rule code interpolates whatever it has to hand.
 * One of those things is a database error message, and Postgres error messages
 * quote values back at you:
 *
 *     Key (email)=(ana@example.com) already exists.
 *
 * That sentence would arrive in `skipped[].reason` through `err.message` in
 * Layer A, entirely by accident, and no amount of scanning it for shapes could
 * be trusted to find every value inside a free-form sentence. A person's name
 * has no shape at all.
 *
 * So the pack carries **no prose from the scan**. Not the plain-language
 * sentence, not the technical one, not the skip reasons, not the SQL. What it
 * carries instead is structure: which rule fired, on which table and columns,
 * how many rows, and the coverage fractions that say how much of the database
 * that number is about. The sentences stay on the user's screen, where the
 * user can read them and decide for themselves what to repeat.
 *
 * That is a real cost and it is written into the payload itself, under
 * `notice.excludes`, so the person who receives a pack does not have to guess
 * why it is thin.
 *
 * ## Table names are not PII, and they are still the customer's business
 *
 * A report that cannot say `public.invoice` is not a report. So identifiers
 * are in the pack — and the pack says so out loud rather than letting a reader
 * assume "redacted" means "anonymous". A list of table and column names is a
 * map of somebody's system. `notice.contains` names every place one appears.
 *
 * ## Every claim carries where it came from
 *
 * `_doc/05` §7 asks for provenance on the claim rather than on the run, and a
 * pack is the artefact that argument was really about. Inside this file a
 * claim has left the machine: it is in somebody's inbox, quoted into a ticket,
 * pasted into a model's prompt. Everything the scan knew about how that number
 * was arrived at is back on the laptop. A reader can believe it or not, and
 * nothing else — unless the claim says.
 *
 * So `origin`, `confidenceBasis`, `observedAt`, `engineRuleVersion`,
 * `userStatus` and `egressClass` travel on every finding, and `notice.contains`
 * says they do. `userStatus` reads `unreviewed` on every claim in every pack
 * written today, and it travels precisely so that it says that out loud: an
 * absent field would be read as agreement by anyone in a hurry.
 *
 * ## One class of claim does not travel at all
 *
 * A finding marked `egressClass: 'never-leaves'` is refused — the pack is not
 * built, no bytes are written, and the refusal names the finding. Not filtered
 * out: a pack quietly missing a finding is a report with a hole in it that
 * counts correctly and is wrong, which is the failure `_doc/05` is written
 * against. Nothing emits such a claim today; the door is shut in advance
 * because the day something does is the day nobody will be looking.
 */

import { z } from 'zod';

import {
  ClaimKind,
  ClaimOrigin,
  Confidence,
  ConfidenceBasis,
  ScanResult,
  Severity,
  UserStatus,
  type Coverage,
  type Finding,
  type ScopeManifest,
} from './findings.js';
import { EGRESS_CLASSES, EgressClass } from './findings.js';
import { scopeCoverageSentence, sealFindings } from './seal.js';
import { isRedactedCell } from './redaction.js';

/**
 * The number that lets a reader six versions from now know what they have.
 *
 * Fixed from the first release and never reused for a different meaning, for
 * the reason `_doc/16` §4 gives about the backup envelope: a format version
 * that shifts meaning is worse than no version at all.
 */
export const EVIDENCE_PACK_FORMAT = 1;

const PACK_KIND = 'ledar.evidence-pack';

// `EgressClass` and `EGRESS_CLASSES` moved to `./findings.js` when every
// claim gained an `egressClass` of its own (_doc/05 section 7). Defining the
// vocabulary here and the field there would have been two answers to one
// question, which is the shape this repository keeps having to take apart.

/**
 * The classes a thing may carry and still be written into a pack.
 *
 * Written out rather than derived by filtering `EGRESS_CLASSES`, and the
 * difference is the whole safety property. Filtering is a denylist wearing a
 * comprehension: add a fourth class to the vocabulary tomorrow and it would
 * join this list by default, travelling because nobody remembered to stop it.
 * Declared, a class nobody has listed here is refused whatever it is called —
 * which is lesson 13 of HANDOFF-STATUS §4 applied to the one field that says
 * how far something is allowed to go.
 *
 * `never-leaves` is absent, and that is the rule, not a note about the rule.
 * Nothing in the product emits a finding carrying it today; a rule that starts
 * to — one that samples a row value into a claim, say — must find this door
 * shut rather than find its claim quietly missing from the export.
 */
export const MAY_TRAVEL = [
  'customer-system-metadata',
  'product-constant',
] as const;
export type ExportableEgressClass = (typeof MAY_TRAVEL)[number];

const NEVER_LEAVES: EgressClass = 'never-leaves';

/** The sentence a refused claim comes with. It is the same one every time. */
const WHY_NEVER_LEAVES =
  'A claim marked `never-leaves` is one the rule that produced it said may\n' +
  'not go anywhere — a row value, a connection detail, the contents of a\n' +
  'sample. `_doc/16` §2 puts those on the list of things that stay on the\n' +
  'machine, encrypted or otherwise.\n\n' +
  'It is refused rather than dropped, and the difference is the point. A\n' +
  'pack that silently omitted it would be a report missing a finding, with\n' +
  'nothing anywhere saying so — the reader would count what is in front of\n' +
  'them and get a number that is wrong in the safe-looking direction. The\n' +
  'rule that produced this claim has to be fixed, or the claim has to be\n' +
  'reclassified by somebody who can say why.';

/** How the run this pack describes ended. `unknown` is never guessed away. */
export const RUN_OUTCOMES = [
  'completed',
  'failed',
  'refused',
  'unknown',
] as const;
export type PackRunOutcome = (typeof RUN_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// the shape that leaves
// ---------------------------------------------------------------------------

export type PackNotice = {
  whatThisIs: readonly string[];
  /**
   * What is in the file. Nothing here may be `never-leaves`: a section listed
   * as present and classified as unable to travel is a contradiction, and the
   * one that would be believed is the reassuring half.
   */
  contains: readonly {
    section: string;
    egressClass: ExportableEgressClass;
    what: string;
  }[];
  /** What was left behind. `never-leaves` is the whole point of this list. */
  excludes: readonly { section: string; egressClass: EgressClass; why: string }[];
  limits: readonly string[];
  /** The two denominators, in the sentence `seal.ts` already owns. */
  scopeSentence: string;
};

export type PackScope = {
  database: string;
  role: string;
  schemas: readonly string[];
  visibleTables: number;
  totalTables: number | null;
  grantedAt: string | null;
  readOnlyEnforcedByDatabase: boolean;
  /** Whether the local report carried a read-only disclosure line. */
  disclosureShownLocally: boolean;
};

export type PackEvidence = {
  rowCount: number;
  sampleSize: number | null;
  durationMs: number;
  /**
   * Sample cells, in the redacted form the packs produce: `<text:14>`,
   * `<uuid>`, `<number>`, `null`. Every cell is re-checked here; one that
   * still holds a value is refused, not dropped.
   */
  valueShapes: readonly Record<string, string | null>[];
};

export type PackFinding = {
  id: string;
  rule: string;
  kind: ClaimKind;
  confidence: Confidence;
  severity: Severity;

  // ---- provenance ---------------------------------------------------------
  //
  // This is what `_doc/05` §7 was asking for, arriving at the only place it
  // was ever really about. A claim inside a pack has left the machine: it is
  // in somebody's inbox, in a ticket, in a model's prompt behind a proxy, and
  // everything the scan knew about how it was measured is a thousand miles
  // away. A reader holding it can either believe it or not — unless it says.

  /** Read from the catalog, counted, sampled, or proposed off a name. */
  origin: ClaimOrigin;
  /** What the confidence rests on, so a reader can disagree with it. */
  confidenceBasis: ConfidenceBasis;
  /**
   * How far this claim may travel — and therefore never `never-leaves`.
   *
   * The narrow type is the first of two locks. The second is
   * `assertPackIsRedacted`, which re-checks the value on the way to bytes,
   * because a type is a compile-time claim and a file is a run-time fact.
   */
  egressClass: ExportableEgressClass;
  /** When this claim was measured. Not when the run started. */
  observedAt: string;
  /** Which version of the rule produced it. */
  engineRuleVersion: string;
  /**
   * Whether the system's owner has ruled on it.
   *
   * `unreviewed` today, always, because nothing asks yet. It travels anyway,
   * so that a reader is told nobody has been asked rather than left to read
   * an absent field as agreement.
   */
  userStatus: UserStatus;

  schema: string;
  table: string;
  columns: readonly string[];
  /** True when this claim carried the sentence saying where it stopped. */
  boundaryStated: boolean;
  evidence: PackEvidence | null;
  coverage: {
    checked: number;
    eligible: number | null;
    skipped: { count: number; targets: readonly string[] };
    truncatedAt: number | null;
  };
};

export type EvidencePack = {
  formatVersion: number;
  kind: typeof PACK_KIND;
  generatedAt: string;
  /** The class of the file itself. A pack that could not travel is not a pack. */
  egressClass: ExportableEgressClass;
  notice: PackNotice;
  scan: {
    startedAt: string;
    finishedAt: string;
    outcome: PackRunOutcome;
    /** True when a budget ceiling stopped at least one check. */
    truncated: boolean;
  };
  scope: PackScope;
  findings: readonly PackFinding[];
};

declare const REDACTED: unique symbol;

/**
 * A pack that has been through `buildEvidencePack`.
 *
 * The brand exists only in the type system. Its job is the same as
 * `SealedFinding`'s: make the gate unavoidable rather than merely available.
 * Anything that writes bytes takes this type and nothing else, so a payload
 * that has not been through the gate has no type in which it could be written
 * to a file.
 */
export type RedactedEvidencePack = EvidencePack & {
  readonly [REDACTED]: 'checked at the export gate';
};

/**
 * Thrown when something is not fit to leave the machine.
 *
 * It throws rather than dropping the offending field, for the reason
 * `assertSampleIsRedacted` gives: a silent drop leaves the caller believing
 * redaction worked. Here the stakes are one step higher — the caller is about
 * to hand the result to another person.
 */
export class EvidenceRefused extends Error {
  readonly where: string;

  constructor(message: string, where: string) {
    super(message);
    this.name = 'EvidenceRefused';
    this.where = where;
  }
}

function refuse(where: string, problem: string, why: string): EvidenceRefused {
  return new EvidenceRefused(
    `This will not be exported.\n\n` +
      `  where:   ${where}\n` +
      `  problem: ${problem}\n\n` +
      `${why
        .split('\n')
        .map((l) => (l.length > 0 ? `  ${l}` : l))
        .join('\n')}\n\n` +
      `  Nothing was written. An Evidence Pack is a file the user hands to\n` +
      `  somebody else; a pack with one unredacted value in it is worse than\n` +
      `  no pack, because it looks safe.`,
    where,
  );
}

// ---------------------------------------------------------------------------
// what a string is allowed to be
// ---------------------------------------------------------------------------
//
// `REDACTED_CELL`, `isRedactedCell` and the producer that satisfies them now
// live in `./redaction.js`. They were defined here first, next to the only
// code that read them; they moved once the packs started using the same
// producer, because a rule about what a value may look like belongs beside the
// function that makes values look that way, not beside one of its readers.

/**
 * Shapes that are never an identifier and are always somebody's data.
 *
 * A denylist, and denylists are the weaker kind of check — which is why it is
 * not the only one. It guards a channel that is already narrow: everything it
 * inspects was built by this codebase from a schema graph, so in normal
 * operation nothing here ever fires. It exists for the rule that starts
 * interpolating a value into an id, which is a change nobody would notice in
 * review.
 *
 * Words like `token`, `secret` and `password` are deliberately absent. A table
 * named `api_keys` and a column named `password_hash` are ordinary, and a scan
 * that cannot report on them is a scan with a blind spot where the interesting
 * tables are.
 */
const NEVER_AN_IDENTIFIER: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /[^\s@]+@[^\s@]+\.[A-Za-z]{2,}/, what: 'an email address' },
  { pattern: /:\/\//, what: 'a connection string' },
  {
    pattern: /(?:^|[?&;\s])(?:password|pwd)\s*=/i,
    what: 'a password in a connection string',
  },
  { pattern: /eyJ[A-Za-z0-9_-]{10,}/, what: 'a JSON web token' },
  { pattern: /\d{9,}/, what: 'a long run of digits — a phone or account number' },
  { pattern: /[\u0000-\u001f\u007f]/, what: 'a control character' },
];

/** Postgres caps an identifier at 63 bytes; a finding id concatenates a few. */
const IDENTIFIER_MAX = 300;

/** What is wrong with a string that claims to be a name, or null. */
function identifierProblem(value: string): string | null {
  if (value.length > IDENTIFIER_MAX) {
    return `a name ${value.length} characters long`;
  }
  for (const { pattern, what } of NEVER_AN_IDENTIFIER) {
    if (pattern.test(value)) return `a name that contains ${what}`;
  }
  return null;
}

const WHY_NOT_AN_IDENTIFIER =
  'Schema identifiers are safe to export and this is not one. Postgres\n' +
  'allows 63 bytes in a name; a rule id concatenates a few of them and\n' +
  'nothing legitimate goes past that. A string that is longer, or that\n' +
  'holds a contact detail or a credential, was built out of a value\n' +
  'instead of out of the schema graph — which means a row from somebody’s\n' +
  'database has reached a field nothing downstream will think to check.';

function checkIdentifier(value: string, where: string): void {
  const problem = identifierProblem(value);
  if (problem !== null) throw refuse(where, problem, WHY_NOT_AN_IDENTIFIER);
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function checkTimestamp(value: string, where: string): void {
  if (!ISO_TIMESTAMP.test(value)) {
    throw refuse(
      where,
      `"${value}" is not an ISO-8601 timestamp`,
      'Times in a pack are machine-readable or they are not there. A free-\n' +
        'form date is a free-form string, and a free-form string is the one\n' +
        'thing this gate cannot check.',
    );
  }
}

// ---------------------------------------------------------------------------
// the prose, all of it, in one place
// ---------------------------------------------------------------------------

/**
 * Every sentence a pack can contain.
 *
 * Collected as constants rather than written inline so that the entire text
 * surface of an exported file can be read in one screen, and so that
 * `assertPackIsRedacted` can check that the prose in a pack is exactly this
 * prose and nothing that got interpolated into it later.
 */
const NOTICE = {
  whatThisIs: [
    'This file was exported from LEDAR by the person who ran the scan. It ' +
      'describes the structure of a database and what a set of rules found ' +
      'in it.',
    'It holds no row values, no connection string and no credential. It does ' +
      'hold schema, table and column names, which are not personal data but ' +
      'are a description of somebody else’s system. Treat it as theirs.',
    'Read `notice.excludes` before concluding that anything here is a ' +
      'complete account of the scan. Several things were deliberately left ' +
      'behind, and the report on the user’s screen says more than this ' +
      'file does.',
  ],

  contains: [
    {
      section: 'scope.database, scope.role, scope.schemas',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'The names of the database, the role the scan connected as, and the ' +
        'schemas it was pointed at. Names only — no host, no port, no ' +
        'password, nothing that could be used to connect.',
    },
    {
      section: 'scope.visibleTables, scope.totalTables',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'Two denominators: how many tables the scan could read, and how many ' +
        'exist. `null` for the second means nobody could tell us, which is ' +
        'not the same as the two being equal.',
    },
    {
      section: 'findings[].id, .rule, .schema, .table, .columns',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'Which rule fired and what it fired on. A report that cannot name a ' +
        'table is not a report, so these are here — and they are the ' +
        'reason this file is a map of somebody’s system.',
    },
    {
      section: 'findings[].kind, .confidence, .severity',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'How much weight the claim carries. `inference` is a pattern that ' +
        'was noticed and may well be intentional; it is not a defect until ' +
        'the person who owns the system says it was not intended.',
    },
    {
      section:
        'findings[].origin, .confidenceBasis, .observedAt, .userStatus, ' +
        '.egressClass',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'Where each claim came from and what its confidence stands on, so ' +
        'you can weigh it without us in the room. `catalog` means Postgres ' +
        'itself said so; `counted` means every matching row was counted; ' +
        '`sampled` means part was measured and the rest is arithmetic; ' +
        '`name_pattern` means two names looked alike and nothing was ' +
        'compared. `observedAt` is when that particular claim was measured, ' +
        'not when the scan began — a long scan is several statements about ' +
        'several moments. `userStatus` is `unreviewed` on every claim here, ' +
        'and that means nobody has been asked yet; it does not mean anyone ' +
        'agreed. `egressClass` is what class of data the claim is; a claim ' +
        'that may not travel is refused at export rather than dropped from ' +
        'this list.',
    },
    {
      section: 'findings[].engineRuleVersion',
      egressClass: 'product-constant' as ExportableEgressClass,
      what:
        'Which version of which LEDAR rule produced the claim. This one is ' +
        'ours, not yours — it holds nothing about the database. It is here ' +
        'so that two packs taken months apart can be compared without ' +
        'mistaking a rule we rewrote for something that changed in your ' +
        'system.',
    },
    {
      section: 'findings[].evidence.rowCount, .sampleSize, .durationMs',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'How many rows the rule counted, how many it sampled, and how long ' +
        'the query took. Counts, not rows.',
    },
    {
      section: 'findings[].evidence.valueShapes',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'What sampled cells looked like, never what they were: `<uuid>`, ' +
        '`<number>`, `<text:14>`, and the four-character string "null" for ' +
        'an empty cell. `<text:14>` does disclose that a ' +
        'value was fourteen characters long. Every cell is re-checked at ' +
        'export; a pack containing anything else does not get written.',
    },
    {
      section: 'findings[].coverage',
      egressClass: 'customer-system-metadata' as ExportableEgressClass,
      what:
        'The fraction behind the finding: how many targets the rule applied ' +
        'to, how many it examined, how many it did not, and whether a limit ' +
        'stopped it early. `eligible: null` means the rule could not work ' +
        'out its own denominator — it does not mean zero.',
    },
    {
      section: 'notice.*',
      egressClass: 'product-constant' as ExportableEgressClass,
      what:
        'This section. Written by LEDAR, not taken from the scan. It is the ' +
        'only prose in the file.',
    },
  ],

  excludes: [
    {
      section: 'findings[].plainText, .technical, .boundary',
      egressClass: 'never-leaves' as EgressClass,
      why:
        'The sentences the user saw on screen. They are written by rule code ' +
        'that interpolates whatever it has to hand, and there is no way to ' +
        'prove a sentence is free of somebody’s data by inspecting it. ' +
        'A person’s name has no detectable shape. The numbers those ' +
        'sentences were built from are all here; the sentences are not.',
    },
    {
      section: 'findings[].coverage.skipped[].reason',
      egressClass: 'never-leaves' as EgressClass,
      why:
        'Why a target went unexamined. This is often the database’s own ' +
        'error message, and a Postgres error quotes the offending value back ' +
        'at you inside the sentence — the failing key, verbatim. The targets ' +
        'and their count are here; the reasons stayed on the machine.',
    },
    {
      section: 'findings[].evidence.sql',
      egressClass: 'never-leaves' as EgressClass,
      why:
        'The query text, and not even a hash of it. A CHECK constraint can ' +
        'contain literal values and Layer A embeds the constraint expression ' +
        'in its query. This file is therefore not reproducible on its own, ' +
        'which is the cost of that decision.',
    },
    {
      section: 'the connection',
      egressClass: 'never-leaves' as EgressClass,
      why:
        'Host, port, connection string, password, API key. `_doc/16` §2 ' +
        'puts all of these on the list of things that never leave the ' +
        'machine, encrypted or otherwise. The store does not hold them ' +
        'either.',
    },
    {
      section: 'row values',
      egressClass: 'never-leaves' as EgressClass,
      why:
        'Any cell from any table. Rule 6 of AGENTS.md §3: no byte of ' +
        'real data leaves the machine outside a redacted pack, and a ' +
        'redacted pack is one with the values already gone.',
    },
  ],

  limits: [
    'A negative claim never appears here on its own. "Nothing was found" is ' +
      'only worth reading beside "out of how many", so every finding carries ' +
      'its coverage fraction and the scope carries its two denominators.',
    'Identifiers are checked for shape, for length, and for anything that ' +
      'looks like a contact detail or a credential. A table genuinely named ' +
      'after a person would pass that check. Nothing here can detect that.',
    'This pack describes one run. It says nothing about what changed since ' +
      'the last one, and nothing about the parts of the database the scan ' +
      'was not pointed at.',
  ],
} as const;

const READ_ONLY_NOT_ENFORCED =
  'The database was NOT enforcing read-only on this connection. The promise ' +
  'that nothing was written is made by this software, not by Postgres. Every ' +
  'number below inherits that.';

const RUN_DID_NOT_COMPLETE =
  'The run this pack describes did not complete. Findings that are absent ' +
  'may be absent because a rule never got to run, which looks exactly like a ' +
  'rule that found nothing.';

const RUN_OUTCOME_UNKNOWN =
  'How the run ended was not recorded. It is left as `unknown` rather than ' +
  'assumed to be a success — those are the two answers that look ' +
  'identical on a screen.';

const RUN_TRUNCATED =
  'A budget ceiling stopped at least one check before it had finished. Counts ' +
  'here are lower bounds, not totals.';

const SAMPLES_NOT_KEPT =
  'No value shapes are present. The scan that produced this run was told not ' +
  'to keep sample rows, so their shapes were never recorded — this is ' +
  'not a finding about the data.';

/** Every sentence above, flattened, for the check in `assertPackIsRedacted`. */
const KNOWN_PROSE: ReadonlySet<string> = new Set<string>([
  ...NOTICE.whatThisIs,
  ...NOTICE.contains.flatMap((c) => [c.section, c.what]),
  ...NOTICE.excludes.flatMap((e) => [e.section, e.why]),
  ...NOTICE.limits,
  READ_ONLY_NOT_ENFORCED,
  RUN_DID_NOT_COMPLETE,
  RUN_OUTCOME_UNKNOWN,
  RUN_TRUNCATED,
  SAMPLES_NOT_KEPT,
  ...EGRESS_CLASSES,
]);

// ---------------------------------------------------------------------------
// building
// ---------------------------------------------------------------------------

export type BuildEvidencePackOptions = {
  /** ISO-8601. Defaults to now; passed explicitly so a pack is reproducible. */
  generatedAt?: string;
  /** How the run ended. Never guessed: the default is `unknown`. */
  runOutcome?: PackRunOutcome;
  /** Whether a budget ceiling cut a check short. */
  truncated?: boolean;
  /** Whether the local report carried a read-only disclosure line. */
  disclosureShownLocally?: boolean;
};

function packEvidence(finding: Finding, where: string): PackEvidence | null {
  const evidence = finding.evidence;
  if (evidence === null) return null;

  const valueShapes: Record<string, string | null>[] = [];
  for (const [index, row] of evidence.sample.entries()) {
    const shaped: Record<string, string | null> = {};
    for (const [column, value] of Object.entries(row)) {
      const cell = `${where}.evidence.sample[${index}].${column}`;
      checkIdentifier(column, `${where}.evidence.sample[${index}] (column name)`);

      if (!isRedactedCell(value)) {
        throw refuse(
          cell,
          value === null
            ? 'a sample cell holding a bare null'
            : `a sample cell still holding a ${typeof value} value`,
          'Sample rows are reduced to the shape of their values by the pack\n' +
            'that read them — `<uuid>`, `<number>`, `<text:14>`, `null`.\n' +
            'A cell in any other form is a value out of somebody’s\n' +
            'database, one export away from a stranger’s inbox.\n\n' +
            'It is refused rather than dropped. Dropping it would leave this\n' +
            'export looking successful and the rule that produced it looking\n' +
            'correct, and the next value would go the same way unseen.',
        );
      }

      shaped[column] = value === null ? null : (value as string);
    }
    valueShapes.push(shaped);
  }

  return {
    rowCount: evidence.rowCount,
    sampleSize: evidence.sampleSize,
    // Rounded to a tenth of a millisecond. `performance.now()` hands back
    // thirteen decimal places, none of which anybody measured — and a number
    // like 1.175899999999956 reads, to a person scanning an exported file for
    // anything that looks like data, exactly like a long run of digits.
    durationMs: Math.round(evidence.durationMs * 10) / 10,
    valueShapes,
  };
}

function packCoverage(coverage: Coverage, where: string): PackFinding['coverage'] {
  const targets = coverage.skipped.map((s, i) => {
    checkIdentifier(s.target, `${where}.coverage.skipped[${i}].target`);
    return s.target;
  });

  return {
    checked: coverage.checked,
    eligible: coverage.eligible,
    // `reason` is not carried. See `NOTICE.excludes`.
    skipped: { count: coverage.skipped.length, targets },
    truncatedAt: coverage.truncatedAt,
  };
}

/**
 * Refuses a claim its own producer said may not travel, and narrows the rest.
 *
 * The one gate here that is about a decision somebody else already made. Every
 * other check in this file asks whether a string looks like data; this one
 * reads a label the rule attached and does what the label says.
 *
 * Written as a search of `MAY_TRAVEL` rather than a comparison against
 * `never-leaves`, so it is a whitelist rather than a denylist with two
 * entries: a fourth egress class invented next year is refused here without
 * anybody having to remember this function exists. Returning the matched
 * literal is what makes the narrowing real — there is no `as` anywhere on this
 * path, so the type the pack carries was proved rather than asserted.
 *
 * Called from `packFinding`, so no claim can be assembled into a pack without
 * passing it, and enforced a second time by `PackSchema` on the way to bytes —
 * `MAY_TRAVEL` is the enum on that field, so a value edited in after the pack
 * was built is refused at `serializeEvidencePack` too. One rule, both doors:
 * the first stops the honest case, the second stops the forged one.
 */
function mayTravel(egressClass: EgressClass, where: string): ExportableEgressClass {
  for (const allowed of MAY_TRAVEL) {
    if (allowed === egressClass) return allowed;
  }

  throw refuse(
    where,
    `a claim classified \`${egressClass}\``,
    egressClass === NEVER_LEAVES
      ? WHY_NEVER_LEAVES
      : 'Every egress class a pack may carry is declared in `MAY_TRAVEL`, and\n' +
        'this is not one of them. A class nobody listed there is a class\n' +
        'nobody decided about, and the decision it needs is whether the data\n' +
        'it labels may leave the machine at all — which is not a decision an\n' +
        'export can make on its own.',
  );
}

function packFinding(finding: Finding, index: number): PackFinding {
  const where = `findings[${index}]`;

  // First, before anything is copied out of it. A claim that may not leave
  // should not have its identifiers inspected and reported on either.
  const egressClass = mayTravel(finding.egressClass, `${where}.egressClass`);

  checkIdentifier(finding.id, `${where}.id`);
  checkIdentifier(finding.rule, `${where}.rule`);
  checkIdentifier(finding.schema, `${where}.schema`);
  checkIdentifier(finding.table, `${where}.table`);
  checkIdentifier(finding.engineRuleVersion, `${where}.engineRuleVersion`);
  checkTimestamp(finding.observedAt, `${where}.observedAt`);
  finding.columns.forEach((c, i) =>
    checkIdentifier(c, `${where}.columns[${i}]`),
  );

  return {
    id: finding.id,
    rule: finding.rule,
    kind: finding.kind,
    confidence: finding.confidence,
    severity: finding.severity,
    origin: finding.origin,
    confidenceBasis: finding.confidenceBasis,
    // The value `mayTravel` handed back, not the one on the finding. They are
    // the same string; taking it from there is what makes it impossible to
    // write this field without having gone through the gate.
    egressClass,
    observedAt: finding.observedAt,
    engineRuleVersion: finding.engineRuleVersion,
    userStatus: finding.userStatus,
    schema: finding.schema,
    table: finding.table,
    columns: [...finding.columns],
    // The sentence itself does not travel; that it existed does. A negative
    // claim without a boundary cannot get this far — `sealFindings` refuses
    // it — so this is `false` only for the three kinds that never carry one.
    // An abstention carries a boundary for a stronger reason than a negative
    // does: it is the whole of what the claim says.
    boundaryStated: finding.kind === 'negative' || finding.kind === 'abstained',
    evidence: packEvidence(finding, where),
    coverage: packCoverage(finding.coverage, where),
  };
}

function packScope(
  scope: ScopeManifest,
  disclosureShownLocally: boolean,
): PackScope {
  checkIdentifier(scope.database, 'scope.database');
  checkIdentifier(scope.role, 'scope.role');
  scope.schemas.forEach((s, i) => checkIdentifier(s, `scope.schemas[${i}]`));
  if (scope.grantedAt !== null) checkTimestamp(scope.grantedAt, 'scope.grantedAt');

  return {
    database: scope.database,
    role: scope.role,
    schemas: [...scope.schemas],
    visibleTables: scope.visibleTables,
    totalTables: scope.totalTables,
    grantedAt: scope.grantedAt,
    readOnlyEnforcedByDatabase: scope.readOnlyEnforcedByDatabase,
    // `scope.disclosure` is prose. Whether one was shown travels; its text
    // does not, and the pack states the same thing in its own words below.
    disclosureShownLocally,
  };
}

/**
 * Builds the only payload allowed to leave, or refuses to build one.
 *
 * @param input   a `ScanResult`, or anything claiming to be one. Typed
 *                `unknown` on purpose: the caller is usually the history
 *                store handing back rows it parsed out of SQLite, which the
 *                compiler never saw.
 * @param options what the `ScanResult` shape has no room for — how the run
 *                ended, whether a ceiling cut it short. Each defaults to the
 *                answer that admits ignorance rather than the flattering one.
 */
export function buildEvidencePack(
  input: unknown,
  options: BuildEvidencePackOptions = {},
): RedactedEvidencePack {
  const parsed = ScanResult.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const at = issue && issue.path.length > 0 ? issue.path.join('.') : 'the input';
    throw refuse(
      at,
      issue ? issue.message : 'it is not a scan result',
      'A pack is built from a scan result: a scope manifest plus findings\n' +
        'that have each been through `sealFindings`. Input that does not fit\n' +
        'that shape has not been checked by anything, and the checks it\n' +
        'skipped are the ones that keep a negative claim from being printed\n' +
        'without its denominator.',
    );
  }

  const result = parsed.data;

  // Put every finding back through the publishing gate before exporting it.
  //
  // Not belt and braces. The input usually comes back out of SQLite, where it
  // has been a row rather than a `Finding` for some months, and `sealFindings`
  // holds the rules a shape cannot express — a negative claim with no
  // denominator, an unconfirmed pattern described as a defect, a numerator
  // larger than its denominator. Re-running it here is what makes "nothing can
  // be exported that could not have been published" true rather than assumed,
  // and it is a call rather than a copy so there is only ever one set of rules.
  //
  // A failure here throws `ClaimRefused`, from `seal.ts`, with its own
  // explanation. Deliberately not rewrapped: that message names the finding
  // and says how to fix it, which is more than this file could say about it.
  sealFindings(result.findings, 'the evidence pack export');

  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const outcome: PackRunOutcome = options.runOutcome ?? 'unknown';
  const truncated = options.truncated ?? false;

  checkTimestamp(generatedAt, 'generatedAt');
  checkTimestamp(result.startedAt, 'scan.startedAt');
  checkTimestamp(result.finishedAt, 'scan.finishedAt');

  const scope = packScope(result.scope, options.disclosureShownLocally ?? false);

  // Sorted by id so that two runs that found the same things produce the same
  // bytes. A pack whose byte order depends on the order rules happened to
  // finish in cannot be diffed, hashed or compared.
  const findings = result.findings
    .map((f, i) => packFinding(f, i))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const limits: string[] = [...NOTICE.limits];
  if (!scope.readOnlyEnforcedByDatabase) limits.unshift(READ_ONLY_NOT_ENFORCED);
  if (outcome === 'unknown') limits.unshift(RUN_OUTCOME_UNKNOWN);
  else if (outcome !== 'completed') limits.unshift(RUN_DID_NOT_COMPLETE);
  if (truncated) limits.unshift(RUN_TRUNCATED);
  if (findings.every((f) => (f.evidence?.valueShapes.length ?? 0) === 0)) {
    limits.push(SAMPLES_NOT_KEPT);
  }

  const pack: EvidencePack = {
    formatVersion: EVIDENCE_PACK_FORMAT,
    kind: PACK_KIND,
    generatedAt,
    egressClass: 'customer-system-metadata',
    notice: {
      whatThisIs: [...NOTICE.whatThisIs],
      contains: NOTICE.contains.map((c) => ({ ...c })),
      excludes: NOTICE.excludes.map((e) => ({ ...e })),
      limits,
      scopeSentence: scopeCoverageSentence(result.scope),
    },
    scan: {
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      outcome,
      truncated,
    },
    scope,
    findings,
  };

  assertPackIsRedacted(pack);
  return pack as RedactedEvidencePack;
}

// ---------------------------------------------------------------------------
// the shape a pack has to fit, field by field, with no room to the side
// ---------------------------------------------------------------------------

/**
 * Why this is a declared schema and not a walk over the object.
 *
 * The first version of this check walked the payload and asked of every
 * string: is it an identifier, a timestamp, a redacted cell, or a known token?
 * It looked thorough and it had a hole wide enough to drive a sentence
 * through. `"belongs to Nguyen Thi Bich Ngoc"` is short, holds no digits, no
 * `@`, no `://` — it passes every one of those tests, because a person's name
 * has no shape. The test that plants prose in a finding after the pack was
 * built caught it, which is the only reason it is not still there.
 *
 * So the rule is inverted. Instead of asking whether a value looks dangerous,
 * every field a pack may contain is declared, every object is `.strict()`, and
 * anything not on the list is refused *whatever it says*. A `plainText` added
 * to a finding is refused because `plainText` is not a field of a pack — not
 * because something recognised the name inside it.
 *
 * One place has keys that cannot be declared in advance: the column names
 * inside `valueShapes`. Those are checked as identifiers, and their values may
 * only be a redacted cell shape.
 */
const IDENTIFIER = z.string().superRefine((value, ctx) => {
  const problem = identifierProblem(value);
  if (problem !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }
});

const TIMESTAMP = z.string().regex(ISO_TIMESTAMP, 'is not an ISO-8601 timestamp');

const CELL_SHAPE = z
  .union([z.null(), z.string()])
  .superRefine((value, ctx) => {
    if (!isRedactedCell(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'is not a redacted value shape — expected <uuid>, <number>, ' +
          '<text:14> or null',
      });
    }
  });

/** Prose. Unconstrained here; constrained by identity in `checkNotice`. */
const CONSTANT = z.string();

const PackSchema = z
  .object({
    formatVersion: z.literal(EVIDENCE_PACK_FORMAT),
    kind: z.literal(PACK_KIND),
    generatedAt: TIMESTAMP,
    // `MAY_TRAVEL`, not `EGRESS_CLASSES`. A pack declaring itself
    // `never-leaves` and then being written to a file is a contradiction, and
    // the half a reader would act on is the file.
    egressClass: z.enum(MAY_TRAVEL),
    notice: z
      .object({
        whatThisIs: z.array(CONSTANT),
        contains: z.array(
          z
            .object({
              section: CONSTANT,
              // What is in the file cannot be classified as unable to leave.
              // `excludes` below keeps the full vocabulary, because saying
              // what stayed behind is the one place `never-leaves` belongs.
              egressClass: z.enum(MAY_TRAVEL),
              what: CONSTANT,
            })
            .strict(),
        ),
        excludes: z.array(
          z
            .object({
              section: CONSTANT,
              egressClass: z.enum(EGRESS_CLASSES),
              why: CONSTANT,
            })
            .strict(),
        ),
        limits: z.array(CONSTANT),
        scopeSentence: CONSTANT,
      })
      .strict(),
    scan: z
      .object({
        startedAt: TIMESTAMP,
        finishedAt: TIMESTAMP,
        outcome: z.enum(RUN_OUTCOMES),
        truncated: z.boolean(),
      })
      .strict(),
    scope: z
      .object({
        database: IDENTIFIER,
        role: IDENTIFIER,
        schemas: z.array(IDENTIFIER),
        visibleTables: z.number().int().nonnegative(),
        totalTables: z.number().int().nonnegative().nullable(),
        grantedAt: TIMESTAMP.nullable(),
        readOnlyEnforcedByDatabase: z.boolean(),
        disclosureShownLocally: z.boolean(),
      })
      .strict(),
    findings: z.array(
      z
        .object({
          id: IDENTIFIER,
          rule: IDENTIFIER,
          kind: ClaimKind,
          confidence: Confidence,
          severity: Severity,
          origin: ClaimOrigin,
          confidenceBasis: ConfidenceBasis,
          // The second lock on the `never-leaves` rule, and the one that
          // holds when the first is walked around. `buildEvidencePack`
          // refuses such a claim; this refuses a pack whose claim was
          // relabelled after the build, on the way to bytes.
          egressClass: z.enum(MAY_TRAVEL),
          observedAt: TIMESTAMP,
          engineRuleVersion: IDENTIFIER,
          userStatus: UserStatus,
          schema: IDENTIFIER,
          table: IDENTIFIER,
          columns: z.array(IDENTIFIER),
          boundaryStated: z.boolean(),
          evidence: z
            .object({
              rowCount: z.number().int().nonnegative(),
              sampleSize: z.number().int().nonnegative().nullable(),
              durationMs: z.number().nonnegative(),
              valueShapes: z.array(z.record(IDENTIFIER, CELL_SHAPE)),
            })
            .strict()
            .nullable(),
          coverage: z
            .object({
              checked: z.number().int().nonnegative(),
              eligible: z.number().int().nonnegative().nullable(),
              skipped: z
                .object({
                  count: z.number().int().nonnegative(),
                  targets: z.array(IDENTIFIER),
                })
                .strict(),
              truncatedAt: z.number().int().positive().nullable(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

/** The explanation that goes with each way the schema can be failed. */
function whyRefused(issue: z.ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return (
      'Every field a pack may contain is declared, and this is not one of\n' +
      'them. That is deliberate: a field nobody declared is a field nobody\n' +
      'checked, and the only thing this gate can say about an undeclared\n' +
      'string is that it does not know what is in it.\n\n' +
      'If the pack really should carry this, add it to `PackSchema` in\n' +
      'evidence-pack.ts and say what class of data it is in `NOTICE`.'
    );
  }
  if (issue.path.includes('valueShapes')) {
    return (
      'Sample rows are reduced to the shape of their values by the pack\n' +
      'that read them — `<uuid>`, `<number>`, `<text:14>`, `null`. A cell\n' +
      'in any other form is a value out of somebody’s database, one export\n' +
      'away from a stranger’s inbox.'
    );
  }
  // Checked by the last path segment rather than by `includes`, so that a
  // field merely *named* something similar somewhere else in the tree cannot
  // borrow this explanation. `notice.excludes[].egressClass` keeps the full
  // vocabulary and never reaches here.
  if (issue.path[issue.path.length - 1] === 'egressClass') {
    return WHY_NEVER_LEAVES;
  }
  return WHY_NOT_AN_IDENTIFIER;
}

/**
 * The two numbers `scopeCoverageSentence` reads, pulled out of a pack scope.
 *
 * The sentence lives in `seal.ts` and takes a whole `ScopeManifest`, which a
 * pack is not: a pack does not carry the connector's disclosure text, and
 * inventing one to satisfy a type would be the kind of placeholder that later
 * gets read as a measurement. So the two denominators are lifted out and
 * checked, and the remaining fields are handed across as what they are. The
 * function reads neither.
 */
function denominatorsOf(scope: object): ScopeManifest {
  const s = scope as Partial<PackScope>;

  if (
    typeof s.visibleTables !== 'number' ||
    (s.totalTables !== null && typeof s.totalTables !== 'number')
  ) {
    throw refuse(
      'scope.visibleTables / scope.totalTables',
      'the two denominators are not both numbers',
      'How much of a database was looked at is the one thing a report\n' +
        'cannot be vague about. A missing denominator is what turns "I did\n' +
        'not look there" into "there was nothing there".',
    );
  }

  return {
    database: typeof s.database === 'string' ? s.database : '',
    role: typeof s.role === 'string' ? s.role : '',
    schemas: Array.isArray(s.schemas) ? [...s.schemas] : [],
    visibleTables: s.visibleTables,
    totalTables: s.totalTables ?? null,
    grantedAt: typeof s.grantedAt === 'string' ? s.grantedAt : null,
    readOnlyEnforcedByDatabase: s.readOnlyEnforcedByDatabase === true,
    disclosure: null,
  };
}

/**
 * Checks a whole pack again, field by field, and refuses on the first problem.
 *
 * Run twice: once at the end of `buildEvidencePack`, and once inside
 * `serializeEvidencePack` on whatever it was handed. The second run is the
 * one that matters. The brand on `RedactedEvidencePack` stops an honest
 * mistake; `as unknown as RedactedEvidencePack` gets past it in one line, and
 * this does not.
 *
 * The pack has two halves and they are checked differently.
 *
 *   `notice` is prose, and prose cannot be checked for content — so it is
 *   checked for *identity*: every sentence has to be one of the constants in
 *   this file, and `scopeSentence` has to be exactly what
 *   `scopeCoverageSentence` produces for this scope. Today that is nearly a
 *   tautology, because `buildEvidencePack` assembles it from those constants.
 *   It stops being one the moment somebody interpolates a value into a
 *   sentence, which is the edit this is here to catch.
 *
 *   Everything else is data, and every field of it is declared in
 *   `PackSchema`, which is `.strict()` all the way down. A string can only be
 *   an identifier, a timestamp, a redacted cell shape or a contract enum
 *   token, and a *field* can only be one somebody declared. There is no fifth
 *   option and no undeclared corner, and that is the whole safety property.
 */
export function assertPackIsRedacted(pack: unknown): void {
  const parsed = PackSchema.safeParse(pack);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (!issue) {
      throw refuse('the pack', 'it is not an evidence pack', WHY_NOT_AN_IDENTIFIER);
    }

    const at = issue.path.length > 0 ? issue.path.join('.') : 'the pack itself';
    const problem =
      issue.code === 'unrecognized_keys'
        ? `a field a pack has no room for: ${issue.keys.join(', ')}`
        : issue.message;

    throw refuse(at, problem, whyRefused(issue));
  }

  const p = parsed.data;

  // The two denominators, and the sentence that has to agree with them.
  const expected = scopeCoverageSentence(denominatorsOf(p.scope));
  if (p.notice.scopeSentence !== expected) {
    throw refuse(
      'notice.scopeSentence',
      'the coverage sentence does not match the scope beside it',
      'The sentence is generated from the two denominators in `scope`. One\n' +
        'that disagrees with them was either edited by hand or built from\n' +
        'something else, and either way the number a person reads is not the\n' +
        'number the scan measured.',
    );
  }

  // Prose cannot be checked for content, so it is checked for identity.
  for (const [key, value] of Object.entries(p.notice)) {
    if (key === 'scopeSentence') continue;
    for (const text of collectStrings(value)) {
      if (!KNOWN_PROSE.has(text)) {
        throw refuse(
          `notice.${key}`,
          'a sentence that is not one of this file’s own',
          'The notice section is the only prose in a pack, and it is written\n' +
            'by LEDAR rather than taken from the scan. A sentence that is not\n' +
            'one of the constants in `evidence-pack.ts` was assembled from\n' +
            'something, and the thing it was assembled from is the customer’s\n' +
            'database.',
        );
      }
    }
  }

  // Two numbers that can both be present and cannot both be true. Zod counts
  // the array; nothing but this notices when the count disagrees with it.
  for (const [i, finding] of p.findings.entries()) {
    const c = finding.coverage;
    if (c.skipped.count !== c.skipped.targets.length) {
      throw refuse(
        `findings[${i}].coverage.skipped`,
        `it says ${c.skipped.count} targets went unexamined and lists ` +
          `${c.skipped.targets.length}`,
        'The count is what a reader takes away and the list is what they can\n' +
          'check it against. When they disagree, the number is the one that\n' +
          'gets believed.',
      );
    }
  }
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
  }
  return [];
}

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

/**
 * The only function here that produces something writable.
 *
 * It takes `RedactedEvidencePack` and nothing else, so there is no expression
 * in this codebase that turns an unchecked payload into bytes. And it checks
 * again anyway, because a brand is a compile-time claim and a file is a
 * run-time fact.
 *
 * Indented and newline-terminated: a pack is read by a person at least as
 * often as by a program, and a person reading a wall of JSON stops reading.
 */
export function serializeEvidencePack(pack: RedactedEvidencePack): string {
  assertPackIsRedacted(pack);
  return `${JSON.stringify(pack, null, 2)}\n`;
}
