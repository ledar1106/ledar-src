/**
 * One conversation. Screens are states of it, not pages of a router.
 *
 * That sentence is the architecture decision this file exists to embody
 * (_doc/21 §2, AGENTS §4.20 — the compressed brief that lost it produced a
 * twelve-screen wizard). The states, in the order a person meets them: the
 * welcome, S2 "Connect safely", S4 the scan, S5 the report, and then the one
 * question a scan cannot answer. Each state appends turns; nothing is
 * replaced, because a conversation is a record — what the assistant said
 * before the proof stays said, and the proof arrives as a new turn under it.
 *
 * Rendering rules with reasons:
 *  - Everything is built with createElement/textContent. No markup is ever
 *    assembled from data — backend sentences, Postgres errors and SQL all
 *    pass through as inert text (the demo's audit gate caught exactly this
 *    shortcut once already).
 *  - Fixed strings go through t(). Sentences produced by the backend —
 *    scope lines, disclosures, refusal reasons, database errors — render
 *    verbatim: they are evidence, and evidence is quoted, not rephrased.
 *  - The DSN exists in the input and in the connect call. The conversation
 *    shows host/port/database only (dsn.ts), and the input is cleared once
 *    the database has answered with proof.
 */

import type {
  ConnectOutcome,
  ReportFinding,
  ReportVerdict,
  ScanOutcome,
  SessionFacts,
  SessionHandle,
  WriteProbeFacts,
} from '../shared/ipc.js';
import { dsnDisplayTarget } from './dsn.js';
import { t } from './i18n.js';
import {
  INTERVIEW_QUESTIONS,
  answerDontKnow,
  answerTyped,
  currentQuestion,
  isFinished,
  ruleSentence,
  startInterview,
} from './interview.js';
import type { AnswerResult, Interview } from './interview.js';
import { shapeFor } from './verdict-shape.js';
import type { VerdictShape } from './verdict-shape.js';

type IconName = 'check' | 'dash' | 'shield' | 'arrow' | 'alert';
type StatusState = 'none' | 'enforced' | 'writable' | 'refused';

// ---- tiny DOM vocabulary ---------------------------------------------------

function byId<T extends HTMLElement>(id: string, kind: new () => T): T {
  const node = document.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`missing #${id}`);
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: IconName, className?: string): Element {
  const tpl = document.getElementById(`icon-${name}`);
  if (!(tpl instanceof HTMLTemplateElement)) throw new Error(`missing icon ${name}`);
  const svg = tpl.content.firstElementChild;
  if (svg === null) throw new Error(`empty icon ${name}`);
  const copy = svg.cloneNode(true) as Element;
  if (className !== undefined) copy.setAttribute('class', className);
  return copy;
}

const chat = byId('chat', HTMLDivElement);
const announcer = byId('announcer', HTMLDivElement);

function announce(message: string): void {
  announcer.textContent = '';
  announcer.textContent = message;
}

function addTurn(who: 'assistant' | 'user'): HTMLDivElement {
  const turn = el('div', `turn ${who}`);
  const bubble = el('div', 'bubble');
  turn.append(bubble);
  chat.append(turn);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}

function copyButton(text: string): HTMLButtonElement {
  const button = el('button', 'button small', t('copy'));
  button.type = 'button';
  button.addEventListener('click', () => {
    void window.ledar.copyText(text).then((ok) => {
      button.textContent = ok ? t('copied') : t('copy.failed');
      if (ok) announce(t('announce.copied'));
      setTimeout(() => {
        button.textContent = t('copy');
      }, 1600);
    });
  });
  return button;
}

function codeBlock(text: string): HTMLPreElement {
  const pre = el('pre', 'code-block');
  const code = el('code');
  code.textContent = text;
  pre.append(copyButton(text), code);
  return pre;
}

function expansion(): HTMLSpanElement {
  const wrap = el('span', 'expansion');
  const words = [
    t('brand.word.look'),
    t('brand.word.explain'),
    t('brand.word.disclose'),
    t('brand.word.admit'),
    t('brand.word.retain'),
  ];
  for (const word of words) {
    const item = el('span');
    item.append(el('b', undefined, word.slice(0, 1)), document.createTextNode(word.slice(1)));
    wrap.append(item);
  }
  return wrap;
}

// ---- sidebar status --------------------------------------------------------

const STATUS_TEXT: Record<StatusState, () => string> = {
  none: () => t('status.none'),
  enforced: () => t('status.enforced'),
  writable: () => t('status.writable'),
  refused: () => t('status.refused'),
};

function setStatus(state: StatusState): void {
  const box = byId('side-status', HTMLDivElement);
  box.dataset['state'] = state;
  box.replaceChildren(el('span', 'status-dot'), el('span', undefined, STATUS_TEXT[state]()));
}

// ---- S2 pieces -------------------------------------------------------------

function probeNotes(probe: WriteProbeFacts): HTMLElement[] {
  if (probe.blocked) {
    const note = el('p', 'meta', t('probe.blocked'));
    const detail = el('p', 'mono meta probe-detail');
    detail.textContent = probe.error;
    return [note, detail];
  }
  return [el('p', 'meta probe-bad', t('probe.not-blocked'))];
}

