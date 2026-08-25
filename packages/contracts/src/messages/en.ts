/**
 * English — the language the product was written in, and the reference text.
 *
 * Every sentence here is the wording that shipped before the catalogue
 * existed, moved rather than rewritten. That matters for one reason: 483 tests
 * and two field measurements were taken against these words, and quietly
 * improving them while extracting them would have thrown away what the reports
 * in `field-data/vs7/` are evidence about.
 */

// Type-only. This file must not import anything from i18n.ts at
// runtime: i18n.ts imports THIS file, and a value-level cycle would
// make which half initialises first depend on who imported what.
import type { Catalog } from '../i18n.js';

const s = (p: Record<string, string | number>, key: string): string =>
  String(p[key] ?? '');
const n = (p: Record<string, string | number>, key: string): number =>
  Number(p[key] ?? 0);
const plural = (count: number, one: string, many: string): string =>
  count === 1 ? one : many;

export const EN: Catalog = {
  // ---- headings ----
  'head.looked-at': () => 'WHAT I WAS ABLE TO LOOK AT',
  'head.database-confirms': () => 'WHAT THE DATABASE ITSELF CONFIRMS',
  'head.patterns': () => 'PATTERNS WORTH ASKING ABOUT',
  'head.verdict': () => 'WHAT THIS REPORT WILL AND WILL NOT SUPPORT',
  // Names the provenance in the heading itself, the way the other two do.
  // "WHAT THE DATABASE ITSELF CONFIRMS" and "PATTERNS WORTH ASKING ABOUT"
  // both say who is speaking before a reader gets to a single number, and a
  // section holding somebody's own rules has more need of that, not less.
  'head.you-asked': () => 'WHAT YOU ASKED ME TO CHECK',

  // ---- the scan's own voice ----
  'scan.connected-as': (p) => `connected as ${s(p, 'user')}, read-only ${s(p, 'enforcement')}`,
  'scan.read-only-enforced': () => 'enforced by the database',
  'scan.read-only-not-enforced': () => 'NOT enforced',

  'scan.every-table-empty': () => 'EVERY TABLE HERE IS EMPTY.',
  'scan.every-table-empty.body': () =>
    'Nothing below is a statement about your data, because there is no data. ' +
    'Only the structure was examined. A clean result on an empty database ' +
    'means nothing was looked at — not that everything is fine.',
  'scan.tables-empty-line': (p) =>
    `${s(p, 'empty')} of ${s(p, 'total')} tables hold no rows — data rules ` +
    `could not say anything about those`,
  // Parenthesised rather than set off with a dash: the clause after this one
  // already ends in a dash, and two dashes in one line turn a magnitude into
  // an aside.
  'scan.tables-empty-line.share': (p) =>
    `${s(p, 'empty')} of ${s(p, 'total')} tables (${s(p, 'share')} of them) ` +
    `hold no rows — data rules could not say anything about those`,

  'scan.facts-are-facts': () =>
    'The counts here are facts — a query reproduces every one. Whether a ' +
    'fact is a problem is a separate question, and not one I can answer for ' +
    'you.',
  'scan.patterns-preamble': () =>
    'Not problems. Things that look like a rule nobody wrote down. I cannot ' +
    'tell a leftover from a decision — only you can.',
  'scan.nothing-stood-out': () => 'Nothing stood out.',

  'scan.where': (p) => `where: ${s(p, 'target')}`,
  'scan.where-with-severity': (p) =>
    `where: ${s(p, 'target')} (severity: ${s(p, 'severity')})`,
  'scan.why': (p) => `why: ${s(p, 'detail')}`,
  'scan.what-i-measured': (p) => `what I measured: ${s(p, 'detail')}`,
  'scan.but-only-this-far': (p) => `but only this far: ${s(p, 'boundary')}`,
  'scan.and-that-is-all': (p) => `and that is all I can say: ${s(p, 'boundary')}`,

  'scan.layer-b-boundary': (p) =>
    `but only this far: looked at ${s(p, 'considered')} ` +
    `${plural(n(p, 'considered'), 'column', 'columns')} whose name suggests ` +
    `it points at another table, and checked ${s(p, 'verified')} of them ` +
    `against real values. Columns that are named nothing like a reference ` +
    `were not considered at all.`,
  'scan.empty-columns.all': (p) =>
    `All ${s(p, 'checked')} of those had no rows to compare — the tables ` +
    `holding them are empty. A query ran against each and came back with ` +
    `nothing, so nothing at all was learned here. An empty table is not a ` +
    `clean one.`,
  'scan.empty-columns.some': (p) =>
    `${s(p, 'empty')} of those ${s(p, 'checked')} had no rows to compare — ` +
    `the ${plural(n(p, 'empty'), 'table holding it is', 'tables holding them are')} ` +
    `empty, so nothing was learned about ` +
    `${plural(n(p, 'empty'), 'that one', 'them')}. An empty table is not a ` +
    `clean one.`,
  'scan.sampling-floor': (p) =>
    `${s(p, 'columns')} of those columns ` +
    `${plural(n(p, 'columns'), 'was', 'were')} too large to read in full, so ` +
    `${plural(n(p, 'columns'), 'it was', 'they were')} sampled — the ` +
    `smallest sample was ${s(p, 'smallest')} rows. Broken links rarer than ` +
    `roughly ${s(p, 'floor')}% of a table can be missed entirely by a sample ` +
    `that size, so silence about ${plural(n(p, 'columns'), 'it', 'them')} is ` +
    `not the same as a clean bill.`,
  'scan.partitions-covered': (p) =>
    `${s(p, 'count')} partitions were covered by querying their parent ` +
    `table, not skipped`,

  'scan.ruled-out': (p) =>
    `checked and ruled out ${s(p, 'count')} (queried, and the values did not ` +
    `back the guess):`,
  'scan.did-not-check': (p) =>
    `did not check ${s(p, 'count')} (nothing was learned about these):`,
  'scan.silent-rules': () => 'the rules that raised nothing, and what they covered:',
  'scan.cost': (p) =>
    `cost to your database: ${s(p, 'queries')} queries · ${s(p, 'seconds')}s · ` +
    `${s(p, 'rows')} rows read`,
  'scan.revoke': () => 'to take this access away, run:',

  'history.recorded': (p) =>
    `history: recorded as run ${s(p, 'run')} in ${s(p, 'file')}`,
  'history.not-recorded': (p) =>
    `history: this run was NOT recorded — ${s(p, 'problem')}\n` +
    `         the report above stands; there is just nothing for the next\n` +
    `         scan to compare it against`,
  'history.unfinished': (p) =>
    `history: run ${s(p, 'run')} in ${s(p, 'file')} was left unfinished —\n` +
    `         ${s(p, 'problem')}\n` +
    `         the report above stands; that run will read as incomplete,\n` +
    `         because it is`,
  // The reason, stated generally rather than for one bump.
  //
  // This used to say the older format had no room for where a claim came from.
  // True of schema 1, which predates provenance — and false the moment schema
  // 3 was retired by schema 4, because schema 3 carries all six provenance
  // fields. A message that explains a decision with a reason that stopped
  // being true is worse than one that explains nothing: it teaches the reader
  // something about the product that is not so.
  'history.moved': (p) =>
    `history: the file already at that path was written by schema version\n` +
    `         ${s(p, 'version')}, which this build cannot read. It has been\n` +
    `         MOVED, not deleted:\n` +
    `           ${s(p, 'to')}\n` +
    `         Nothing in it was changed — ${s(p, 'held')}. There is no\n` +
    `         upgrade path: the newer format asks each row questions the old\n` +
    `         rows were never asked, and the only way to migrate them is to\n` +
    `         invent the answers. A history full of invented answers is worse\n` +
    `         than a history that starts again.`,
  'history.holds-runs': (p) =>
    `it holds ${s(p, 'runs')} earlier ${plural(n(p, 'runs'), 'run', 'runs')}`,
  'history.holds-nothing': () => 'it held no runs',
  'history.holds-uncounted': () => 'its contents could not be counted',
  'history.delete-freely': () =>
    'Delete it whenever you like. Nothing here will touch it again.',

  // ---- the verdict ----
  'verdict.nothing-seen': () =>
    'Nothing in this report is a statement about your data, because there is ' +
    'no data.',
  'verdict.nothing-seen.all-empty': (p) =>
    `All ${s(p, 'total')} ${plural(n(p, 'total'), 'table', 'tables')} here ` +
    `hold no rows. Only the structure was examined.`,
  'verdict.nothing-seen.meaning': () =>
    'A clean result on an empty database means nothing was looked at — not ' +
    'that everything is fine.',

  'verdict.silence-with-gaps': () =>
    'I raised nothing, and that is not the same as nothing being wrong.',
  'verdict.silence-with-gaps.meaning': () =>
    'An empty table is not a clean one. If you expected data in those ' +
    'tables, the absence is itself worth asking about — and it is the one ' +
    'thing here whose meaning I cannot tell you.',

  'verdict.silence-is-clean': () =>
    'I raised nothing, and this time there is no gap behind that.',
  'verdict.silence-is-clean.meaning': () =>
    'Every target these rules cover had rows in it and was checked. Within ' +
    'the scope on the line above, this is a result rather than a silence — ' +
    'which is not something the other reports in this shape can say.',

  'verdict.raised': (p) =>
    `I raised ${s(p, 'count')} ${plural(n(p, 'count'), 'thing', 'things')}. ` +
    `Whether ${plural(n(p, 'count'), 'it is a problem', 'they are problems')} ` +
    `is your call, not mine.`,
  'verdict.raised.meaning': () =>
    'A rule that raised nothing about those raised nothing because it could ' +
    'not look, not because it looked and was satisfied.',

  'verdict.gap.empty-tables': (p) =>
    `${s(p, 'empty')} of the ${s(p, 'total')} ` +
    `${plural(n(p, 'total'), 'table', 'tables')} ` +
    `${plural(n(p, 'empty'), 'holds', 'hold')} no rows. A query ran against ` +
    `${plural(n(p, 'empty'), 'it', 'them')} and came back with nothing, so ` +
    `nothing was learned there either way.`,
  // The same line with its magnitude said out loud.
  //
  // Everything after the interjection is the wording VS-7 was measured
  // against, unchanged. What failed there was not this sentence's clauses; it
  // was that `18` and `36` were printed and `half` was not.
  'verdict.gap.empty-tables.share': (p) =>
    `${s(p, 'empty')} of the ${s(p, 'total')} ` +
    `${plural(n(p, 'total'), 'table', 'tables')} — ${s(p, 'share')} of ` +
    `${plural(n(p, 'total'), 'it', 'them')} — ` +
    `${plural(n(p, 'empty'), 'holds', 'hold')} no rows. A query ran against ` +
    `${plural(n(p, 'empty'), 'it', 'them')} and came back with nothing, so ` +
    `nothing was learned there either way.`,
  'verdict.gap.empty-columns': (p) =>
    `${s(p, 'count')} ${plural(n(p, 'count'), 'column', 'columns')} that a ` +
    `data rule was aiming at had no rows to compare. ` +
    `${plural(n(p, 'count'), 'That column is', 'Those columns are')} neither ` +
    `clean nor dirty; ${plural(n(p, 'count'), 'it was', 'they were')} ` +
    `unreadable on the only question that mattered.`,
  'verdict.gap.not-checked': (p) =>
    `${s(p, 'count')} ${plural(n(p, 'count'), 'target', 'targets')} a rule ` +
    `was entitled to check ${plural(n(p, 'count'), 'was', 'were')} not ` +
    `checked. They are named above, with the reason for each.`,

  // ---- how big a count is against its whole ----
  //
  // Quantities. Each is interpolated into a sentence above, never printed on
  // its own, and each is either exact or — for the percentage fallback, which
  // is not in this catalogue — off by less than a point.
  'share.quarter': () => 'a quarter',
  'share.third': () => 'a third',
  'share.half': () => 'half',
  'share.two-thirds': () => 'two thirds',
  'share.three-quarters': () => 'three quarters',
  'share.almost-all': () => 'almost all',
  'share.all': () => 'all',

  // ---- what the model step did not add ----
  //
  // Each names the missing ADDITION and says nothing about the report. The
  // findings above came from rule packs and did not change; wording that
  // graded them would claim a model path is better than the packs, and the
  // only measurement this product has points the other way.
  // A reader is never left working out which sentences a machine wrote.
  // `origin: 'model_written'` has been in the claim vocabulary since _doc/05
  // §7 for the same reason; this is that distinction reaching the page.
  'model.addition-heading': () => 'ADDED BY A LANGUAGE MODEL, NOT BY A RULE',
  'model.unavailable': () =>
    'A plain-language summary would normally be added here, and was not: the ' +
    'model this build uses could not be reached. Everything above was ' +
    'produced without it, the same way every report before this feature ' +
    'existed was.',
  // ---- a bounded answer ----
  //
  // Written by a person, measured on people. VS-7 put hand-written prose in
  // front of five readers and four took the right conclusion from it; this is
  // that prose, kept, with a model deciding WHICH of it applies rather than
  // writing its own.
  'answer.rests-on': (p) =>
    `What the scan can say about that rests on: ${s(p, 'facts')}.`,
  'answer.cannot': (p) =>
    `The scan cannot answer that. It did not look at ${s(p, 'missing')}, so ` +
    `anything said about it here would be guessing.`,
  'answer.missing.who': () => 'who was involved',
  'answer.missing.when': () => 'when any of it happened',
  'answer.missing.why': () => 'why it happened',
  'answer.missing.which_rows': () => 'which particular rows these are',
  'answer.missing.impact': () => 'what it costs or affects',
  'answer.missing.elsewhere': () => 'anything outside the tables it was pointed at',

  // The read-back. Second person, present tense, and it names the identifiers
  // in full: a user who sees a table they did not mean has to be able to see
  // it at a glance, because that is the only moment they will.
  'rule.will-check.points-at-an-existing-row': (p) =>
    `I will check that every value in ${s(p, 'columns')} of ${s(p, 'table')} ` +
    `matches a row in ${s(p, 'target')}, and count the ones that do not.`,
  'rule.will-check.is-never-missing': (p) =>
    `I will check that no row in ${s(p, 'table')} leaves ${s(p, 'columns')} ` +
    `empty, and count the ones that do.`,
  'rule.will-check.is-never-repeated': (p) =>
    `I will check that no two rows in ${s(p, 'table')} share the same ` +
    `${s(p, 'columns')}, and count the ones that repeat.`,
  'rule.cannot': (p) =>
    `I cannot turn that into something I can check here. It ${s(p, 'detail')}. ` +
    `That is a limit on what a scan of this database can settle, not a ` +
    `judgement about the rule you described.`,
  'rule.unsupported.needs_a_number': () =>
    'turns on an amount I have no grounds to judge one way or the other',
  'rule.unsupported.needs_time': () =>
    'is about when things happened, and I see this database at one moment',
  'rule.unsupported.needs_meaning': () =>
    'depends on what the values mean to your business, not on what they are',
  'rule.unsupported.needs_another_system': () =>
    'is about something that is not in this database',
  'rule.unsupported.not_about_rows': () =>
    'is about people, process or permission rather than about rows',
  'rule.unsupported.names_nothing_here': () =>
    'does not name a table or column I can find here',

  // After a user's rule has run. Every one of these says whose rule it was,
  // and none of them calls a match a defect — `assertClaimDiscipline` would
  // refuse that anyway at `probable`, and the sentence should not want to.
  'user-rule.found': (p) =>
    `${s(p, 'count')} of the ${s(p, 'total')} rows in ${s(p, 'table')} do not ` +
    `match the rule you described. Whether that matters is yours to say — ` +
    `this is your rule, not something this database declares.`,
  'user-rule.none': (p) =>
    `All ${s(p, 'total')} rows in ${s(p, 'table')} match the rule you ` +
    `described. That is your rule holding today, not a constraint: nothing ` +
    `in the database keeps it true tomorrow.`,
  'user-rule.nothing-to-check': (p) =>
    `${s(p, 'table')} holds no rows, so your rule had nothing to be true or ` +
    `untrue about. An empty table is not a clean one.`,
  'user-rule.technical': (p) =>
    `${s(p, 'rule')} on ${s(p, 'target')}: ${s(p, 'rows')} of ${s(p, 'total')} rows`,
  // The boundary is the SAME sentence whatever the count, because the limit
  // is the same: field-results 24 and 25 measured a model mapping a sentence
  // onto the wrong table while counting perfectly. No number detects that, so
  // no number gets to imply it was checked.
  'user-rule.boundary': () =>
    'I checked the rule exactly as it was read back to you. I did not check ' +
    'whether that is the rule you meant — only you can tell me that.',
  // Printed ONCE above the section, never per finding. It carries what
  // field-results 24 and 25 measured, and that is true of every rule in
  // the section at the same time — VS-7 found what a sentence repeated
  // per finding costs: it stops being read.
  'scan.you-asked-preamble': () =>
    'These are rules you described at setup. I checked each one exactly ' +
    'as it was read back to you — not whether that is the rule you meant. ' +
    'And a rule that holds here is your rule holding today, not the ' +
    'database enforcing it.',

  'fact.column': () => 'which column this is about',
  'fact.what-the-scan-says': () => 'what the scan already says about it',
  'fact.confidence': () => 'how sure the scan is',
  'fact.how-measured': () => 'how it was measured',
  'fact.rows-examined': () => 'how many rows the finding rests on',
  'fact.sampling': () => 'whether every row was counted or a sample was drawn',
  'fact.targets-checked': () => 'how many targets this rule checked',
  'fact.boundary': () => 'what the scan says it cannot conclude',

  'model.declined': () =>
    'A plain-language summary would normally be added here, and was not: ' +
    'sending it would have meant showing part of your data to a third party, ' +
    'and this build will not do that. Everything above was produced without ' +
    'it.',

  // ---- the scope strip ----
  'strip.tables-visible': (p) =>
    `${s(p, 'visible')} of ${s(p, 'total')} tables visible`,
  'strip.tables-visible-no-total': (p) =>
    `${s(p, 'visible')} tables visible, total unknown`,
  'strip.targets-eligible': (p) => `${s(p, 'count')} targets eligible`,
  'strip.targets-eligible-unknown': (p) =>
    `targets eligible unknown (${s(p, 'rules')} ` +
    `${plural(n(p, 'rules'), 'rule', 'rules')} could not say)`,
  'strip.targets-checked': (p) => `${s(p, 'count')} targets checked`,
  'strip.targets-not-checked': (p) => `${s(p, 'count')} not checked`,
  'strip.rules-did-not-run': (p) =>
    `${s(p, 'count')} ${plural(n(p, 'count'), 'rule', 'rules')} did not run`,
  'strip.rule.did-not-run': (p) => `${s(p, 'rule')} — did not run`,
  'strip.rule.no-denominator': (p) =>
    `${s(p, 'rule')} — ran, raised nothing, and cannot say out of how many`,
  'strip.rule.none-exist': (p) =>
    `${s(p, 'rule')} — nothing of this kind exists here to check`,
  'strip.rule.raised-nothing': (p) =>
    `${s(p, 'rule')} — raised nothing, having checked ${s(p, 'checked')} of ` +
    `${s(p, 'eligible')}${s(p, 'hole')}`,
  'strip.rule.not-reached': (p) => `, ${s(p, 'count')} not reached`,

  // ---- the coverage sentence ----
  'coverage.no-total': (p) =>
    `${s(p, 'visible')} ${plural(n(p, 'visible'), 'table', 'tables')} here ` +
    `could be read. How many exist in total, I do not know — nothing told ` +
    `me, and I am not going to assume the two numbers are the same.`,
  'coverage.all': (p) =>
    `${s(p, 'visible')} of ${s(p, 'total')} ` +
    `${plural(n(p, 'total'), 'table', 'tables')} could be read — all of them.`,
  'coverage.partial': (p) =>
    `${s(p, 'visible')} of ${s(p, 'total')} tables could be read. ` +
    `${s(p, 'unexamined')} more ` +
    `${plural(n(p, 'unexamined'), 'exists', 'exist')} in this database that ` +
    `${plural(n(p, 'unexamined'), 'was', 'were')} not looked at; nothing ` +
    `said here covers ${plural(n(p, 'unexamined'), 'it', 'them')}.`,

  // ---- what the connector could reach ----
  'scope.nothing-asked': (p) =>
    `No schema was asked for, so nothing here was read at all. ` +
    `${s(p, 'tables')} tables exist in this database${s(p, 'readable')}, and ` +
    `none of them were looked at`,
  'scope.granted-when-unknown': () =>
    'I do not know when this access was granted — Postgres does not record it',
  'scope.tables-in': (p) =>
    `${s(p, 'readable')} of ${s(p, 'total')} tables in ${s(p, 'schemas')}`,
  'scope.refused': (p) =>
    `${s(p, 'schemas')} — asked for, and this account has no access to ` +
    `${plural(n(p, 'count'), 'it', 'them')}. Nothing here was read, which is ` +
    `not the same as nothing being there`,
  'scope.missing': (p) =>
    `${s(p, 'schemas')} — asked for, and this database has no schema by that name`,
  'scope.not-looked-at': (p) =>
    `Not looked at at all: ${s(p, 'schemas')}${s(p, 'more')}`,
  'scope.unreadable-tables': (p) =>
    `${s(p, 'count')} tables here exist that this account cannot read — ` +
    `nothing below says anything about them`,
  'scope.unreadable-columns': (p) =>
    `${s(p, 'count')} columns are hidden from this account inside tables it ` +
    `can otherwise read`,
  'scope.outside': (p) =>
    `${s(p, 'count')} more tables exist in this database, outside ` +
    `${s(p, 'schemas')}. Nothing below is about ` +
    `${plural(n(p, 'count'), 'it', 'them')}`,
  'scope.outside-within-reach': (p) =>
    `  of those, ${s(p, 'count')} ${plural(n(p, 'count'), 'is', 'are')} ` +
    `readable by this account — not out of reach, just not in the schemas I ` +
    `was pointed at`,

  // ---- Layer A ----
  'layer-a.fk.plain': (p) =>
    `${s(p, 'rows')} ${plural(n(p, 'count'), 'row', 'rows')} in ` +
    `${s(p, 'table')} point at a ${s(p, 'parent')} record that is not there. ` +
    `That part is certain — I counted it. Whether it matters is not: some ` +
    `systems keep references to records they removed on purpose. If this one ` +
    `does not, then anything following that link — a screen, a report, an ` +
    `export — has nothing to show for those rows.`,
  'layer-a.fk.technical': (p) =>
    `Foreign key ${s(p, 'name')} on ${s(p, 'table')} (${s(p, 'columns')}) → ` +
    `${s(p, 'parent')} is NOT VALID, so Postgres never checked the rows that ` +
    `were already there. ${s(p, 'rows')} of them have no matching parent.`,
  'layer-a.check.plain': (p) =>
    `${s(p, 'rows')} ${plural(n(p, 'count'), 'row', 'rows')} in ` +
    `${s(p, 'table')} do not satisfy a rule the database was told to keep. ` +
    `New rows have to obey it; these were already there when the rule was ` +
    `added, and nobody went back to check them. Whether those rows are wrong ` +
    `or the rule arrived too late is yours to say.`,
  'layer-a.check.technical': (p) =>
    `Constraint ${s(p, 'name')} on ${s(p, 'table')} is NOT VALID. ` +
    `${s(p, 'rows')} existing rows do not satisfy ${s(p, 'definition')}.`,
  'layer-a.index.unique.plain': (p) =>
    `${s(p, 'table')} has a uniqueness rule that is switched off. Duplicates ` +
    `can be created right now and nothing will stop them.`,
  'layer-a.index.plain': (p) =>
    `An index on ${s(p, 'table')} was left half-built. Queries relying on it ` +
    `are reading the slow way.`,
  'layer-a.index.technical': (p) =>
    `Index ${s(p, 'name')} on ${s(p, 'table')} has indisvalid=${s(p, 'valid')}, ` +
    `indisready=${s(p, 'ready')}. This is what a failed CREATE INDEX ` +
    `CONCURRENTLY leaves behind` +
    (n(p, 'unique') === 1
      ? ', and the unique constraint is not being enforced.'
      : '.'),
  'layer-a.constraint.none-eligible': () =>
    'Nothing here was left half-enforced: this database has no constraints ' +
    'that Postgres was told to keep but never checked, so there was nothing ' +
    'for this rule to look at.',
  'layer-a.constraint.none-checked': (p) =>
    `I could not check any of the ${s(p, 'eligible')} ` +
    `${plural(n(p, 'eligible'), 'constraint', 'constraints')} in scope, so I ` +
    `have nothing to report about them. That is not the same as nothing ` +
    `being wrong.`,
  'layer-a.constraint.one-kept': () =>
    'The one constraint I was able to check is being kept — no row in it ' +
    'breaks the rule it was given.',
  'layer-a.constraint.all-kept': (p) =>
    `Every one of the ${s(p, 'checked')} constraints I was able to check is ` +
    `being kept — no row in any of them breaks the rule it was given.`,
  'layer-a.constraint.technical': (p) =>
    `No unvalidated constraint had violating rows, across ${s(p, 'checked')} ` +
    `of ${s(p, 'eligible')} eligible ` +
    `${plural(n(p, 'eligible'), 'constraint', 'constraints')}. Indexes are a ` +
    `separate rule with its own denominator.`,
  'layer-a.index.none-visible': (p) =>
    `This account cannot see any indexes in ${s(p, 'where')}, so there was ` +
    `nothing for this rule to look at.`,
  'layer-a.index.one-on': () =>
    'The one index I can see is switched on. If it was built to stop ' +
    'duplicates, it is stopping them.',
  'layer-a.index.all-on': (p) =>
    `All ${s(p, 'eligible')} indexes I can see are switched on. Nothing that ` +
    `was built to stop duplicates is sitting there not stopping them.`,

  'layer-a.index.technical-negative': (p) =>
    `${s(p, 'eligible')} ${plural(n(p, 'eligible'), 'index', 'indexes')} in ` +
    `${s(p, 'where')} report indisvalid and indisready true. Read from ` +
    `pg_index; no data was queried, so nothing was skipped for budget.`,

  'layer-a.bound.constraints-checked': (p) =>
    `Checked ${s(p, 'checked')} of ${s(p, 'eligible')} ` +
    `${plural(n(p, 'eligible'), 'constraint', 'constraints')} that Postgres ` +
    `had not validated, in ${s(p, 'where')}, across ${s(p, 'tables')} ` +
    `readable ${plural(n(p, 'tables'), 'table', 'tables')}.`,
  'layer-a.bound.by-ceiling': (p) =>
    `${s(p, 'count')} ${plural(n(p, 'count'), 'was', 'were')} not run at all ` +
    `— the scan reached its ceiling on this database.`,
  'layer-a.bound.unreadable': (p) =>
    `${s(p, 'count')} could not be read: the query failed. ` +
    `${plural(n(p, 'count'), 'That one is', 'Those are')} not cleared, ` +
    `${plural(n(p, 'count'), 'it is', 'they are')} unseen — and a table I ` +
    `cannot look inside is the one worth asking about.`,
  'layer-a.bound.already-validated': () =>
    'Constraints Postgres already validated cannot be violated and were not ' +
    're-checked. Nothing here says anything about rules that were never ' +
    'declared — that is a different question, and a harder one. Indexes are ' +
    'counted separately.',
  'layer-a.bound.no-indexes': (p) =>
    `There were no indexes visible to this account in ${s(p, 'where')}, so ` +
    `none were checked.`,
  'layer-a.bound.one-index': (p) =>
    `Checked the one index this account can see in ${s(p, 'where')}.`,
  'layer-a.bound.all-indexes': (p) =>
    `Checked all ${s(p, 'eligible')} indexes this account can see in ` +
    `${s(p, 'where')}.`,
  'layer-a.bound.index-tail': () =>
    ' Indexes on tables it cannot read are not in that number. And an index ' +
    'that is switched on is not necessarily the right index — whether the ' +
    'ones here are the ones you need is a different question, and not one ' +
    'this rule asks.',

  // ---- Layer B ----
  'layer-b.counted': (p) =>
    `${s(p, 'residual')} of the ${s(p, 'present')} rows in ${s(p, 'table')} ` +
    `${s(p, 'carry')} a ${s(p, 'column')} that no ${s(p, 'parent')} record ` +
    `matches. `,
  'layer-b.sampled': (p) =>
    `I looked at ${s(p, 'present')} rows drawn from across ${s(p, 'table')} ` +
    `— not the whole table — and ${s(p, 'residual')} of them ${s(p, 'carry')} ` +
    `a ${s(p, 'column')} that no ${s(p, 'parent')} record matches, which is ` +
    `${s(p, 'pct')}% of what I looked at. I did not count the rest of the ` +
    `table, so I cannot tell you how many there are in total. `,
  'layer-b.set-aside': (p) =>
    `First, set aside: a further ${s(p, 'count')} rows all carry one and the ` +
    `same value. One value repeating that many times reads like something ` +
    `this schema uses to mean "none" or "all", so I did not count those as ` +
    `unmatched. `,
  'layer-b.tail-one': (p) =>
    `The other ${s(p, 'rate')}% match, so the column does look like it points ` +
    `at ${s(p, 'parent')}. Nothing in the database enforces that, so I cannot ` +
    `tell whether that one row is a leftover you would want to know about, or ` +
    `a row kept deliberately.`,
  'layer-b.tail-many': (p) =>
    `The other ${s(p, 'rate')}% match, so the column does look like it points ` +
    `at ${s(p, 'parent')}. Nothing in the database enforces that, so I cannot ` +
    `tell whether those ${s(p, 'residual')} are leftovers you would want to ` +
    `know about, or rows kept deliberately.`,
  'layer-b.technical': (p) =>
    `${s(p, 'column')} (${s(p, 'distinct')} distinct values over ` +
    `${s(p, 'present')} non-null rows ${s(p, 'how')}) matches ` +
    `${s(p, 'parentColumn')} at ${s(p, 'rate')}%, with ${s(p, 'residual')} ` +
    `unmatched (${s(p, 'pct')}%)${s(p, 'aside')}. No foreign key is declared ` +
    `between them.`,
  'layer-b.how.counted': () => '— every one of them, counted',
  'layer-b.how.sampled': (p) =>
    `sampled with TABLESAMPLE SYSTEM (${s(p, 'pct')}%) REPEATABLE ` +
    `(${s(p, 'seed')}) from an estimated ${s(p, 'estimated')}`,
  'layer-b.aside.budget-ceiling': () =>
    'the scan reached its ceiling on this database',
  // The driver's own words are kept verbatim inside a sentence that is ours.
  // Passing the raw message straight through made this key render identically
  // in both languages, which the catalogue test correctly refuses: a message
  // that is the same in every language is not a message, it is a parameter.
  'layer-b.aside.query-failed': (p) => `the query failed: ${s(p, 'detail')}`,
  'layer-b.aside.empty-draw': (p) =>
    `the catalog estimates ${s(p, 'estimated')} rows, so ${s(p, 'pct')}% of ` +
    `the table was drawn — and that came back with nothing in it. Either the ` +
    `estimate is far too high or the sample was unlucky; nothing here can ` +
    `tell you which, so nothing was learned about this column`,
  'layer-b.aside.one-repeated-value': (p) =>
    `all ${s(p, 'orphans')} values that match no ${s(p, 'parent')} record are ` +
    `the same single value, repeated. One value that many times reads as ` +
    `something this schema uses to mean "none" or "all", not as that many ` +
    `links that lead nowhere — so this is not being raised as a question`,
  'layer-b.aside.match-rate-too-low': (p) =>
    `only ${s(p, 'rate')}% of values line up with ${s(p, 'parent')} — the ` +
    `name matching is probably a coincidence, not a reference`,
  'layer-b.question': (p) =>
    `In ${s(p, 'table')}, is ${s(p, 'column')} meant to always point at a ` +
    `record that still exists?\n` +
    `  • Yes — then the rows I found are leftovers, and worth cleaning up.\n` +
    `  • No, that is on purpose — then this is not a problem and I will stop ` +
    `raising it.\n` +
    `  • I don't know — then it is worth asking whoever built this.`,
};
