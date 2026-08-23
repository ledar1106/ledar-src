/**
 * Starts the engine and says how to reach it.
 *
 * The token is printed once, to stdout, and kept nowhere else. Written to a
 * file it becomes a secret with a lifetime and a path somebody has to
 * remember to delete; printed, it belongs to whoever started the process and
 * dies with the terminal.
 */

import { start } from './server.js';

start().then(({ port, token }) => {
  console.log('');
  console.log('  LEDAR engine — listening on 127.0.0.1 only');
  console.log('');
  console.log(`    port   ${port}`);
  console.log(`    token  ${token}`);
  console.log('');
  console.log('  Every request needs both, and a loopback Host header:');
  console.log('');
  console.log(`    curl -H "Authorization: Bearer <token>" http://127.0.0.1:${port}/health`);
  console.log('');
  console.log('  The token is a secret for as long as this process runs. It is not');
  console.log('  written to disk. Ctrl-C ends it.');
  console.log('');
});