function sessionFacts(session: SessionFacts): HTMLElement[] {
  const heading = el('p', 'kicker', t('facts.heading'));
  const connectedAs = el(
    'p',
    'meta',
    t('facts.connected-as', { database: session.database, user: session.currentUser }),
  );

  const list = el('ul', 'fact-list');
  const facts: Array<[boolean, string]> = [
    [!session.isSuperuser, t('facts.not-superuser')],
    [!session.bypassesRls, t('facts.no-bypass-rls')],
    [!session.canCreateInDatabase, t('facts.no-create')],
    [session.transactionReadOnly, t('facts.txn-read-only')],
  ];
  for (const [holds, label] of facts) {
    const item = el('li', holds ? undefined : 'fact-off');
    item.append(icon(holds ? 'check' : 'dash', 'fact-icon'), el('span', undefined, label));
    list.append(item);
  }

  const timeouts = el(
    'p',
    'meta',
    t('facts.timeouts', {
      statement: session.statementTimeout,
      idle: session.idleInTransactionTimeout,
      lock: session.lockTimeout,
    }),
  );
  return [heading, connectedAs, list, timeouts];
}

function scopeCard(lines: string[]): HTMLElement {
  const card = el('div', 'card');
  card.append(el('p', 'kicker', t('scope.heading')));
  const list = el('ul', 'scope-lines');
  for (const line of lines) list.append(el('li', undefined, line));
  card.append(list);
  return card;
}

function revokeDetails(revokeSql: string): HTMLDetailsElement {
  const details = el('details');
  details.append(el('summary', undefined, t('revoke.summary')), codeBlock(revokeSql));
  return details;
}

function tryAgainButton(): HTMLButtonElement {
  const button = el('button', 'button', t('try-again'));
  button.type = 'button';
  button.addEventListener('click', () => {
    if (guideRefs !== null) {
      guideRefs.input.scrollIntoView({ block: 'center' });
      guideRefs.input.focus();
    }
  });
  return button;
}

function helpChecklist(): HTMLElement[] {
  const list = el('ul', 'steps');
  list.append(
    el('li', undefined, t('help.1')),
    el('li', undefined, t('help.2')),
    el('li', undefined, t('help.3')),
  );
  return [el('p', undefined, t('help.lead')), list];
}

// ---- S4: the scan ----------------------------------------------------------

/**
 * 🟥 The order is proof → scan → report → the one question. Defence:
 *
 * ```text
 * ideal §12 audit 🔴  "you are asking people the very thing that, by your own
 *                     definition of who this is for, they do not know.
 *                     REVERSE THE ORDER: scan first, show what was found, and
 *                     let them confirm."
 * BUILD-PROGRESS      the five questions cut from the interview were cut
 *   §FE-2a            because they "belong after S4, phrased as confirmation"
 * HANDOFF-STATUS      next slice named as "S4 desktop/scan-first"
 * ```
 *
 * The sharper reason is local to this build. `_doc/25` S5 ③ says the section
 * holding a person's own rule must not exist when there is no rule — no empty
 * heading. Nothing here turns a sentence into a check yet, so that section
 * cannot exist, so asking for the rule BEFORE the report would take somebody's
 * sentence and hand back a report with no place in it for what they said. The
 * question is honest after the report and a small betrayal before it.
 *
 * It also makes the question's own opening line true rather than promised:
 * *"I can see its shape — what tables exist, what points at what"* reads as a
 * claim before a scan and as a description of the thing just read after one.
 *
 * The scan is offered, never automatic, and offered in a turn of its own: the
 * proof has to be readable before the thing it authorises is offered, and a
 * CTA sitting inside the evidence card invites clicking past the evidence.
 */
let session: SessionHandle | null = null;
let scanning = false;

/**
 * The scan CTA of the turn that offered it.
 *
 * Disabled the moment it is used, for the reason `pendingDontKnow` below is:
 * every turn stays on screen forever, so a live button on an answered turn is
 * a second scan waiting to be started by a stray click.
 */
let scanCta: HTMLButtonElement | null = null;

function offerScan(handle: SessionHandle): void {
  session = handle;

  const bubble = addTurn('assistant');
  bubble.append(el('p', undefined, t('scan.offer.lead')));
  bubble.append(el('p', undefined, t('scan.offer.body')));

  const cta = el('button', 'button primary', t('scan.cta'));
  cta.type = 'button';
  cta.append(icon('arrow', 'icon'));
  cta.addEventListener('click', () => void runScan());
  const actions = el('div', 'actions');
  actions.append(cta);
  bubble.append(actions);

  scanCta = cta;
  chat.scrollTop = chat.scrollHeight;
}

