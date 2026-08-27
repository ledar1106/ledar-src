/**
 * What a connection string is allowed to look like on screen.
 *
 * The renderer necessarily holds the DSN while the person types it; the rule
 * is that it never travels further than the connect call and never appears
 * in the conversation. The user's own turn shows the target — host, port,
 * database — and nothing that authenticates: no password, and no username
 * either, since usernames turn up in breach lists next to passwords.
 *
 * Pure string functions, no DOM: the test suite runs these under Node.
 */

/** `host:port/database` from a URL-shaped DSN, or null when unparseable. */
export function dsnDisplayTarget(dsn: string): string | null {
  let url: URL;
  try {
    url = new URL(dsn.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;

  const host = url.hostname;
  if (host === '') return null;
  const port = url.port === '' ? '' : `:${url.port}`;
  const database = url.pathname.replace(/^\//, '');
  return database === '' ? `${host}${port}` : `${host}${port}/${database}`;
}
