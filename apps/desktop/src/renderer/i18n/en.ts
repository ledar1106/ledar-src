/**
 * Every fixed string the desktop shell shows, in English.
 *
 * One file per language from the first commit (_doc/21 §4): adding a
 * language later means adding a sibling file, not sweeping components for
 * text. Copy that already survived the Sol audit in apps/demo/index.html is
 * reused verbatim where the demo had it.
 *
 * Sentences the BACKEND writes — scope lines, privilege disclosures, refusal
 * reasons, Postgres errors — are not here and must never be: they are
 * evidence, and the renderer shows them as received.
 */

export const en = {
  'brand.name': 'LEDAR',
  'brand.word.look': 'Look',
  'brand.word.explain': 'Explain',
  'brand.word.disclose': 'Disclose',
  'brand.word.admit': 'Admit',
  'brand.word.retain': 'Retain',

  'status.label': 'Connection',
  'status.none': 'Not connected',
  'status.enforced': 'Read-only — enforced',
  'status.writable': 'Can still write',
  'status.refused': 'Refused to scan',

  'composer.label': 'Message',
  'composer.send': 'Send',
  // The composer opens for exactly one thing — the rule question, which now
  // comes after the report — so it says that rather than naming a step.
  'composer.waiting': 'This opens when I ask you something.',
  'composer.done': 'Nothing more to type. What you wrote stays in this window and nowhere else.',

  'welcome.lead':
    'I will look at the database you connect, explain what it confirms, and ask before treating an unconfirmed pattern as a problem.',
  'welcome.cta': 'Connect your database',

  'guide.intro':
    'First, give me a role the database itself keeps read-only. Nothing runs on your database from here — I write the SQL, you run it where you already trust.',
  'guide.kicker': 'Connect safely',
  'guide.title': 'Give me a role the database itself keeps read-only.',
  'guide.tag.local': 'Local only',
  'guide.step.1': 'Open the SQL editor your database provider gives you — on Supabase it is called SQL Editor.',
  'guide.step.2': 'Run this script. Replace CHANGE_ME with a password you generate.',
  'guide.step.3': 'Paste the connection string for the new role below.',
  'guide.admit.before':
    'Right now, read-only is only this app’s promise. When you connect, I ask Postgres itself — and show you its answer.',
  'guide.dsn.label': 'Connection string',
  'guide.dsn.hint':
    'It is used to open this connection and kept only in memory — not saved, not sent anywhere else.',
  'guide.dsn.show': 'Show',
  'guide.dsn.hide': 'Hide',
  'guide.connect': 'Connect',
  'guide.error-help': 'I got an error',
  'guide.ask-dev': 'Ask my developer',
  'guide.dev-note':
    'I need help creating a separate Postgres role for LEDAR. It must have CONNECT, USAGE, and SELECT only, with no write or superuser privileges.',

  copy: 'Copy',
  copied: 'Copied',
  'copy.failed': 'Copy failed',
  'announce.copied': 'Copied to the clipboard.',
  'announce.dev-note': 'The message for your developer is on the clipboard.',

  'user.sent': 'Connection string for {target} (password hidden)',
  'user.sent.generic': 'A connection string (details hidden)',

  'checking': 'Connecting, and asking the database what this login may do…',

  'proof.intro': 'I connected and asked Postgres what this login is allowed to do. This is its answer, not mine.',
  'proof.enforced.headline': 'READ-ONLY — ENFORCED BY THE DATABASE',
  'proof.enforced.meta':
    'Not a promise this software makes about itself. Postgres was asked, and Postgres is what refuses the write.',

  'facts.heading': 'What the database says this connection can do',
  'facts.connected-as': 'Connected to {database} as {user}',
  'facts.not-superuser': 'not a superuser',
  'facts.no-bypass-rls': 'does not bypass row level security',
  'facts.no-create': 'cannot create objects in the database',
  'facts.txn-read-only': 'transactions are read-only by default',
  'facts.timeouts': 'statement_timeout {statement} · idle_in_transaction {idle} · lock_timeout {lock}',

  'probe.blocked': 'The write I attempted was rejected by the database:',
  'probe.not-blocked': 'My write probe went through — the database did not stop it.',

  'scope.heading': 'What I was able to look at',
  'revoke.summary': 'Revoke access — keep this handy',

  // S4 — the offer, and the state while it runs.
  //
  // The offer is a turn of its own rather than a button on the proof card:
  // the proof has to be readable before the thing it authorises is offered,
  // and a CTA inside the evidence invites clicking past the evidence.
  // Says what does NOT happen, which is the part that needs saying, and stops
  // short of "every statement is a SELECT" — a scan also opens a read-only
  // transaction and sets its own timeouts, so that sentence would be a
  // flourish this window cannot stand behind (§4.1b).
  'scan.offer.lead':
    'Next I read, and only read. Nothing is written, nothing is removed, and nothing about the structure changes.',
  'scan.offer.body':
    'I look at what that role can see and at nothing else. When it is done I will tell you what it covered, what it could not reach, and what it cost your database to answer.',
  'scan.cta': 'Look at the database now',
  'scan.said': 'Go ahead and look.',
  'scan.working': 'Reading now.',
  // _doc/25 S4 asks for the cost counting up as it goes. There is no channel
  // for that yet, so this says the count is coming rather than letting the
  // absence pass unmentioned — a missing part that goes unsaid is the shape
  // of BROKEN wearing the face of EMPTY.
  'scan.working.meta':
    'I cannot show you a running total while I work — the whole count arrives with the report.',
  'announce.scanning': 'Reading the database now.',
  'announce.report': 'The report is ready.',

  // S5 — the report. Section headings are the contract's own words
  // (packages/contracts/src/messages/en.ts); the screen quoting them
  // differently would be the screen drifting from the contract.
  'report.intro':
    'Here is what I found. The line at the top is the boundary of every sentence under it, and it is printed again at the bottom.',
  'report.scope.label': 'Scope',
  'report.looked-at': 'WHAT I WAS ABLE TO LOOK AT',
  'report.confirms': 'WHAT THE DATABASE ITSELF CONFIRMS',
  'report.patterns': 'PATTERNS WORTH ASKING ABOUT',
  'report.patterns.preamble':
    'Not problems. Things that look like a rule nobody wrote down. I cannot tell a leftover from a decision — only you can.',
  'report.verdict': 'WHAT THIS REPORT WILL AND WILL NOT SUPPORT',
  'report.technical': 'Technical details',

  // The three ways there is no report, all of which have to be told apart
  // from a quiet one (_doc/25 S4: BROKEN must never look like EMPTY).
  'scan.error.headline': 'The scan did not finish.',
  'scan.error.body':
    'What is below is how far it got, and it is not a result. It stopped; it did not come back clean.',
  'scan.no-session.headline': 'I no longer have that connection.',
  'scan.no-session.body':
    'Connect again and the database will be asked to prove the read-only answer before anything else runs.',
  'scan.bridge.headline': 'I could not start the scan.',
  'scan.bridge.body':
    'The window could not reach the part of the app that talks to your database. Nothing ran, and nothing was read.',
  'scan.again': 'Scan again',

  // S3 — one question, and the reason it is one is in interview.ts.
  //
  // The skip is worded as an instruction to the product, never as an
  // admission by the person. The ideal's §13 audit is explicit about why:
  // this is somebody who already feels behind on their own system, and a
  // button that makes them say "I don't know" to use it charges them for
  // the privilege of being helped.
  'interview.intro':
    'There is one thing I cannot work out by reading your database. I can see its shape — what tables exist, what points at what, where values repeat. What I cannot see is what your business needs to be true.',
  'interview.progress': 'Question {n} of {total}',
  'interview.dont-know': 'Nothing comes to mind — just tell me what you find',
  'interview.dont-know.said': 'Nothing comes to mind — just tell me what you find.',
  'interview.answer.placeholder': 'Say it in your own words',
  'interview.too-long':
    'That is longer than I can take in as one answer. Say the shorter version — the part you would tell a new colleague first.',

  'interview.rule.text': 'Is there a rule your business depends on that I should check?',
  'interview.rule.hint':
    'In your own words. Skipping costs you nothing — I will still report what I find.',
  // Three examples, one per shape this product can actually check. They are
  // here to be RECOGNISED rather than composed from nothing: the person this
  // is built for can tell you their business needs something, and struggles
  // to phrase it as a rule. Showing the range after the question is asked
  // also keeps the shapes out of the prompt that produced the answer.
  'interview.rule.examples': 'Rules of this shape are the ones I can check:',
  'interview.rule.example.1': 'Every order belongs to a customer who still exists.',
  'interview.rule.example.2': 'Every member has an email address on file.',
  'interview.rule.example.3': 'No two members share the same email address.',

  // The closing turn. It has to survive the reading a tired person gives it,
  // so it says what happened to the rule sentence in the same breath as what
  // did NOT happen to it.
  'interview.done.heading': 'Noted.',
  'interview.done.kept':
    'That is held in this window and nowhere else — not written to disk, not sent anywhere, and it changed nothing about the database I read.',
  'interview.done.rule.heading': 'You wrote:',
  // 🟥 This line promised the read-back unconditionally until 2026-08-27,
  // when the first real person to reach this screen wrote "a user's credit
  // balance must never go below zero" — a rule that needs a NUMBER, which
  // this product declines rather than approximates. The promise was false
  // for the very first sentence it was ever shown.
  //
  // The limit is disclosed here, AFTER the sentence is written, and that
  // position is deliberate: saying it in the question's hint would teach
  // people to only ask what the product can already answer, and then nobody
  // ever learns what they actually needed.
  // 🟥 Said "is the next build" until this slice. A date is a promise, the
  // read-back is parked behind an audit (`_doc/26` §0b), and HANDOFF-STATUS
  // lists removing that promise as work in its own right. What is true is
  // narrower and is what it says now: this build does not do it.
  'interview.done.rule.next':
    'Turning that sentence into a check is not something this build does, and it may turn out I cannot. What I am able to check is narrow: values that must point at something real, must not be missing, or must not repeat. A rule about an amount, about when something happened, or about what a value means to your business is one I will turn down rather than approximate.',
  'interview.done.rule.then':
    'Either way you see it before anything runs. If I can check it, I will say back exactly which table and which column I am about to look at, and wait for you to confirm. If I cannot, I will say so and say why. Nothing has run and nothing has been sent.',
  'interview.done.no-rule':
    'No rule then, and that costs you nothing here — everything I check by default, I check anyway. A rule only adds one more thing to the list.',

  'next.enforced':
    'That answer holds until the database itself changes; connecting again at any time re-proves it.',

  'writable.headline': 'READ-ONLY IS NOT ENFORCED BY THE DATABASE',
  'writable.body':
    'I will not present this connection as database-enforced. Remove the write privileges, connect again, and let Postgres prove the result again.',
  'writable.list': 'Where writes are still allowed:',
  'writable.more': '… and {n} more',
  'writable.fix': 'Run this to remove the write privileges, then connect again:',

  'refused.headline': 'I will not scan with this login',
  'refused.fix': 'Run this as a user that can create roles, then connect with the new role:',

  'error.headline': 'I could not connect.',
  'help.lead': 'Three things worth checking before anything else:',
  'help.1': 'The password in the connection string is the one you set in the CREATE ROLE script.',
  'help.2': 'The host and port are the ones your provider shows for direct connections.',
  'help.3': 'Some providers require ?sslmode=require at the end of the connection string.',

  'try-again': 'Try again',
} as const;