async function runScan(): Promise<void> {
  if (session === null || scanning) return;
  scanning = true;
  if (scanCta !== null) {
    scanCta.disabled = true;
    scanCta = null;
  }

  addTurn('user').append(el('p', undefined, t('scan.said')));

  // S4. `_doc/25` asks for the cost counting up as it goes; there is no
  // progress channel in the contract, so this state says what it is doing and
  // says that the count comes with the report. Inventing step names or a
  // fake meter would be the failure §4.1b is about — a sentence on screen
  // that no measurement produced.
  const working = el('div', 'card scanning');
  working.setAttribute('aria-busy', 'true');
  const line = el('p', 'working');
  line.append(el('span', 'working-dot'), el('span', undefined, t('scan.working')));
  working.append(line, el('p', 'meta', t('scan.working.meta')));
  addTurn('assistant').append(working);
  announce(t('announce.scanning'));
  chat.scrollTop = chat.scrollHeight;

  let outcome: ScanOutcome | null = null;
  let bridgeError: unknown = null;
  try {
    outcome = await window.ledar.scan(session);
  } catch (err) {
    // The contract's three outcomes are all answers about the DATABASE. A
    // throw here is the bridge itself failing, and it needs a fourth state
    // for the same reason `_doc/25` S4 gives: a scan that never ran must not
    // sit spinning as though it still might. Broken is not empty and it is
    // not busy either.
    bridgeError = err;
  }

  working.setAttribute('aria-busy', 'false');
  working.classList.remove('scanning');

  if (outcome === null) renderBridgeFailure(bridgeError);
  else renderScan(outcome);

  scanning = false;

  // Reported on the failing paths too. An unattended run that prints nothing
  // is a run whose result is "the harness timed out", and that is the same
  // silence a hang produces — §4.16, an assertion that cannot come back red
  // is worth less than no assertion.
  if (devMode) reportScanToSmoke(outcome);
}

function renderBridgeFailure(err: unknown): void {
  const bubble = addTurn('assistant');
  const card = el('div', 'card attention');
  card.append(el('h3', undefined, t('scan.bridge.headline')));
  card.append(el('p', undefined, t('scan.bridge.body')));
  const detail = el('p', 'mono meta probe-detail');
  detail.textContent = err instanceof Error ? err.message : String(err);
  card.append(detail);
  bubble.append(card);

  const actions = el('div', 'actions');
  actions.append(scanAgainButton());
  bubble.append(actions);
  chat.scrollTop = chat.scrollHeight;
}

function renderScan(outcome: ScanOutcome): void {
  const bubble = addTurn('assistant');

  switch (outcome.kind) {
    case 'scanned':
      renderReport(bubble, outcome);
      break;

    case 'scan_error': {
      // Deliberately louder than `connect_error`, which is `pending`. A
      // connection that never opened cannot be mistaken for a result; a scan
      // that stopped halfway can, and `_doc/25` S4 is explicit that BROKEN
      // must never look like EMPTY.
      const card = el('div', 'card attention');
      const head = el('div', 'proof');
      const badge = el('span', 'proof-icon');
      badge.append(icon('alert'));
      const words = el('div');
      words.append(
        el('h3', undefined, t('scan.error.headline')),
        el('p', undefined, t('scan.error.body')),
      );
      head.append(badge, words);
      card.append(head);

      const detail = el('p', 'mono meta probe-detail');
      detail.textContent = outcome.message;
      card.append(detail);
      card.append(...historyNotes(outcome.historyLines));
      bubble.append(card);

      const actions = el('div', 'actions');
      actions.append(scanAgainButton());
      bubble.append(actions);
      chat.scrollTop = chat.scrollHeight;
      break;
    }

    case 'no_session': {
      // Main says the handle is gone, so the window stops holding one. A
      // renderer keeping a credential the other side has already dropped is
      // the small version of the thing `shared/ipc.ts` refuses to do.
      session = null;

      const card = el('div', 'card pending');
      card.append(el('h3', undefined, t('scan.no-session.headline')));
      const detail = el('p', 'meta');
      detail.textContent = outcome.message;
      card.append(detail);
      card.append(el('p', undefined, t('scan.no-session.body')));
      bubble.append(card);

      // Not "scan again" — there is nothing to scan with. The way back is the
      // connection form, and the proof runs again before anything else does.
      const actions = el('div', 'actions');
      actions.append(tryAgainButton());
      bubble.append(actions);
      chat.scrollTop = chat.scrollHeight;
      break;
    }
  }
}

function scanAgainButton(): HTMLButtonElement {
  const button = el('button', 'button', t('scan.again'));
  button.type = 'button';
  button.addEventListener('click', () => {
    button.disabled = true;
    void runScan();
  });
  return button;
}

/** History and cost, exactly as the backend wrote them. Always both said. */
function historyNotes(lines: string[]): HTMLElement[] {
  const notes: HTMLElement[] = [];
  for (const line of lines) {
    const p = el('p', 'meta');
    p.textContent = line;
    notes.push(p);
  }
  return notes;
}

// ---- S5: the report --------------------------------------------------------

/**
 * The sections come in one fixed order and are never merged (`_doc/25` S5).
 * Each heading names its own provenance before a reader reaches a number,
 * which is 3.3 ②: what a claim looks like is decided by where it came from,
 * not by how alarming it is.
 *
 * ⚠️ The sections are NOT numbered on screen, and the demo's numbered circles
 * are dropped on purpose. Section ③ must not exist while nothing produces a
 * user rule — and a heading list running 1, 2, 4, 5 makes that absence
 * visible, which is precisely what "the section does not exist" is supposed
 * to prevent. The headings carry their own meaning without an index.
 */
