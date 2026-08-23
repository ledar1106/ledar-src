/**
 * Who may talk to the engine — the part of it that has to be right.
 *
 * The endpoints are thin wrappers over `@ledar/store`, which has its own
 * suites. What is new here is a listening socket on the user's machine, and
 * hard rule 7 says what that costs: **127.0.0.1 is not authentication.**
 *
 * So the tests below are about refusal, and the one worth reading twice is
 * DNS rebinding. Every other case is a client getting something wrong; that
 * one is a web page the user merely visited, reaching a port that binding to
 * loopback did nothing to protect, holding a socket that looks entirely
 * normal. The Host header is the only thing that gives it away.
 *
 * These drive the real server over a real socket rather than calling `guard`
 * directly. A guard that is correct and not wired in is the failure this is
 * most likely to have.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { start } from '../src/server.js';

let port = 0;
let token = '';
let stop: () => void = () => {};

before(async () => {
  const engine = await start(0);
  port = engine.port;
  token = engine.token;
  stop = engine.close;
});

after(() => stop());

type Sent = { status: number; body: Record<string, unknown> };

/**
 * One request, with every header controllable.
 *
 * `fetch` sets Host itself and refuses to let it be overridden, which is
 * exactly the header the rebinding test has to lie about — so these tests use
 * a raw socket instead. Reaching for a lower level is the point: an attacker
 * is not using fetch either.
 */
async function send(
  path: string,
  headers: Record<string, string>,
): Promise<Sent> {
  const { connect } = await import('node:net');
  return new Promise((done, fail) => {
    const socket = connect(port, '127.0.0.1', () => {
      const lines = [`GET ${path} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
      lines.push('Connection: close', '', '');
      socket.write(lines.join('\r\n'));
    });
    let raw = '';
    socket.setEncoding('utf8');
    socket.on('data', (c: string) => (raw += c));
    socket.on('error', fail);
    socket.on('end', () => {
      const status = Number(/^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? 0);
      const split = raw.indexOf('\r\n\r\n');
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw.slice(split + 4)) as Record<string, unknown>;
      } catch {
        // A malformed body is itself a failure the assertions will catch.
      }
      done({ status, body });
    });
  });
}

const good = () => ({ Host: `127.0.0.1:${port}`, Authorization: `Bearer ${token}` });

describe('a request that is allowed', () => {
  it('answers /health with the token and a loopback Host', async () => {
    const res = await send('/health', good());
    assert.equal(res.status, 200);
    assert.equal(res.body['ok'], true);
  });

  it('accepts localhost as well as the literal address', async () => {
    const res = await send('/health', { ...good(), Host: `localhost:${port}` });
    assert.equal(res.status, 200);
  });
});

describe('E.1 — the session token', () => {
  it('refuses a request with no Authorization header', async () => {
    const res = await send('/health', { Host: `127.0.0.1:${port}` });
    assert.equal(res.status, 401);
    assert.match(String(res.body['error']), /no session token/);
  });

  it('refuses a token that is merely close', async () => {
    const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const res = await send('/health', { ...good(), Authorization: `Bearer ${wrong}` });
    assert.equal(res.status, 401);
  });

  it('refuses a token sent in the wrong scheme', async () => {
    const res = await send('/health', { ...good(), Authorization: `Basic ${token}` });
    assert.equal(res.status, 401);
  });

  it('never says the token back', async () => {
    // A refusal that quotes what it expected is a refusal that hands over the
    // secret to whoever guessed wrong.
    const res = await send('/health', { Host: `127.0.0.1:${port}` });
    assert.ok(!JSON.stringify(res.body).includes(token));
  });

  it('guards every route, including the one that reads nothing', async () => {
    for (const path of ['/health', '/runs', '/diff', '/nonsense']) {
      const res = await send(path, { Host: `127.0.0.1:${port}` });
      assert.equal(res.status, 401, `${path} answered without a token`);
    }
  });
});

describe('E.2 — Host and Origin', () => {
  it('🟥 refuses a DNS-rebinding Host even WITH the correct token', async () => {
    // The whole reason this check exists. A page at evil.com whose DNS answer
    // is 127.0.0.1 reaches this socket as same-origin; the connection is
    // indistinguishable from a legitimate one at the TCP layer. The browser
    // tells the truth in the Host header, and this is the only place that
    // truth is read.
    const res = await send('/health', { ...good(), Host: `evil.example:${port}` });
    assert.equal(res.status, 403);
    assert.match(String(res.body['error']), /Host is not this loopback address/);
  });

  it('refuses a loopback name on the wrong port', async () => {
    const res = await send('/health', { ...good(), Host: `127.0.0.1:${port + 1}` });
    assert.equal(res.status, 403);
  });

  it('refuses any browser Origin at all, correct token or not', async () => {
    const res = await send('/health', { ...good(), Origin: 'https://example.com' });
    assert.equal(res.status, 403);
    assert.match(String(res.body['error']), /no web page is a client/);
  });

  it('checks Host BEFORE the token', async () => {
    // Ordering matters: a caller under the wrong name must be turned away
    // without the token being compared at all.
    const res = await send('/health', { Host: 'evil.example:1' });
    assert.equal(res.status, 403, 'a bad Host with no token should be 403, not 401');
  });
});

describe('what the engine is bound to', () => {
  it('is not reachable on a non-loopback interface', async () => {
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces())
      .flat()
      .find((n) => n && !n.internal && n.family === 'IPv4');
    if (external === undefined) return; // nothing to prove on this machine

    const { connect } = await import('node:net');
    await new Promise<void>((done) => {
      const socket = connect({ port, host: external.address, timeout: 1500 });
      // Refused or timed out are both the right answer; connecting is not.
      socket.on('error', () => done());
      socket.on('timeout', () => {
        socket.destroy();
        done();
      });
      socket.on('connect', () => {
        socket.destroy();
        assert.fail(`the engine accepted a connection on ${external.address}`);
      });
    });
  });
});
