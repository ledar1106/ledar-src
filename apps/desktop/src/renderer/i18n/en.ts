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
  'composer.waiting': 'The conversation opens once a database is connected.',
  'composer.next-slice': 'The six-question interview ships in the next build.',

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

  'next.enforced':
    'That is as far as this build goes. The six-question interview arrives in the next one; connecting again at any time re-proves the answer above.',

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