function renderReport(bubble: HTMLElement, outcome: Extract<ScanOutcome, { kind: 'scanned' }>): void {
  const shape = shapeFor(outcome.verdict.kind);
  bubble.append(el('p', undefined, t('report.intro')));

  const report = el('div', 'report');

  // `_doc/25` S5 D: the empty database is warned about at the TOP as well as
  // concluded at the bottom. `verdict.ts` says which half goes where — the
  // numbers may be printed in both places, the interpretation in only one, so
  // the banner carries headline and gaps and `meaning` waits for the end.
  if (shape.bannerAtTop) report.append(verdictBanner(outcome.verdict, shape));

  // ① The scope strip, top. Never hidden, never dimmed — 3.3 ④ calls it the
  // D in the product's name rather than a footnote.
  const scope = el('div', 'section-body');
  scope.append(scopeStrip(outcome.scopeStrip));
  const lines = el('ul', 'scope-lines');
  for (const line of outcome.scopeLines) {
    const item = el('li');
    item.textContent = line;
    lines.append(item);
  }
  if (outcome.scopeLines.length > 0) scope.append(lines);
  report.append(reportSection(t('report.looked-at'), scope));

  // ② What the database itself confirms.
  const confirms = outcome.findings.filter((finding) => finding.section === 'confirms');
  if (confirms.length > 0) {
    const body = el('div', 'section-body');
    for (const finding of confirms) body.append(findingCard(finding));
    report.append(reportSection(t('report.confirms'), body));
  }

  // ③ WHAT YOU ASKED ME TO CHECK — absent, and absent rather than empty.
  // Nothing in this build turns a typed sentence into a check, so there are
  // no user rules to report on, and `_doc/25` S5 ③ says a section with
  // nothing in it does not get a heading. When the read-back ships, this is
  // where it goes: between ② and ④, never merged into either.

  // ④ Patterns. Questions, never errors — hard rule ③ forbids the word
  // "error" for anything unconfirmed, and 3.3 ② says the visual has to obey
  // the same rule the copy does.
  const patterns = outcome.findings.filter((finding) => finding.section === 'patterns');
  if (patterns.length > 0) {
    const body = el('div', 'section-body');
    body.append(el('p', undefined, t('report.patterns.preamble')));
    for (const finding of patterns) body.append(findingCard(finding));
    report.append(reportSection(t('report.patterns'), body));
  }

  // ⑤ The verdict.
  const verdictBody = el('div', 'section-body');
  verdictBody.append(verdictCard(outcome.verdict, shape));
  report.append(reportSection(t('report.verdict'), verdictBody));

  const notes = el('div', 'run-notes');
  notes.append(...historyNotes(outcome.historyLines));
  const cost = el('p', 'meta');
  cost.textContent = outcome.costLine;
  notes.append(cost);
  report.append(notes);

  report.append(revokeDetails(outcome.revokeSql));

  // The strip again, below everything it limits.
  report.append(scopeStrip(outcome.scopeStrip));

  bubble.append(report);
  announce(t('announce.report'));

  // Now, and only now, the one thing reading the database cannot produce.
  // Once: a second report is a second reading of the same database, not a
  // reason to ask somebody the same question again and throw away the answer
  // they already gave.
  if (interview === null) beginInterview();

  // Every other turn lands the view at the foot of the conversation, which
  // for this one would open the report at its conclusion with the boundary
  // scrolled off the top. The report is read from the top or it is not read:
  // the strip is what every sentence under it is limited by, and the question
  // that follows can wait below until the reading is done.
  bubble.scrollIntoView({ block: 'start' });
}

function reportSection(heading: string, body: HTMLElement): HTMLElement {
  const section = el('section', 'report-section');
  section.append(el('h3', 'report-heading', heading), body);
  return section;
}

function scopeStrip(strip: string): HTMLElement {
  const node = el('div', 'scope-strip');
  const text = el('span');
  text.textContent = strip;
  node.append(el('strong', undefined, t('report.scope.label')), text);
  return node;
}

/**
 * One finding.
 *
 * ⚠️ Section ② findings get no attention rail, and that is a limit of the
 * contract rather than a choice. `ReportFinding` says which SECTION a finding
 * belongs to and nothing about whether it was RAISED — a negative ("the one
 * constraint I could check is being kept") and a real finding arrive in the
 * same shape. Painting every confirmed line as attention would put an amber
 * rail beside a sentence saying nothing was wrong, which is a louder lie than
 * a plain card beside one saying something was. The count of what was raised
 * is the verdict's job, and the verdict has the number.
 *
 * `boundary` is non-null on exactly the negatives and abstentions today, so it
 * would ALMOST serve as that flag. It is not used as one. The field is a
 * sentence about limits, not a claim kind, and `_doc/25` S6 asks for one on
 * every finding — the day that arrives, a rail keyed to it would invert
 * silently. That is the FE-2a mistake with a different subject: deriving a
 * category from something that merely correlates with it.
 *
 * Section ④ is different: every finding in it is unconfirmed by definition of
 * the section, so the question shape is backed by the data itself.
 */
