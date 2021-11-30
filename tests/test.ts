import fetch from 'node-fetch';
import net from 'node:net';
import tape from 'tape';

import {dbInit, startServer} from '../index';

function randomPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Adapted from https://stackoverflow.com/a/28050404/
    var srv = net.createServer(sock => sock.end('Hello world\n'));
    srv.listen(0, function() {
      const addr = srv.address();
      srv.close(() => {
        if (addr && typeof addr === 'object') {
          resolve(addr.port);
        } else {
          reject('address is weird ' + addr);
        }
      })
    });
  });
}

tape('not logged in: show a welcome page', async t => {
  // setup
  const db = dbInit(':memory:');
  const port = await randomPort();
  const {app, server, knex} = await startServer(db, {port, sessionFilename: ':memory:'});

  // the actual test
  const result = await fetch(`http://localhost:` + port);
  t.ok(result.ok, 'fetch found an acceptable HTTP code')
  const payload = await result.text();
  t.ok(payload.includes('Welcome'));

  // teardown
  server.close();
  db.close();
  knex.destroy();

  t.end();
});
