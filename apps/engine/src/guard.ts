/**
 * Who is allowed to talk to a local engine — HS-E E.1 and E.2.
 *
 * Hard rule 7 of AGENTS.md: **127.0.0.1 is not authentication.** Anything
 * running as the user can reach a loopback port, and so, through a browser,
 * can any web page they happen to have open. A local HTTP server with no
 * further check is a hole in the machine, not a private channel.
 *
 * Three defences, and they answer three different attackers:
 *
 * ① BIND to 127.0.0.1, never 0.0.0.0
 *      Answers: the other machines on the coffee-shop wifi.
 *
 * ② HOST and ORIGIN headers must be loopback
 *      Answers **DNS rebinding**, which is the attack that makes ① and the
 *      token together still insufficient on their own. A page at evil.com
 *      whose DNS answer is 127.0.0.1 reaches the port as same-origin — the
 *      browser believes it is talking to evil.com and sends
 *      `Host: evil.com:PORT`. Nothing about the socket looks wrong. The Host
 *      header is what gives it away, because the browser tells the truth
 *      about which name it resolved.
 *
 * ③ SESSION TOKEN, compared in constant time
 *      Answers: any other process on the machine that finds the port.
 *
 * Each covers what the others miss. The token alone loses to a rebinding page
 * that first reads the token from somewhere; the header check alone loses to
 * a native process; the bind alone loses to both.
 *
 * ## Why an Origin header is refused outright, for now
 *
 * A browser attaches `Origin` to cross-site requests. Nothing that legitimately
 * talks to this engine today is a browser: there is one command-line client and
 * no UI. So the correct rule right now is the strictest one — *any* Origin at
 * all means a web page is calling, and no web page should be.
 *
 * When a real UI arrives it will have an origin of its own, and this is the
 * function that has to be told about it. Loosening it before that point would
 * be widening a hole to fit a caller that does not exist.
 */

import { timingSafeEqual } from 'node:crypto';

export type Verdict =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: string };

/**
 * The names a loopback caller is allowed to have used.
 *
 * `[::1]` is included because a client resolving `localhost` on a
 * dual-stack machine may reach the v4 socket having written the v6 name.
 */
function loopbackHosts(port: number): Set<string> {
  return new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
}

/**
 * Constant-time comparison that does not leak length either.
 *
 * `timingSafeEqual` throws when the two buffers differ in size, and catching
 * that to `return false` would answer "wrong length" faster than "wrong
 * bytes". Hashing both to a fixed width first removes the difference. The
 * length of a session token is not a secret worth much, but writing the
 * comparison the careless way here is how the same pattern reaches somewhere
 * it matters.
 */
function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still do a comparison of equal-width buffers so the failure costs the
    // same as a wrong-bytes failure.
    const pad = Buffer.alloc(Math.max(left.length, right.length));
    const other = Buffer.alloc(pad.length);
    left.copy(pad);
    right.copy(other);
    timingSafeEqual(pad, other);
    return false;
  }
  return timingSafeEqual(left, right);
}

export type Request = {
  /** Lower-cased header names, as `node:http` supplies them. */
  headers: Record<string, string | string[] | undefined>;
};

function header(req: Request, name: string): string | null {
  const value = req.headers[name];
  if (value === undefined) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/**
 * Decides whether one request may proceed.
 *
 * Host and Origin are checked BEFORE the token. A request arriving under the
 * wrong name is refused without the token ever being compared, so a page that
 * has somehow learned the token still cannot use it from off-origin.
 */
export function guard(req: Request, port: number, token: string): Verdict {
  const host = header(req, 'host');
  if (host === null) {
    return { ok: false, status: 403, reason: 'no Host header' };
  }
  if (!loopbackHosts(port).has(host.toLowerCase())) {
    // The DNS-rebinding case lands here, and it is the reason this check is
    // not redundant with binding to loopback.
    return { ok: false, status: 403, reason: 'Host is not this loopback address' };
  }

  const origin = header(req, 'origin');
  if (origin !== null) {
    return {
      ok: false,
      status: 403,
      reason: 'a browser origin called; no web page is a client of this engine',
    };
  }

  const auth = header(req, 'authorization');
  if (auth === null) {
    return { ok: false, status: 401, reason: 'no session token' };
  }
  const prefix = 'Bearer ';
  if (!auth.startsWith(prefix)) {
    return { ok: false, status: 401, reason: 'session token must be sent as a Bearer token' };
  }
  if (!secretEquals(auth.slice(prefix.length), token)) {
    return { ok: false, status: 401, reason: 'session token does not match' };
  }

  return { ok: true };
}