function findingCard(finding: ReportFinding): HTMLElement {
  const card = el('article', finding.section === 'patterns' ? 'card question' : 'card');

  const copy = el('p', 'finding-copy');
  copy.textContent = finding.plainText;
  card.append(copy);

  if (finding.boundary !== null && finding.boundary !== '') {
    // "but only this far" — S6 says this belongs to the body of the card and
    // is never cut. Printed as the backend wrote it, prefix included: the
    // wording of that clause is the backend's to choose, and a second prefix
    // added here would read as the product stammering.
    const bound = el('p', 'boundary');
    bound.textContent = finding.boundary;
    card.append(bound);
  }

  if (finding.technical.trim() !== '') {
    const details = el('details');
    const block = codeBlock(finding.technical);
    block.classList.add('wrap');
    details.append(el('summary', undefined, t('report.technical')), block);
    card.append(details);
  }

  return card;
}

function verdictBanner(verdict: ReportVerdict, shape: VerdictShape): HTMLElement {
  const banner = el('div', `verdict-banner ${shape.tone}`);
  banner.append(icon(shape.icon, 'verdict-icon'));

  const words = el('div');
  const headline = el('p', 'verdict-headline');
  headline.textContent = verdict.headline;
  words.append(headline);
  for (const gap of verdict.gaps) {
    // Full-strength text, not `meta`. These are the numbers behind the
    // loudest thing the report says; a grey aside under a warning is how the
    // warning gets read as a formality.
    const p = el('p', 'banner-gap');
    p.textContent = gap;
    words.append(p);
  }
  banner.append(words);
  return banner;
}

function verdictCard(verdict: ReportVerdict, shape: VerdictShape): HTMLElement {
  const card = el('div', `verdict ${shape.tone}`);

  const head = el('div', 'proof');
  const badge = el('span', 'verdict-badge');
  badge.append(icon(shape.icon, 'verdict-icon'));
  const words = el('div');
  const headline = el('h3');
  headline.textContent = verdict.headline;
  words.append(headline);
  head.append(badge, words);
  card.append(head);

  if (verdict.gaps.length > 0) {
    const list = el('ul', 'verdict-gaps');
    for (const gap of verdict.gaps) {
      const item = el('li');
      item.textContent = gap;
      list.append(item);
    }
    card.append(list);
  }

  for (const line of verdict.meaning) {
    const p = el('p', 'verdict-meaning');
    p.textContent = line;
    card.append(p);
  }

  return card;
}

// ---- S3: the one question a scan cannot answer -----------------------------

/**
 * The interview is a conversation state like every other one here: the
 * assistant asks in a turn, the person answers in the composer, and the
 * answer becomes their turn. There is no question screen and no step counter
 * chrome — with one question there is no count worth showing, and the block
 * above says why it now comes after the report rather than before the scan.
 */
let interview: Interview | null = null;

/**
 * The "I don't know" button of the question currently being asked.
 *
 * Every turn stays on screen forever, because a conversation is a record and
 * S2's proof turn has to still be there after the interview scrolls past it.
 * That means the buttons of ANSWERED questions are still on screen too, and a
 * live one would land its answer against whatever question is current now.
 * So the button is disabled the moment its question is answered.
 */
let pendingDontKnow: HTMLButtonElement | null = null;

function composerInput(): HTMLInputElement {
  return byId('composer-input', HTMLInputElement);
}

function composerSend(): HTMLButtonElement {
  return byId('composer-send', HTMLButtonElement);
}

function beginInterview(): void {
  interview = startInterview();
  addTurn('assistant').append(el('p', undefined, t('interview.intro')));
  askQuestion();

  composerInput().disabled = false;
  composerSend().disabled = false;
  composerInput().focus();
}

function askQuestion(): void {
  if (interview === null) return;
  const question = currentQuestion(interview);
  if (question === null) return;

  const n = interview.index + 1;
  const total = interview.questions.length;

  const bubble = addTurn('assistant');
  const card = el('div', 'card');
  // A counter over a single question is chrome pretending to be progress.
  if (total > 1) card.append(el('p', 'kicker', t('interview.progress', { n, total })));
  card.append(el('h3', undefined, t(`interview.${question.id}.text`)));
  card.append(el('p', 'meta', t(`interview.${question.id}.hint`)));

  if (question.isRule) {
    card.append(el('p', 'kicker', t('interview.rule.examples')));
    const examples = el('ul', 'steps');
    examples.append(
      el('li', undefined, t('interview.rule.example.1')),
      el('li', undefined, t('interview.rule.example.2')),
      el('li', undefined, t('interview.rule.example.3')),
    );
    card.append(examples);
  }

  // Peer-level with the answer box, not a faded link (_doc/25 S3), and
  // worded as an instruction rather than an admission (ideal §13 audit):
  // skipping is a normal state, not a confession to be typed out.
  const dontKnow = el('button', 'button', t('interview.dont-know'));
  dontKnow.type = 'button';
  dontKnow.addEventListener('click', () => {
    if (interview === null) return;
    applyAnswer(answerDontKnow(interview), t('interview.dont-know.said'));
  });
  const actions = el('div', 'actions');
  actions.append(dontKnow);
  card.append(actions);

  bubble.append(card);
  pendingDontKnow = dontKnow;

  composerInput().placeholder = t('interview.answer.placeholder');
  chat.scrollTop = chat.scrollHeight;
}

