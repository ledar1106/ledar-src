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
  AreaFacts,
  AreaReply,
  AskOutcome,
  AskPreview,
  ConnectOutcome,
  InterviewQuestion,
  ProfileArea,
  ProfileFacts,
  ReportFinding,
  ReportVerdict,
  ScanOutcome,
  SessionFacts,
  SessionHandle,
  WriteProbeFacts,
} from '../shared/ipc.js';
import { dsnDisplayTarget } from './dsn.js';
import { isMessageKey, t } from './i18n.js';
import {
  answer,
  currentQuestion,
  isFinished,
  repliesOf,
  skipRest,
  startInterview,
} from './interview.js';
import type { AnswerResult, Interview } from './interview.js';
import { EVERY_RUNG, shapeForDirection, shapeForRung } from './profile-shape.js';
import { askGaps, askShape, mustShow } from './ask-shape.js';
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
  //
  // Held when the interview is still fetching its question set: the set became
  // a round trip when it moved into the contract, and a line printed in that
  // window reports `interview=loading of=?` — true, and evidence of nothing.
  // The whole point of this slice is that five questions reach a person, so
  // the line waits until the first one is on screen. `pendingScanSmoke` is
  // released by `askQuestion`, and by the failure paths below, so a form that
  // never arrives still prints rather than hanging silently.
  if (devMode) {
    if (interviewRequested && interview === null) pendingScanSmoke = outcome;
    else reportScanToSmoke(outcome);
  }
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

  // ④b What the scan did NOT run, in the budget's own sentence. Debt N51.
  //
  // Placed here and not in the run notes at the foot, because the CLI places
  // it here — after the patterns, before the conclusion — and two surfaces of
  // one product putting the same sentence in different places is how a reader
  // who uses both stops trusting either. Down in `run-notes` beside the cost
  // line it would read as bookkeeping; it is not bookkeeping. `QueryBudget`
  // exists to enforce one rule, *never cut quietly*, and this sentence is the
  // whole of how that rule reaches a person.
  //
  // Absent when nothing was cut, and that absence is honest: the sentence only
  // exists when there is a refusal to report. Unlike `boundary`, nothing reads
  // a meaning out of it not being here.
  if (outcome.disclosure !== null) {
    const cut = el('p', 'cut-short');
    cut.textContent = outcome.disclosure;
    report.append(cut);
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
 * ⚠️ Section ② findings get no attention rail. That USED to be a limit of the
 * contract; it is now a choice, and the difference is worth keeping straight.
 *
 * The old note here said `ReportFinding` carried nothing about whether a
 * finding was RAISED — a negative ("the one constraint I could check is being
 * kept") and a real finding arrived in the same shape — and that `boundary`
 * being non-null would ALMOST serve as the flag, so it deliberately went
 * unused: *"the field is a sentence about limits, not a claim kind … a rail
 * keyed to it would invert silently."* That reasoning was right and the debt
 * it named is closed: `kind` is on the contract now (N49), taken from the
 * contract's own `ClaimKind`, so the flag exists and is the real thing rather
 * than a correlate.
 *
 * The rail still does not go on, and now for a reason about readers instead of
 * a reason about types: painting every confirmed line as attention would put
 * an amber rail beside a sentence saying nothing was wrong, which is a louder
 * lie than a plain card beside one saying something was. The count of what was
 * raised is the verdict's job, and the verdict has the number. If that is ever
 * revisited, it is a `_doc/25` 3.3 question — and `kind` is what any answer
 * would key off.
 *
 * Section ④ is different: every finding in it is unconfirmed by definition of
 * the section, so the question shape is backed by the data itself.
 */
function findingCard(finding: ReportFinding): HTMLElement {
  const card = el('article', finding.section === 'patterns' ? 'card question' : 'card');

  const copy = el('p', 'finding-copy');
  copy.textContent = finding.plainText;
  card.append(copy);

  {
    // Unconditional as of N50, and that is the whole change: `_doc/25` S6 asks
    // for this on every finding, and the guard that used to be here — render
    // it if it is not null — was the shape that let some cards have one and
    // others not. Once that is true of a card, its ABSENCE starts saying
    // something nobody wrote, which is the argument the CLI makes for printing
    // its coverage figures on every report.
    //
    // "but only this far" — S6 says this belongs to the body of the card and
    // is never cut. Printed as the backend wrote it, prefix included: the
    // wording of that clause is the backend's to choose, and a second prefix
    // added here would read as the product stammering.
    //
    // 🟥 "Prefix included" was written here while it was FALSE. `scan-flow`
    // handed over the bare sentence, so a negative and an abstention reached
    // this card looking identical — and telling those apart is the entire
    // reason debt N8 split the claim kinds in the first place. The lead-in is
    // chosen on the backend now, by `kind`, in the same two catalogue entries
    // the CLI uses. A comment describing an intention rather than the code is
    // worse than no comment: it is the thing that stops the next reader from
    // checking.
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

// ---- S3: the five questions that build the map -----------------------------

/**
 * The interview is a conversation state like every other one here: the
 * assistant asks in a turn, the person answers by pressing a button, and the
 * answer becomes their turn.
 *
 * 🟥 There is no text box in this screen any more, and that is the change.
 * Until 2026-08-27 this asked one free-text question, with a model waiting
 * downstream to turn the sentence into a runnable check. `interview.ts` holds
 * the full account of what reading VS-6 that way cost. What matters at this
 * layer: with no free text there is nothing to inject into, and the answers
 * are three enum values plus a set of ids that came from the contract to
 * begin with.
 */
let interview: Interview | null = null;

/**
 * Set the moment the interview is asked for, before the form has arrived.
 *
 * 🟥 Without this the smoke line reported `interview=none of=0` on a run where
 * the interview was starting — and `of=0` reads as "the question set is
 * empty", which is a different and false statement. The set became a round
 * trip when it moved into the contract, so there is now a window in which the
 * window has asked and has nothing yet, and that window needs its own word
 * rather than being folded into "never started".
 */
let interviewRequested = false;

/** A scan smoke line held until the interview has asked its first question. */
let pendingScanSmoke: ScanOutcome | null = null;

/** Prints a held smoke line, once, whatever became of the interview. */
function releaseScanSmoke(): void {
  // Held while anything the line reports on is still in the air. The map is a
  // round trip of its own, and a line printed between the last question being
  // answered and the map coming back would say `profile=none` about a run
  // that was in the middle of building one — true at the instant it printed,
  // and evidence of nothing. `requestProfile` calls this again from a
  // `finally`, so a map that never arrives still releases the line.
  if (pendingScanSmoke === null || profileInFlight) return;
  const outcome = pendingScanSmoke;
  pendingScanSmoke = null;
  reportScanToSmoke(outcome);
}

/**
 * Buttons of the question currently being asked.
 *
 * Every turn stays on screen forever, because a conversation is a record and
 * S2's proof turn has to still be there after the interview scrolls past it.
 * That means the buttons of ANSWERED questions are still on screen too, and a
 * live one would land its answer against whatever question is current now. So
 * they are disabled the moment their question is answered.
 */
let pendingButtons: HTMLButtonElement[] = [];

function composerInput(): HTMLInputElement {
  return byId('composer-input', HTMLInputElement);
}

function composerSend(): HTMLButtonElement {
  return byId('composer-send', HTMLButtonElement);
}

function beginInterview(): void {
  interviewRequested = true;
  void window.ledar
    .interviewForm()
    .then((form) => {
      interview = startInterview(form);
      addTurn('assistant').append(el('p', undefined, t('interview.intro')));
      askQuestion();
      // The first question is on screen before this, so the smoke run proves
      // the interview reached a person-shaped surface and THEN skips it.
      if (devAutoSkip) skipAll();
    })
    .catch(() => {
      // The question set could not be fetched. The report above is unaffected
      // — it was written before this ran and says nothing that depended on it
      // — so the failure costs the interview and nothing else.
      addTurn('assistant').append(el('p', undefined, t('interview.unavailable')));
    })
    .finally(releaseScanSmoke);
}

/** One question: the three-way answer row, and the list that follows a yes. */
function askQuestion(): void {
  if (interview === null) return;
  const question = currentQuestion(interview);
  if (question === null) return;

  const n = interview.index + 1;
  const total = interview.questions.length;

  const bubble = addTurn('assistant');
  const card = el('div', 'card');
  card.append(el('p', 'kicker', t('interview.progress', { n, total })));
  card.append(el('h3', undefined, t(`interview.area.${question.area}`)));

  const actions = el('div', 'actions');
  pendingButtons = [];

  // Three peers, in the order a person reads them. "I do not know" is NOT a
  // faded third choice: ideal §13's audit says not knowing is where every
  // system starts, and the label is a work order rather than a confession.
  const choose = (value: AreaReply['answer'], label: string): HTMLButtonElement => {
    const button = el('button', 'button', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (interview === null) return;
      if (value === 'yes' && question.options.length > 0) {
        lockButtons();
        addTurn('user').append(el('p', undefined, label));
        askOptions(question);
        return;
      }
      applyAnswer(answer(interview, { answer: value }), label);
    });
    pendingButtons.push(button);
    return button;
  };

  actions.append(
    choose('yes', t('interview.yes')),
    choose('no', t('interview.no')),
    choose('dont_know', t('interview.dont-know')),
  );
  card.append(actions);

  // Available at every step, and expected to be the most-used control in the
  // product for this ICP. Set apart from the three answers because it ends
  // the interview rather than answering this question.
  const skip = el('button', 'button small', t('interview.skip-all'));
  skip.type = 'button';
  skip.addEventListener('click', () => skipAll());
  pendingButtons.push(skip);
  card.append(skip);

  bubble.append(card);
  chat.scrollTop = chat.scrollHeight;
}

/**
 * The follow-up list, shown only after a yes.
 *
 * Checkboxes rather than one choice: a system can use two of these at once,
 * and forcing a single pick collects a tidier answer that is less true.
 */
function askOptions(question: InterviewQuestion): void {
  const bubble = addTurn('assistant');
  const card = el('div', 'card');
  card.append(el('h3', undefined, t(`interview.which.${question.area}`)));

  const list = el('div', 'section-body');
  const boxes: HTMLInputElement[] = [];
  for (const id of question.options) {
    const row = el('label', 'option-row');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.value = id;
    boxes.push(box);
    row.append(box, el('span', undefined, optionLabel(id)));
    list.append(row);
  }
  card.append(list);

  pendingButtons = [];
  const done = el('button', 'button primary', t('interview.confirm'));
  done.type = 'button';
  done.addEventListener('click', () => {
    if (interview === null) return;
    const picked = boxes.filter((b) => b.checked).map((b) => b.value);
    for (const box of boxes) box.disabled = true;
    applyAnswer(
      answer(interview, { answer: 'yes', picked }),
      picked.length === 0
        ? t('interview.picked.none')
        : picked.map(optionLabel).join(', '),
    );
  });
  pendingButtons.push(done);

  const actions = el('div', 'actions');
  actions.append(done);
  card.append(actions);
  bubble.append(card);
  chat.scrollTop = chat.scrollHeight;
}

/**
 * The label for one option id.
 *
 * Falls back to the raw id, deliberately and visibly. See `isMessageKey`:
 * the fallback is unreachable in a correct build and exists so that a
 * contract change without a label here is SEEN rather than rendered blank.
 */
function optionLabel(id: string): string {
  const key = `interview.option.${id}`;
  return isMessageKey(key) ? t(key) : id;
}

/**
 * Ends the interview here and keeps everything already said.
 *
 * A function rather than the button's handler because the smoke run presses
 * it too (`bootDev`), and a second path that skips by hand would be a second
 * definition of what skipping means.
 */
function skipAll(): void {
  if (interview === null) return;
  lockButtons();
  addTurn('user').append(el('p', undefined, t('interview.skip-all.said')));
  interview = skipRest(interview);
  finishInterview();
}

function lockButtons(): void {
  for (const button of pendingButtons) button.disabled = true;
  pendingButtons = [];
}

function applyAnswer(result: AnswerResult, echo: string): void {
  if (!result.ok) {
    // `unknown-option` cannot be reached by clicking — the boxes are built
    // from the options the main side sent. It is reported rather than
    // swallowed because the only ways to produce one are a bug or a console,
    // and a silent no-op would hide both.
    if (result.reason === 'unknown-option') {
      addTurn('assistant').append(el('p', undefined, t('interview.unknown-option')));
      chat.scrollTop = chat.scrollHeight;
    }
    return;
  }

  lockButtons();
  addTurn('user').append(el('p', undefined, echo));

  interview = result.interview;
  if (isFinished(interview)) finishInterview();
  else askQuestion();
}

function finishInterview(): void {
  if (interview === null) return;

  const bubble = addTurn('assistant');
  bubble.append(el('p', 'lead', t('interview.done.heading')));

  const replies = repliesOf(interview);
  const said = replies.filter((r) => r.answer !== 'dont_know').length;

  const card = el('div', 'card');
  if (said === 0) {
    // Everybody skipped, or said "I do not know" throughout. Not a failure and
    // not phrased as one — ideal §13's audit expects this to be the most
    // common ending for this ICP, and the product's job from here is to go and
    // look rather than to ask again.
    card.append(el('p', undefined, t('interview.done.nothing-said')));
  } else {
    card.append(el('p', undefined, t('interview.done.kept', { n: said })));
  }

  card.append(el('p', 'meta', t('interview.done.next')));
  bubble.append(card);

  chat.scrollTop = chat.scrollHeight;

  // The answers go over as they were given, including nothing at all. An
  // interview somebody walked away from sends the part they answered, and
  // `reconcile` leaves the rest `unknown` — which is true — rather than
  // `dont_know`, which would be words in their mouth (`interview.ts`).
  requestProfile(replies);
}

// ---- the map: what was said, put beside what was seen ----------------------

/**
 * Ideal §23, and the second half of ideal §12's audit:
 *
 * > *"Scan trước (rẻ, tự động) → Trình bày cái tìm được → User chỉ bấm
 * > Đúng/Sai. Câu hỏi cũ đòi KIẾN THỨC; câu hỏi mới chỉ đòi XÁC NHẬN điều đã
 * > thấy."*
 *
 * The five questions asked for RECOGNITION. This screen asks for less than
 * that: everything on it is already on the screen, and the person's whole job
 * is to say whether what is in front of them is right.
 *
 * ## Why this block is replaced in place while every turn above it is not
 *
 * The conversation is a record and nothing in it is ever rewritten — that is
 * the architecture decision at the top of this file. A map is not a record;
 * it is a STATE, and the contract gives it a `version` precisely because
 * ideal §24 expects it to be edited. Rendering a second copy of all five
 * areas under the first would leave two maps on screen disagreeing with each
 * other, and a reader scrolling back would have no way to tell which one the
 * product currently believes.
 *
 * So: one block, always the newest facts, and the version on it. The person's
 * ACTIONS still leave a record — that is what `verified` is, and it is a
 * sturdier one than a chat echo because it is dated and travels with the map.
 */
let profileBlock: HTMLDivElement | null = null;

/** The newest map, kept for the smoke line and for redrawing after a refusal. */
let profileFacts: ProfileFacts | null = null;

/** Set when the map is first asked for, so the smoke line can tell three states apart. */
let profileRequested = false;

/** True between asking for a map and getting an answer, of either kind. */
let profileInFlight = false;

/** One confirmation at a time; the map is rebuilt from whatever comes back. */
let confirming = false;

function requestProfile(replies: readonly AreaReply[]): void {
  profileRequested = true;
  profileInFlight = true;
  void window.ledar
    .saveProfile(replies)
    .then((facts) => {
      // 🟥 Null means no database has been read, so there is nothing for these
      // answers to be about. Handled BEFORE anything is drawn, which is the
      // whole repair: `ipcMain.handle` resolves with null rather than
      // rejecting, so this used to reach `renderProfile`, build the "here is
      // your map" bubble, and only then throw on the empty cards. A person got
      // an empty map followed by a message saying the map could not be built.
      if (facts === null) {
        profileUnavailable();
        return;
      }
      renderProfile(facts, null);
      announce(t('announce.profile'));
    })
    .catch(() => {
      // Everything above this is untouched by the failure — the report was
      // written from the database before any of this ran, and what the person
      // said is still in the turns where they said it. So the sentence says
      // what was lost and nothing more alarming than that.
      profileUnavailable();
    })
    .finally(() => {
      profileInFlight = false;
      releaseScanSmoke();
    });
}

/**
 * Draws the map, or redraws it.
 *
 * `refocus` is the area whose control was just pressed. The block is rebuilt
 * whole, so the button that was under the person's finger no longer exists —
 * without this, a keyboard user's focus falls to the top of the document and
 * they have to find their place again.
 */
/** One sentence, said the same way whether the map failed or never applied. */
function profileUnavailable(): void {
  addTurn('assistant').append(el('p', undefined, t('profile.unavailable')));
  chat.scrollTop = chat.scrollHeight;
}

function renderProfile(facts: ProfileFacts, refocus: ProfileArea | null): void {
  profileFacts = facts;

  // 🟥 S6 opens HERE and not a moment earlier. A question is answered by
  // looking in the map, so the composer stays disabled until there is one —
  // and the map is the thing this function has just been handed.
  //
  // Not gated on every area being `verified`. Confirmation is about what the
  // person believes of their own system; the routes G3 walks come from the
  // catalogue either way, and refusing to answer until five cards are ticked
  // would be a gate whose reason nobody could state.
  enableComposer();

  if (profileBlock === null) {
    const bubble = addTurn('assistant');
    bubble.append(el('p', undefined, t('profile.intro')));
    profileBlock = el('div', 'map');
    bubble.append(profileBlock);
  }

  const cards = new Map<ProfileArea, HTMLElement>();
  profileBlock.replaceChildren(...mapParts(facts, cards));

  if (refocus !== null) {
    const card = cards.get(refocus);
    if (card !== undefined) {
      card.tabIndex = -1;
      card.focus();
      card.scrollIntoView({ block: 'nearest' });
      return;
    }
  }
  chat.scrollTop = chat.scrollHeight;
}

function mapParts(facts: ProfileFacts, cards: Map<ProfileArea, HTMLElement>): HTMLElement[] {
  const parts: HTMLElement[] = [];

  // 🟥 First, above everything. A disagreement is the one thing on this
  // screen that neither half of the product could have produced alone, and
  // the direction that matters most is the question they did not know to ask
  // — putting it under five cards they have to read first is how it gets
  // missed by the person it was found for.
  if (facts.conflicts.length > 0) {
    const body = el('div', 'section-body');
    for (const conflict of facts.conflicts) body.append(conflictCard(conflict));
    parts.push(reportSection(t('profile.conflicts.heading'), body));
  }

  // In the order the main side sent them, which is the contract's order.
  // Sorting by rung here would put the areas in a different order on every
  // run, and a map somebody returns to is worth being able to read from
  // memory. It would also quietly rank the rungs, which ideal §22 says is
  // exactly what they are not.
  const areas = el('div', 'section-body');
  for (const area of facts.areas) {
    const card = areaCard(area);
    cards.set(area.area, card);
    areas.append(card);
  }
  parts.push(reportSection(t('profile.areas.heading'), areas));

  const notes = el('div', 'run-notes');
  notes.append(el('p', 'meta', t('profile.version', { n: facts.version })));
  // Disclose and Admit, and NOT in `meta`. `_doc/25`'s own gate asks every
  // screen where it has not looked and where it does not know; these are this
  // screen's two answers, and the argument `.cut-short` makes applies here —
  // a grey aside saying the map was built without reading any data is how a
  // reader concludes the map was built by reading their data.
  notes.append(el('p', 'admit', t('profile.method')));
  notes.append(el('p', 'admit', t('profile.no-path')));
  parts.push(notes);

  return parts;
}

/**
 * One area, drawn as the rung it is actually on.
 *
 * The rungs mean different things and `profile-shape.ts` holds the rule that
 * they may not look alike. What is here is the copy that goes with the shape,
 * and one thing the shape cannot carry: `suspected` and `observed` get the
 * SAME control, because the person is being asked the same question either
 * way — *is this right?* — and only the card around it differs.
 */
function areaCard(area: AreaFacts): HTMLElement {
  const shape = shapeForRung(area.state);
  const card = el('article', `card rung ${shape.tone}`);

  const head = el('div', 'rung-head');
  if (shape.icon !== null) head.append(icon(shape.icon, 'rung-icon'));
  head.append(el('span', 'kicker', t(`profile.state.${area.state}`)));
  card.append(head);

  card.append(el('h3', undefined, t(`profile.area.${area.area}`)));
  card.append(el('p', undefined, t(`profile.state.${area.state}.body`)));

  // What they said, kept beside what was seen. Null on `unknown` (nobody
  // said) and on `verified` (the agreement supersedes the answer), and the
  // contract says which — nothing here reads a meaning out of the absence.
  if (area.stated !== null) card.append(el('p', 'meta', t(`profile.said.${area.stated}`)));

  // What they picked, beside what they answered. Joined here rather than in
  // the catalogue because a list is a list in every language and the separator
  // is not the sentence — the sentence is the key above.
  if (area.statedPicked.length > 0) {
    card.append(
      el('p', 'meta', t('profile.said.picked', { items: area.statedPicked.join(', ') })),
    );
  }

  if (area.evidence.length > 0) card.append(evidenceBlock(area.evidence));

  if (shape.confirmable) {
    const actions = el('div', 'actions');
    actions.append(confirmButton(area.area));
    card.append(actions);
  }

  return card;
}

/**
 * Where it was seen, and why that was read as meaning something.
 *
 * Both come from the backend and both go on screen as received. `why` is the
 * step rather than the conclusion — *this column's name contains "stripe"* —
 * so a person can disagree with the reasoning instead of only with the
 * result, and rewriting it here would take that away.
 */
function evidenceBlock(evidence: AreaFacts['evidence']): HTMLElement {
  const block = el('div', 'evidence-block');
  block.append(el('p', 'kicker', t('profile.evidence.heading')));

  const list = el('ul', 'evidence');
  for (const item of evidence) {
    const row = el('li');
    const where = el('span', 'mono where');
    where.textContent = item.where;
    const why = el('span', 'why');
    why.textContent = item.why;
    row.append(where, why);
    list.append(row);
  }
  block.append(list);
  return block;
}

/**
 * The only control in this product that can produce `verified`.
 *
 * Offered only where `profile-shape.ts` says it may be, which is the two
 * rungs that have evidence on the card. The main side refuses the rest, and
 * a window that offered a button the other side declines would be teaching
 * somebody that pressing things here does nothing.
 */
function confirmButton(area: ProfileArea): HTMLButtonElement {
  const button = el('button', 'button', t('profile.confirm'));
  button.type = 'button';
  button.addEventListener('click', () => {
    if (confirming) return;
    confirming = true;
    button.disabled = true;

    void window.ledar
      .confirmArea(area)
      .then((facts) => {
        // Same null, same reason. A confirmation can only be about a map, and
        // a window with no map has nothing to redraw.
        if (facts === null) {
          announce(t('profile.confirm.failed'));
          addTurn('assistant').append(el('p', undefined, t('profile.confirm.failed')));
          chat.scrollTop = chat.scrollHeight;
          return;
        }
        renderProfile(facts, area);
        announce(t('announce.profile.confirmed', { area: t(`profile.area.${area}`) }));
      })
      .catch(() => {
        // Nothing was recorded, so the map already on screen is still the
        // true one — it is redrawn rather than left standing with a dead
        // button, because a control that has been pressed and stayed down is
        // indistinguishable from one still thinking about it.
        if (profileFacts !== null) renderProfile(profileFacts, area);
        announce(t('profile.confirm.failed'));
        addTurn('assistant').append(el('p', undefined, t('profile.confirm.failed')));
        chat.scrollTop = chat.scrollHeight;
      })
      .finally(() => {
        confirming = false;
      });
  });
  return button;
}

/**
 * A disagreement, in the direction it actually points.
 *
 * 🟥 The two directions are not phrased alike and must never be. One is about
 * their system and is the most valuable thing this product can produce; the
 * other is about the edge of what this product can see. `conflictsIn` in the
 * contract says what getting it wrong would be: *"the product mistaking the
 * edge of its own vision for the edge of the world."*
 *
 * The evidence is shown here as well as on the area's own card below. That
 * repeat is deliberate and has a precedent one screen up: the report prints
 * its scope strip at the top AND the bottom, because a card that cannot be
 * read on its own is a card that gets read out of context by whoever lands
 * on it first.
 */
function conflictCard(conflict: ProfileFacts['conflicts'][number]): HTMLElement {
  const shape = shapeForDirection(conflict.direction);
  const card = el('article', `card conflict ${shape.tone}`);

  const head = el('div', 'proof');
  const badge = el('span', 'proof-icon');
  badge.append(icon(shape.icon));
  const words = el('div');
  words.append(
    el('p', 'kicker', t(`profile.area.${conflict.area}`)),
    el('h3', undefined, t(`profile.conflict.${conflict.direction}.headline`)),
  );
  head.append(badge, words);
  card.append(head);

  card.append(el('p', undefined, t(`profile.conflict.${conflict.direction}.body`)));

  // Empty in the direction that has nothing to show — a thing we could not
  // see leaves no evidence, and that IS the finding. Rendered when it is
  // there rather than switched on the direction, so a future conflict that
  // does carry sightings does not arrive with nowhere to put them.
  if (conflict.evidence.length > 0) card.append(evidenceBlock(conflict.evidence));

  return card;
}


// ---- conversation states ---------------------------------------------------

let guideRefs: { input: HTMLInputElement; connect: HTMLButtonElement } | null = null;
let guideStarted = false;
let connecting = false;
let devMode = false;

/** Smoke run only: nobody is there to press the scan button. */
let devAutoScan = false;

/** Smoke run only: nobody is there to answer five questions either. */
let devAutoSkip = false;

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
      // The two things this slice added, in the only form allowed here.
      //
      // `kinds` is contract VOCABULARY — five fixed words from `ClaimKind`,
      // sorted, never a sentence and never a table name. Before N49 this line
      // could not have printed it at all: the bridge did not carry the kinds,
      // and the nearest available stand-in would have been counting non-null
      // boundaries, which is the inference the debt was about.
      //
      // `cut` says WHETHER the budget's disclosure reached the screen, never
      // what it said. Absent is a real state (nothing was refused), so it gets
      // a word of its own rather than an empty string.
      `kinds=${[...new Set(outcome.findings.map((f) => f.kind))].sort().join(',') || 'none'}`,
      `cut=${outcome.disclosure === null ? 'none' : 'shown'}`,
      // N50, as a fraction rather than a boolean. The type already forbids
      // null, so what is left to measure is the failure the type cannot see:
      // an empty string, which renders as a card with a blank line where the
      // limit of the measurement should be. `4/4` is the only reading that
      // means every finding on screen said how far it looked.
      `bounds=${outcome.findings.filter((f) => f.boundary.trim() !== '').length}/${outcome.findings.length}`,
    );
  }

  // Three states, not two: never started, asked for and not yet arrived, and
  // running. `of` is only a number once there is a set to count.
  const asked =
    interview !== null
      ? (currentQuestion(interview)?.area ?? 'finished')
      : interviewRequested
        ? 'loading'
        : 'none';
  parts.push(`interview=${asked}`, `of=${interview === null ? '?' : interview.questions.length}`);
  parts.push(...profileToSmoke());

  const head = pendingSmokeHead;
  pendingSmokeHead = null;
  window.ledar.devReport(head === null ? parts.join(' ') : `${head} ${parts.join(' ')}`);
}

