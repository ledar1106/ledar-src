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

  // S3 — the five questions, ideal §14-§18.
  //
  // 🟥 Everything here replaced a single free-text question on 2026-08-27.
  // `interview.ts` holds the account of what that reading of VS-6 cost. The
  // rule these strings live under: every question is answerable by LOOKING at
  // a screen, never by understanding a schema. The six that came before asked
  // things like "what does a customer expect after an ORDER", and two of six
  // were unanswerable for the first real person because both assumed they
  // sell things.
  //
  // The skip is worded as an instruction to the product, never as an
  // admission by the person. The ideal's §13 audit is explicit about why:
  // this is somebody who already feels behind on their own system, and a
  // button that makes them say "I don't know" to use it charges them for the
  // privilege of being helped.
  'interview.intro':
    'Five quick questions, and none of them need you to know how anything works — just whether it is there. Skip any of them, or all of them, and I will go and look for myself.',
  'interview.progress': 'Question {n} of {total}',

  // The three answers. Peers, in reading order, and the third is not a faded
  // afterthought — see the note above.
  'interview.yes': 'Yes',
  'interview.no': 'No',
  'interview.dont-know': 'I do not know — go and find out',
  'interview.skip-all': 'Skip all of this — just go and look',
  'interview.skip-all.said': 'Skip the rest — go and look.',
  'interview.confirm': 'That is the lot',
  'interview.picked.none': 'Yes, but none of those',
  // Unreachable by clicking; see `applyAnswer`. A sentence rather than a
  // silent no-op, because the only ways to get here are a bug or a console.
  'interview.unknown-option':
    'That is not one of the options I offered, so I have not recorded it. Nothing changed.',

  // The five questions. Each asks about presence, not about design.
  'interview.area.auth': 'Does your system log people in?',
  'interview.area.database': 'Does your system have a database?',
  'interview.area.payment': 'Does your system take payments?',
  'interview.area.storage': 'Does your system store files or images?',
  'interview.area.jobs': 'Does anything run on a schedule, a queue, or in the background?',

  // The follow-up, shown only after a yes. "Which" rather than "what", because
  // the answer is a recognition from a short list rather than a description.
  'interview.which.auth': 'Which one? Tick anything that applies.',
  'interview.which.database': 'Which one? Tick anything that applies.',
  'interview.which.payment': 'Which one? Tick anything that applies.',
  'interview.which.storage': 'Which one? Tick anything that applies.',
  // §18 offers no list. The key exists so the five areas stay symmetrical in
  // this catalogue and a future list has somewhere to land.
  'interview.which.jobs': 'Which one? Tick anything that applies.',

  // Option labels. Product names as their makers write them — this is the one
  // place in the catalogue where matching somebody else's capitalisation
  // matters more than matching ours, because the person is scanning for a
  // word they have seen in their own dashboard.
  'interview.option.supabase_auth': 'Supabase Auth',
  'interview.option.firebase_auth': 'Firebase Auth',
  'interview.option.auth0': 'Auth0',
  'interview.option.clerk': 'Clerk',
  'interview.option.postgresql': 'PostgreSQL',
  'interview.option.mysql': 'MySQL',
  'interview.option.mongodb': 'MongoDB',
  'interview.option.supabase': 'Supabase',
  'interview.option.firebase': 'Firebase',
  'interview.option.sqlite': 'SQLite',
  'interview.option.redis': 'Redis',
  'interview.option.stripe': 'Stripe',
  'interview.option.paypal': 'PayPal',
  'interview.option.vnpay': 'VNPay',
  'interview.option.momo': 'MoMo',
  'interview.option.bank_transfer': 'Bank transfer',
  'interview.option.supabase_storage': 'Supabase Storage',
  'interview.option.s3': 'Amazon S3',
  'interview.option.cloudflare_r2': 'Cloudflare R2',
  'interview.option.local_disk': 'Files on the server itself',
  'interview.option.custom': 'Something built in-house',
  'interview.option.other': 'Something else',
  'interview.option.dont_know': 'I do not know',

  // The closing turn.
  //
  // 🟥 It says what has NOT happened as loudly as what has. The version this
  // replaced promised a read-back screen "in the next build", which was a
  // date dressed as a feature — and the screen it promised is parked behind
  // an audit. Nothing here promises anything that does not exist yet.
  // The interview could not fetch its questions. The report is untouched by
  // this — it was written before the interview ran — so the sentence says
  // what was lost and nothing more alarming than that.
  'interview.unavailable':
    'I could not load my questions just now. Nothing above is affected — that came from your database, not from me.',

  'interview.done.heading': 'Noted.',
  // 🟥 The disk claim that used to be here is gone, and its going is the
  // point. What you say now LEAVES the window: it goes to the part of the app
  // that did the reading, because that is where the two halves can be put
  // side by side. A window cannot see what the other side does with it, so it
  // may not go on promising on the other side's behalf — §4.1b, a sentence on
  // screen that no measurement produced. What it can still vouch for is that
  // nothing leaves the machine, which is hard rule ⑥ and a property of the
  // product rather than of this call.
  'interview.done.kept':
    'You answered {n} of them. None of it leaves this machine, and none of it changed anything about the database I read.',
  'interview.done.nothing-said':
    'Nothing to record, and nothing lost. Going and looking is the part I am better at anyway.',
  'interview.done.next':
    'Now I put that beside what I saw for myself while I was reading.',

  // ---- the map — ideal §22 (the ladder) and §23 (the Project Profile) ----
  //
  // The screen ideal §12's audit asked for, in its own words: *scan first,
  // show what was found, and let them press yes*. Every sentence below is
  // written so that a person who does not understand a backend can judge it
  // by RECOGNISING something, never by knowing something.
  //
  // Two admissions are load-bearing and `apps/desktop/test/i18n.test.ts`
  // pins them: `profile.method` (this was built from names, not from data)
  // and `profile.no-path` (a yes can be recorded here, a no cannot yet).
  // They are what answers `_doc/25`'s two questions for this screen —
  // *where have I not looked* and *where do I not know*.
  'profile.intro':
    'That is the map. For each area it says how I know what I know — whether you told me, whether I saw it myself, or whether nobody has said and nothing has shown.',
  'profile.conflicts.heading': 'WHERE WHAT YOU TOLD ME AND WHAT I SAW DO NOT MEET',
  'profile.areas.heading': 'AREA BY AREA',

  // The areas as things rather than as questions. `interview.area.*` asks;
  // these name. The same word twice would make one of the two wrong: a
  // heading that reads "Does your system log people in?" above a card that
  // has already answered it is the product asking after it knows.
  'profile.area.auth': 'Logging people in',
  'profile.area.database': 'A database',
  'profile.area.payment': 'Taking payments',
  'profile.area.storage': 'Storing files or images',
  'profile.area.jobs': 'Work that runs on its own',

  // The rung, named on the card. `_doc/25` 3.3 ① — meaning never lives in
  // colour alone, so every rung says out loud which one it is.
  'profile.state.unknown': 'NOTHING SAID, NOTHING SEEN',
  'profile.state.stated': 'YOU TOLD ME',
  'profile.state.suspected': 'I MAY HAVE SEEN THIS',
  'profile.state.observed': 'I SAW THIS',
  'profile.state.verified': 'YOU CONFIRMED THIS',

  'profile.state.unknown.body':
    'Nobody has said, and nothing I read pointed at it. That is where every area starts, and it is a gap in what I know rather than one in your system.',
  'profile.state.stated.body':
    'Nothing in what I was able to read pointed at this either way, so your answer is all I have on it.',
  // Must read as a question and never as news — hard rule ③, and the whole
  // reason `suspected` is a rung of its own rather than a weaker `observed`.
  'profile.state.suspected.body':
    'I saw something that could mean this and could just as easily mean something else. Is this right?',
  'profile.state.observed.body':
    'I saw this for myself while I was reading. Here is where, and what made me read it that way.',
  'profile.state.verified.body':
    'You looked at what I found and said it was right. This is the only thing on this map that is settled.',

  // What they said, kept beside what was seen so the two can be compared.
  'profile.said.yes': 'You said: yes.',
  'profile.said.no': 'You said: no.',
  'profile.said.dont_know': 'You said you did not know, and asked me to find out.',
  // 🟥 What they said yes ABOUT. Held by the contract since the questions
  // were written and shown to nobody until 2026-08-28 — so the card said
  // "You said: yes" and a person had no way to see, or correct, the answer
  // the product was actually holding. §24: a profile is meant to be edited.
  'profile.said.picked': 'You picked: {items}.',

  'profile.evidence.heading': 'Where I saw it',
  'profile.confirm': 'Yes, that is right',
  'profile.confirm.failed':
    'I could not record that just now, so nothing changed. The button is back if you want to try again.',
  'announce.profile': 'The map is ready.',
  'announce.profile.confirmed': '{area} is now settled.',

  // 🟥 The two directions of a disagreement, and they are not phrased alike.
  //
  // One is about their system and is the most valuable thing the map holds.
  // The other is about the edge of what this product can see, and the day it
  // reads as an accusation is the day the product has mistaken the edge of
  // its own vision for the edge of the world (`conflictsIn`, contracts).
  'profile.conflict.said_no_found_yes.headline': 'You said no. I found it anyway.',
  'profile.conflict.said_no_found_yes.body':
    'This is the one thing here you could not have asked me about, because you did not know it was there. Nothing about it says anything is broken — it says your system has a part in it that was not on your list.',
  'profile.conflict.said_yes_found_no.headline': 'You said yes. I could not see it.',
  'profile.conflict.said_yes_found_no.body':
    'That is about how far I can see, not about whether you are right. I read one database and nothing else, so anything that lives outside it is invisible to me. Take this as my gap and not your mistake.',

  // §24 — a profile is meant to be edited, and a version is what makes an
  // edit something a person can date and order.
  'profile.version':
    'This map is version {n}. It is not the last word: it changes when you confirm something, and again the next time I read.',
  'profile.method':
    'I built this from the names of the schemas, tables and columns your role let me see. I did not read a single row of your data to do it — and a name is not proof, which is why anything I am unsure of is asked rather than announced.',
  'profile.no-path':
    'If I have something wrong here, I have nowhere to put that yet. I can record that you agreed; I cannot yet record that you did not.',
  'profile.unavailable':
    'I could not put what you told me beside what I saw. Nothing above is affected — the report came from your database before any of this ran.',

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

  // ---- S6: ask a question, and what a database can say back ---------------
  //
  // 🟥 Four headlines and no two alike, for the reason `_doc/25` S5 gives
  // about verdicts: one reader in five read a near-empty report as "most of
  // it is fine". A timeline that found nothing has exactly that shape.
  'ask.placeholder': 'Ask about one thing that went wrong. "A customer paid and cannot see their order."',
  'ask.send': 'Show me what would be sent',
  'ask.confirm': 'Send it',
  'ask.cancel': 'Do not send',
  'ask.no-key': 'No model is configured, so nothing can be asked yet. This build has no key for the service that reads your question, and LEDAR will not invent one.',
  'ask.no-scan': 'Nothing has been read from your database yet, so there is no map to look in. Connect and scan first.',

  'ask.leaving.head': 'Before anything leaves this machine',
  'ask.leaving.dest': 'goes to {destination}',
  'ask.leaving.names': '{count} of your table names',
  'ask.leaving.bytes': '{bytes} bytes of your content, in two calls',
  'ask.leaving.rows': 'no rows from any table',
  'ask.leaving.refuse': 'This question cannot be sent as one decision, so it will not be sent at all.',

  // The four answers. Each says what it IS, never how worried to be.
  'ask.walked': 'Here is what happened, in the order the clock recorded it.',
  'ask.broke': 'The chain stops at {entity}.',
  'ask.nothing': 'I found nothing at all for this subject — which is not the same as finding that nothing is wrong.',
  'ask.outside': 'A database cannot answer this one. Here is what it would take.',

  // Three absences, three sentences. Merging them sends half the readers to
  // fix the wrong thing.
  'ask.gap.unreached': 'never asked — the chain stopped before here',
  'ask.gap.unwalkable': 'cannot be asked — the map records no columns to join on',
  'ask.gap.unaffordable': 'not asked — this answer reached what it is allowed to spend',

  'ask.outside.head': 'What a database cannot tell you about this',
  // 🟥 Two keys, because one read "1 other subjects show the same break" on
  // screen. `t()` substitutes parameters and does not inflect, so a single
  // string cannot be right for both counts — and a sentence with a visible
  // grammar mistake in it is a sentence a reader trusts less, which is the
  // one thing this product cannot afford in an admission.
  'ask.similar.one': '1 other subject shows the same break',
  'ask.similar.many': '{count} other subjects show the same break',
  // Counted and found none. NOT the same as nobody counting — `similar` is
  // null for that, and this line is never reached then.
  'ask.similar.none': 'No other subject shows the same break',
  'ask.hop': '{entity} — {rows} rows via {via}',
  'ask.untimed': 'no time recorded',
  'ask.tier': 'worth its weakest hop: {tier}',
} as const;