function applyAnswer(result: AnswerResult, echo: string): void {
  if (!result.ok) {
    if (result.reason === 'too-long') {
      addTurn('assistant').append(el('p', undefined, t('interview.too-long')));
      chat.scrollTop = chat.scrollHeight;
    }
    return;
  }

  if (pendingDontKnow !== null) {
    pendingDontKnow.disabled = true;
    pendingDontKnow = null;
  }

  // The person's own words, as text. Nothing here parses them, and nothing
  // here sends them anywhere.
  addTurn('user').append(el('p', undefined, echo));

  interview = result.interview;
  if (isFinished(interview)) finishInterview();
  else askQuestion();
}

function submitAnswer(): void {
  if (interview === null) return;
  const input = composerInput();
  const raw = input.value;
  const result = answerTyped(interview, raw);
  if (result.ok) input.value = '';
  else input.focus();
  applyAnswer(result, raw.trim());
}

function finishInterview(): void {
  if (interview === null) return;

  const bubble = addTurn('assistant');
  bubble.append(el('p', 'lead', t('interview.done.heading')));
  bubble.append(el('p', undefined, t('interview.done.kept')));

  const card = el('div', 'card');
  const rule = ruleSentence(interview);
  if (rule === null) {
    // No sentence, so no rule — and the product does not assemble one out of
    // the five other answers to avoid an awkward silence. That invention is
    // the exact failure VS-6 exists to not have.
    card.append(el('p', undefined, t('interview.done.no-rule')));
  } else {
    card.append(el('p', 'kicker', t('interview.done.rule.heading')));
    // Quoted as EVIDENCE — their words, unchanged. This is NOT the read-back:
    // nothing has read this sentence, mapped it to a table, or checked
    // anything, and the line under it says so rather than letting a quote in
    // a card imply otherwise (_doc/26 is where that screen gets designed).
    const quote = el('p', 'mono');
    quote.textContent = rule;
    card.append(quote);
    card.append(el('p', undefined, t('interview.done.rule.next')));
    card.append(el('p', undefined, t('interview.done.rule.then')));
  }
  bubble.append(card);

  const input = composerInput();
  input.value = '';
  input.disabled = true;
  input.placeholder = t('composer.done');
  composerSend().disabled = true;
  chat.scrollTop = chat.scrollHeight;
}

// ---- conversation states ---------------------------------------------------

let guideRefs: { input: HTMLInputElement; connect: HTMLButtonElement } | null = null;
let guideStarted = false;
let connecting = false;
let devMode = false;

/** Smoke run only: nobody is there to press the scan button. */
let devAutoScan = false;

/** The connect half of a smoke line whose scan half has not happened yet. */
let pendingSmokeHead: string | null = null;

function welcome(): void {
  const bubble = addTurn('assistant');
  bubble.append(el('p', 'lead', t('welcome.lead')));

  const brand = el('div', 'card');
  brand.append(el('span', 'wordmark', t('brand.name')), expansion());
  bubble.append(brand);

  const cta = el('button', 'button primary', t('welcome.cta'));
  cta.type = 'button';
  cta.append(icon('arrow', 'icon'));
  cta.addEventListener('click', () => {
    cta.disabled = true;
    void startGuide();
  });
  const actions = el('div', 'actions');
  actions.append(cta);
  bubble.append(actions);
}