/**
 * The map, in the only form this line is allowed to carry.
 *
 * Counts of RUNGS, and the vocabulary of the ladder — five fixed words that
 * came from `@ledar/contracts`. Never an area beside a rung: *"observed:
 * payment"* is a sentence about somebody's business, and this line is read
 * off a terminal by whoever is running the smoke.
 *
 * Every rung is printed, including the ones at zero. A rung that only appears
 * when it is non-zero would make its absence mean something, which is the
 * shape debt N49 was about — and here it would be worse than usual, because
 * the counts always sum to the number of areas, so a reader could not tell a
 * missing rung from a miscount.
 */
function profileToSmoke(): string[] {
  if (profileFacts === null) {
    // `?` and not `0`. Zero conflicts is a real and reassuring answer; no map
    // at all is not an answer about conflicts in either direction.
    return [`profile=${profileRequested ? 'failed' : 'none'}`, 'conflicts=?', 'conflict_dirs=?'];
  }

  const facts = profileFacts;
  const counts = EVERY_RUNG.map(
    (rung) => `${rung}:${facts.areas.filter((a) => a.state === rung).length}`,
  ).join(',');
  const directions = [...new Set(facts.conflicts.map((c) => c.direction))].sort().join(',');

  return [
    `profile=${counts}`,
    `conflicts=${facts.conflicts.length}`,
    // The two directions mean opposite things and get opposite treatments, so
    // the count alone would not say which of the two was on screen.
    `conflict_dirs=${directions || 'none'}`,
  ];
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

// ---- S6: ask one question, and see what leaves before it leaves ------------
//
// 🟥 This is the first screen in the product that sends anything anywhere.
// Everything above reads the person's own database and writes to their own
// disk; from here a question and a list of their table names go to a third
// party. So the sequence is: type · SEE WHAT LEAVES · agree · answer — and the
// disclosure is a turn in the conversation rather than a modal, because a
// modal is a thing people dismiss and a turn is a thing they read.
//
// The composer has been on the page and inert since 2026-08-27, waiting for
// exactly this. Its old comment said S7 would need it; S6 needed it first.

/** Set once the map exists, so the composer cannot be used before there is one. */
let askable = false;
/** One question in flight at a time. Main enforces it too; this stops the ask. */
let askInFlight = false;

function enableComposer(): void {
  askable = true;
  const input = composerInput();
  input.disabled = false;
  input.placeholder = t('ask.placeholder');
  const send = composerSend();
  send.disabled = false;
  send.textContent = t('ask.send');
  // 🟥 Focused, and found by driving the window rather than by reasoning: the
  // first click on the just-enabled field did nothing three times running,
  // because the map is still being laid out underneath it. A field that has
  // this moment become the one thing a person can use, and swallows their
  // first attempt at using it, teaches them the product is unresponsive —
  // and they learn that before they have read a word of what it says.
  //
  // Only when nothing else is focused. Stealing focus from somebody already
  // typing, or mid-way through reading a confirmation, would be worse than
  // the bug.
  if (document.activeElement === null || document.activeElement === document.body) {
    input.focus();
  }
}

/**
 * The disclosure turn: what would leave, and the two fields that say which row.
 *
 * 🟥 The row identifier is asked for HERE rather than earlier, and that is not
 * layout. It is the last thing collected before sending, so the person is
 * looking at the list of what leaves at the moment they decide — and `which
 * customer` is theirs to know, never something this product guesses at.
 */
function renderPreview(question: string, preview: AskPreview): void {
  const bubble = addTurn('assistant');

  if (preview.kind === 'unavailable') {
    bubble.append(
      el(
        'p',
        undefined,
        preview.reason === 'no-model-configured' ? t('ask.no-key') : t('ask.no-scan'),
      ),
    );
    return;
  }

  if (preview.kind === 'refused') {
    // Not a send button with a warning above it. There is no send button.
    const card = el('div', 'card alarm');
    card.append(icon('alert', 'card-icon'));
    card.append(el('p', 'card-line', t('ask.leaving.refuse')));
    card.append(el('p', 'card-note', preview.why));
    bubble.append(card);
    return;
  }

  bubble.append(el('h3', 'section-head', t('ask.leaving.head')));

  const list = el('ul', 'fact-list');
  for (const line of [
    t('ask.leaving.dest', { destination: preview.destination }),
    t('ask.leaving.names', { count: String(preview.identifiers.length) }),
    t('ask.leaving.bytes', {
      bytes: String(preview.firstBytes + preview.secondBytesAtWorst),
    }),
    t('ask.leaving.rows'),
  ]) {
    list.append(el('li', undefined, line));
  }
  bubble.append(list);

  // The sentence the main side wrote, quoted rather than rephrased. Two places
  // wording the same disclosure is two disclosures.
  bubble.append(el('p', 'card-note', preview.note));

  // 🟥 The names themselves, behind a disclosure control rather than hidden.
  // A screen that says "37 table names" and will not show which 37 is asking
  // for agreement to something it declined to display.
  const names = el('details', 'evidence');
  names.append(el('summary', undefined, t('ask.leaving.names', {
    count: String(preview.identifiers.length),
  })));
  names.append(codeBlock(preview.identifiers.join('\n')));
  bubble.append(names);

  const row = el('div', 'actions');
  const key = el('input', 'inline-input');
  key.type = 'text';
  key.placeholder = 'customer_id';
  key.setAttribute('aria-label', 'which column identifies the row');
  const value = el('input', 'inline-input');
  value.type = 'text';
  value.placeholder = '1';
  value.setAttribute('aria-label', 'which row');
  const send = el('button', 'button primary', t('ask.confirm'));
  send.type = 'button';
  const cancel = el('button', 'button', t('ask.cancel'));
  cancel.type = 'button';

  send.addEventListener('click', () => {
    send.disabled = true;
    cancel.disabled = true;
    void runAsk(question, key.value.trim(), value.value.trim());
  });
  cancel.addEventListener('click', () => {
    send.disabled = true;
    cancel.disabled = true;
    key.disabled = true;
    value.disabled = true;
    announce(t('ask.cancel'));
  });

  row.append(key, value, send, cancel);
  bubble.append(row);
  chat.scrollTop = chat.scrollHeight;
}

/** The answer turn. Four shapes, and no two of them alike. */
function renderAnswer(outcome: AskOutcome): void {
  const bubble = addTurn('assistant');
  if (outcome.kind === 'unavailable') {
    // 🟥 The note FIRST, even here — especially here. A lookup that failed
    // because it was aimed somewhere the question named is explained by
    // exactly this sentence, and rendering it only on the success path meant
    // the one case that needed it never got it.
    if (outcome.provenance !== null) {
      const why = el('div', 'card pending');
      why.append(icon('shield', 'card-icon'));
      why.append(el('p', 'card-note', outcome.provenance));
      bubble.append(why);
    }
    bubble.append(el('p', 'card-note', outcome.why));
    return;
  }

  const { timeline, provenance } = outcome;
  const shape = askShape(timeline, outcome.aimedNowhere);
  const notes = mustShow(timeline, provenance);

  // 🟥 `before` first, and the ordering comes from `mustShow` rather than from
  // the order these lines happen to be written in. A reader who learns where
  // the answer was aimed only after reading the rows has already believed them.
  for (const note of notes.filter((n) => n.where === 'before')) {
    const card = el('div', 'card pending');
    card.append(icon('shield', 'card-icon'));
    card.append(el('p', 'card-note', note.text));
    bubble.append(card);
  }

  if (shape.bannerAtTop) {
    const banner = el('div', `banner ${shape.tone}`);
    banner.append(icon(shape.icon, 'card-icon'));
    banner.append(el('span', undefined, t(shape.headlineKey)));
    bubble.append(banner);
  }

  const card = el('div', `card ${shape.tone}`);
  card.append(icon(shape.icon, 'card-icon'));
  card.append(
    el(
      'p',
      'card-line',
      shape.kind === 'broke'
        ? t('ask.broke', { entity: timeline.brokeAt?.at ?? '' })
        : t(shape.headlineKey),
    ),
  );
  bubble.append(card);

  if (timeline.steps.length > 0) {
    const steps = el('ol', 'timeline');
    for (const step of timeline.steps) {
      const li = el('li');
      li.append(
        el(
          'span',
          'timeline-when',
          step.at ?? t('ask.untimed'),
        ),
      );
      li.append(
        el(
          'span',
          'timeline-what',
          step.rows === 1
            ? t('ask.hop.one', { entity: step.entity, via: step.via })
            : t('ask.hop.many', {
                entity: step.entity,
                rows: String(step.rows),
                via: step.via,
              }),
        ),
      );
      // The tier travels with the row, for the same reason `timeColumn` does:
      // a hop worth `guessed` and a hop worth `declared` are not the same
      // claim, and a reader who cannot see which cannot disagree.
      li.append(el('span', 'timeline-tier', step.tier));
      steps.append(li);
    }
    bubble.append(steps);
  }

  if (timeline.brokeAt !== null) {
    const broke = el('div', 'card attention');
    broke.append(
      el('p', 'card-note', t('ask.tier', { tier: timeline.brokeAt.tier })),
    );
    if (timeline.similar !== null) {
      // Three sentences for three counts. `t()` substitutes and does not
      // inflect, so "1 other subjects" is what one string produces — and it
      // was on screen before anybody looked.
      const line =
        timeline.similar === 0
          ? t('ask.similar.none')
          : timeline.similar === 1
            ? t('ask.similar.one')
            : t('ask.similar.many', { count: String(timeline.similar) });
      broke.append(el('p', 'card-note', line));
    }
    bubble.append(broke);
  }

  // 🟥 Three absences, three headings, never merged. Somebody told their schema
  // is unwalkable goes and looks at their foreign keys; somebody told the
  // ceiling was reached raises the ceiling. Fold them and half do the wrong
  // thing — which is why `timeline.ts` spent a type keeping them apart.
  for (const gap of askGaps(timeline)) {
    const box = el('div', `gap gap-${gap.kind}`);
    box.append(el('p', 'gap-label', t(gap.labelKey)));
    box.append(el('p', 'gap-entities', gap.entities.join(', ')));
    bubble.append(box);
  }

  if (timeline.outside.length > 0) {
    bubble.append(el('h3', 'section-head', t('ask.outside.head')));
    const list = el('ul', 'fact-list');
    for (const kind of timeline.outside) list.append(el('li', undefined, kind));
    bubble.append(list);
  }

  for (const note of notes.filter((n) => n.where === 'after')) {
    const card2 = el('div', 'card alarm');
    card2.append(icon('alert', 'card-icon'));
    card2.append(el('p', 'card-note', note.text));
    bubble.append(card2);
  }

  announce(t(shape.headlineKey));
  chat.scrollTop = chat.scrollHeight;
}

async function runAsk(question: string, key: string, value: string): Promise<void> {
  if (session === null) return;
  askInFlight = true;
  try {
    renderAnswer(await window.ledar.askSend(session, question, key, value));
  } catch (err) {
    renderAnswer({ kind: 'unavailable', why: String(err), provenance: null });
  } finally {
    askInFlight = false;
  }
}

async function submitQuestion(): Promise<void> {
  const input = composerInput();
  const question = input.value.trim();
  if (question.length === 0 || session === null || askInFlight) return;
  input.value = '';
  addTurn('user').append(el('p', undefined, question));
  try {
    renderPreview(question, await window.ledar.askPreview(session, question));
  } catch (err) {
    addTurn('assistant').append(el('p', undefined, String(err)));
  }
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
  // 🟥 The composer carries ONE thing: a question about something that went
  // wrong. Live since 2026-08-28, and disabled until a map exists.
  //
  // It sat inert from 2026-08-27 — a control wired to a no-op is worse than a
  // disabled one, because it looks like it works — and the note left here said
  // S7 would claim it. S6 claimed it first: `interview.ts`'s ban on free text
  // is about ANSWERS the product then acts on, and this is the person asking,
  // which is the one direction free text was always meant to run.
  //
  // ⚠️ It stays disabled until `enableComposer()`. A question with no map to
  // look in has nowhere to go, and offering the field anyway would be inviting
  // somebody to type into a product that cannot yet reply.
  byId('composer', HTMLFormElement).addEventListener('submit', (event) => {
    event.preventDefault();
    if (!askable) return;
    void submitQuestion();
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

  // 🟥 And the interview only answers itself on the run that is ALSO about to
  // quit on its own, which is the one with nobody in it. A developer watching
  // an autoconnecting window still gets to answer five questions.
  //
  // What it presses is the real control — "skip all of this, just go and
  // look" — and not a shortcut past it, because that button IS the honest
  // answer when nobody is there. Without this the smoke line could only ever
  // report `profile=none`: the map is built when the interview ends, and an
  // interview waiting on a person who does not exist never ends.
  devAutoSkip = prefill.autoconnect && prefill.exitWhenProven;
  await startGuide();
  if (guideRefs !== null) {
    guideRefs.input.value = prefill.dsn;
    if (prefill.autoconnect) void submitDsn();
  }
}

bootChrome();
welcome();
void bootDev();
