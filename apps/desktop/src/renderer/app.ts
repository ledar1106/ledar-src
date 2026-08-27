/**
 * One conversation. Screens are states of it, not pages of a router.
 *
 * That sentence is the architecture decision this file exists to embody
 * (_doc/21 §2, AGENTS §4.20 — the compressed brief that lost it produced a
 * twelve-screen wizard). Slice 1 carries two states: the welcome, and S2
 * "Connect safely". Each state appends turns; nothing is replaced, because
 * a conversation is a record — what the assistant said before the proof
 * stays said, and the proof arrives as a new turn under it.
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
  SessionFacts,
  WriteProbeFacts,
} from '../shared/ipc.js';
import { dsnDisplayTarget } from './dsn.js';
import { t } from './i18n.js';

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

// ---- conversation states ---------------------------------------------------

let guideRefs: { input: HTMLInputElement; connect: HTMLButtonElement } | null = null;
let guideStarted = false;
let connecting = false;
let devMode = false;

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
    const line =
      outcome.kind === 'read_only_enforced'
        ? `verdict=${outcome.kind} probe_blocked=${outcome.probe.blocked} headline=${t('proof.enforced.headline')}`
        : `verdict=${outcome.kind}`;
    window.ledar.devReport(line);
  }
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
      byId('composer-input', HTMLInputElement).placeholder = t('composer.next-slice');
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
  });
}

async function bootDev(): Promise<void> {
  const prefill = await window.ledar.devPrefill();
  if (prefill === null) return;
  devMode = true;
  await startGuide();
  if (guideRefs !== null) {
    guideRefs.input.value = prefill.dsn;
    if (prefill.autoconnect) void submitDsn();
  }
}

bootChrome();
welcome();
void bootDev();