async function startGuide(): Promise<void> {
  if (guideStarted) return;
  guideStarted = true;

  const guide = await window.ledar.guide();
  const bubble = addTurn('assistant');
  bubble.append(el('p', undefined, t('guide.intro')));

  const card = el('div', 'card');

  const head = el('div', 'card-head');
  const heading = el('div');
  heading.append(el('p', 'kicker', t('guide.kicker')), el('h3', undefined, t('guide.title')));
  const tag = el('span', 'tag');
  tag.append(icon('shield'), document.createTextNode(t('guide.tag.local')));
  head.append(heading, tag);
  card.append(head);

  const steps = el('ol', 'steps');
  steps.append(
    el('li', undefined, t('guide.step.1')),
    el('li', undefined, t('guide.step.2')),
    el('li', undefined, t('guide.step.3')),
  );
  card.append(steps);

  card.append(codeBlock(guide.roleSql));
  card.append(revokeDetails(guide.revokeSql));
  card.append(el('p', 'meta', t('guide.admit.before')));

  const field = el('div', 'field');
  const label = el('label', undefined, t('guide.dsn.label'));
  label.htmlFor = 'dsn-input';
  const row = el('div', 'field-row');
  const input = el('input');
  input.id = 'dsn-input';
  input.type = 'password';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const reveal = el('button', 'button small', t('guide.dsn.show'));
  reveal.type = 'button';
  reveal.setAttribute('aria-pressed', 'false');
  reveal.addEventListener('click', () => {
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    reveal.textContent = showing ? t('guide.dsn.show') : t('guide.dsn.hide');
    reveal.setAttribute('aria-pressed', showing ? 'false' : 'true');
  });
  row.append(input, reveal);
  field.append(label, row, el('p', 'field-hint', t('guide.dsn.hint')));
  card.append(field);

  const actions = el('div', 'actions');
  const connect = el('button', 'button primary', t('guide.connect'));
  connect.type = 'button';
  connect.addEventListener('click', () => void submitDsn());
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitDsn();
    }
  });

  const help = el('button', 'button', t('guide.error-help'));
  help.type = 'button';
  help.addEventListener('click', () => {
    const helpBubble = addTurn('assistant');
    helpBubble.append(...helpChecklist());
  });

  const askDev = el('button', 'button', t('guide.ask-dev'));
  askDev.type = 'button';
  askDev.addEventListener('click', () => {
    void window.ledar.copyText(t('guide.dev-note')).then((ok) => {
      askDev.textContent = ok ? t('copied') : t('copy.failed');
      if (ok) announce(t('announce.dev-note'));
      setTimeout(() => {
        askDev.textContent = t('guide.ask-dev');
      }, 1600);
    });
  });

  actions.append(connect, help, askDev);
  card.append(actions);
  bubble.append(card);
  chat.scrollTop = chat.scrollHeight;

  guideRefs = { input, connect };
}

async function submitDsn(): Promise<void> {
  if (guideRefs === null || connecting) return;
  const { input, connect } = guideRefs;
  const dsn = input.value.trim();
  if (dsn === '') {
    input.focus();
    return;
  }

  connecting = true;
  connect.disabled = true;
  connect.classList.add('is-loading');

  const target = dsnDisplayTarget(dsn);
  addTurn('user').append(
    el('p', undefined, target === null ? t('user.sent.generic') : t('user.sent', { target })),
  );
  addTurn('assistant').append(el('p', 'meta', t('checking')));

  const outcome = await window.ledar.connect(dsn);
  renderOutcome(outcome);

  connecting = false;
  connect.disabled = false;
  connect.classList.remove('is-loading');

  if (outcome.kind === 'read_only_enforced') {
    // The proof arrived; the credential has no further reason to sit in a
    // form field.
    input.value = '';
  }

  if (devMode) {
    // Ids and counts only. The interview holds sentences somebody typed about
    // their business and the report holds sentences about their data; neither
    // belongs on stdout.
    const head =
      outcome.kind === 'read_only_enforced'
        ? `verdict=${outcome.kind} probe_blocked=${outcome.probe.blocked} headline=${t('proof.enforced.headline')}`
        : `verdict=${outcome.kind}`;

    if (outcome.kind === 'read_only_enforced' && devAutoScan) {
      // Held, not dropped. main.ts quits 200ms after the FIRST line when
      // LEDAR_DEV_EXIT is set, so a line printed here would end the run at
      // the connection and leave the scan — the whole point of this slice —
      // with no evidence on the real path at all. One line, printed at the
      // far end, carrying both halves.
      pendingSmokeHead = head;
      void runScan();
    } else {
      window.ledar.devReport(`${head} next=${outcome.kind === 'read_only_enforced' ? 'scan' : 'stop'}`);
    }
  }
}

/**
 * The smoke line for a scan that ran on the real path.
 *
 * Counts and kinds. Not the scope strip, not the verdict headline, not a
 * finding: those are sentences about somebody's data, and the reason the
 * connect line may print `proof.enforced.headline` is that the headline is a
 * fixed string from the catalogue rather than anything the database said.
 */
function reportScanToSmoke(outcome: ScanOutcome | null): void {
  const parts: string[] = [outcome === null ? 'scan=bridge_error' : `scan=${outcome.kind}`];

  if (outcome !== null && outcome.kind === 'scanned') {
    const confirms = outcome.findings.filter((f) => f.section === 'confirms').length;
    const patterns = outcome.findings.filter((f) => f.section === 'patterns').length;
    const shape = shapeFor(outcome.verdict.kind);
    parts.push(
      `report_verdict=${outcome.verdict.kind}`,
      `tone=${shape.tone}`,
      `banner=${shape.bannerAtTop}`,
      `confirms=${confirms}`,
      `patterns=${patterns}`,
      `strip=${outcome.scopeStrip.trim() === '' ? 'MISSING' : 'yes'}`,
      `cost=${outcome.costLine.trim() === '' ? 'MISSING' : 'yes'}`,
      `history_lines=${outcome.historyLines.length}`,
    );
  }

  const asked = interview === null ? 'none' : (currentQuestion(interview)?.id ?? 'finished');
  parts.push(`interview=${asked}`, `of=${INTERVIEW_QUESTIONS.length}`);

  const head = pendingSmokeHead;
  pendingSmokeHead = null;
  window.ledar.devReport(head === null ? parts.join(' ') : `${head} ${parts.join(' ')}`);
}

function renderOutcome(outcome: ConnectOutcome): void {
  const bubble = addTurn('assistant');

  switch (outcome.kind) {
    case 'read_only_enforced': {
      bubble.append(el('p', undefined, t('proof.intro')));

      const card = el('div', 'card ok');
      const proof = el('div', 'proof');
      const badge = el('span', 'proof-icon');
      badge.append(icon('check'));
      const words = el('div');
      words.append(
        el('h3', undefined, t('proof.enforced.headline')),
        el('p', 'meta', t('proof.enforced.meta')),
      );
      proof.append(badge, words);
      card.append(proof);
      card.append(...sessionFacts(outcome.session));
      card.append(...probeNotes(outcome.probe));
      bubble.append(card);

      bubble.append(scopeCard(outcome.scope.lines));
      bubble.append(revokeDetails(outcome.scope.revokeSql));
      bubble.append(el('p', undefined, t('next.enforced')));

      setStatus('enforced');
      // The scan is offered after a PROVEN connection and only that one — and
      // this is also the only outcome that carries a handle to scan with
      // (shared/ipc.ts says why). The other three end the conversation where
      // they are: reading somebody's database, having just told them it has
      // not vouched for read-only, would be carrying on as if the refusal
      // were a formality.
      offerScan(outcome.handle);
      break;
    }

    case 'writable': {
      bubble.append(el('p', undefined, t('proof.intro')));

      const card = el('div', 'card attention');
      const proof = el('div', 'proof');
      const badge = el('span', 'proof-icon');
      badge.append(icon('alert'));
      const words = el('div');
      words.append(el('h3', undefined, t('writable.headline')), el('p', undefined, outcome.disclosure));
      proof.append(badge, words);
      card.append(proof);

      card.append(el('p', 'meta', t('writable.body')));
      card.append(el('p', 'kicker', t('writable.list')));
      const list = el('ul', 'writable-list');
      for (const table of outcome.writable.slice(0, 10)) {
        const item = el('li', 'mono', `${table.schema}.${table.table}`);
        item.append(el('span', 'privs', `  ${table.privileges.join(', ')}`));
        list.append(item);
      }
      if (outcome.writable.length > 10) {
        list.append(el('li', 'meta', t('writable.more', { n: outcome.writable.length - 10 })));
      }
      card.append(list);

      card.append(el('p', undefined, t('writable.fix')));
      card.append(codeBlock(outcome.repairSql));
      card.append(...probeNotes(outcome.probe));
      bubble.append(card);

      bubble.append(scopeCard(outcome.scope.lines));
      bubble.append(revokeDetails(outcome.scope.revokeSql));

      const actions = el('div', 'actions');
      actions.append(tryAgainButton());
      bubble.append(actions);

      setStatus('writable');
      break;
    }

    case 'refused': {
      const card = el('div', 'card attention');
      const proof = el('div', 'proof');
      const badge = el('span', 'proof-icon');
      badge.append(icon('alert'));
      const words = el('div');
      words.append(el('h3', undefined, t('refused.headline')), el('p', undefined, outcome.reason));
      proof.append(badge, words);
      card.append(proof);
      card.append(...probeNotes(outcome.probe));
      card.append(el('p', undefined, t('refused.fix')));
      card.append(codeBlock(outcome.roleSql));
      bubble.append(card);

      const actions = el('div', 'actions');
      actions.append(tryAgainButton());
      bubble.append(actions);

      setStatus('refused');
      break;
    }

    case 'connect_error': {
      const card = el('div', 'card pending');
      card.append(el('h3', undefined, t('error.headline')));
      const detail = el('p', 'mono meta probe-detail');
      detail.textContent = outcome.message;
      card.append(detail);
      card.append(...helpChecklist());
      bubble.append(card);

      const actions = el('div', 'actions');
      actions.append(tryAgainButton());
      bubble.append(actions);

      setStatus('none');
      break;
    }
  }

  chat.scrollTop = chat.scrollHeight;
}

// ---- boot ------------------------------------------------------------------

function bootChrome(): void {
  byId('brand-name', HTMLSpanElement).textContent = t('brand.name');
  byId('brand-expansion', HTMLSpanElement).replaceChildren(...expansion().childNodes);
  byId('status-label', HTMLSpanElement).textContent = t('status.label');
  setStatus('none');

  byId('composer-label', HTMLLabelElement).textContent = t('composer.label');
  const composerInput = byId('composer-input', HTMLInputElement);
  composerInput.placeholder = t('composer.waiting');
  byId('composer-send', HTMLButtonElement).textContent = t('composer.send');
  byId('composer', HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    submitAnswer();
  });
}

async function bootDev(): Promise<void> {
  const prefill = await window.ledar.devPrefill();
  if (prefill === null) return;
  devMode = true;
  // Only when the run is already unattended. A prefilled form somebody is
  // sitting in front of still waits for them to read the proof and press the
  // button — that sequence is the product, not a formality to skip in dev.
  devAutoScan = prefill.autoconnect;
  await startGuide();
  if (guideRefs !== null) {
    guideRefs.input.value = prefill.dsn;
    if (prefill.autoconnect) void submitDsn();
  }
}

bootChrome();
welcome();
void bootDev();
