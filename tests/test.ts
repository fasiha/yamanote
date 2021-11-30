import fetch from 'node-fetch';
import net from 'node:net';
import tape from 'tape';

import * as Table from '../DbTablesV3';
import {dbInit, startServer} from '../index';
import {FullRow} from '../pathsInterfaces';

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

tape('login', async t => {
  // setup
  const db = dbInit(':memory:');
  const port = await randomPort();
  const {app, server, knex} = await startServer(db, {port, sessionFilename: ':memory:'});

  // more setup
  const user: FullRow<Table.userRow> = {id: 5, displayName: 'test', githubId: -1};
  const token: Table.tokenRow = {token: 'very-secret-token', userId: user.id, description: ''};
  db.prepare<typeof user>(`insert into user (id, displayName, githubId) values ($id, $displayName, $githubId)`)
      .run(user);
  db.prepare<typeof token>(`insert into token (token, userId, description) values ($token, $userId, $description)`)
      .run(token);

  // the actual test
  const loginstatus = `http://localhost:${port}/loginstatus`;
  {
    const result = await fetch(loginstatus);
    t.ok(!result.ok, 'server refused to talk without credentials')
    t.ok(result.status === 401, 'server returned unauthorized');
  }
  {
    const makeHeader = (token: string, method = 'GET') => ({method, headers: {Authorization: `Bearer ${token}`}});
    const result = await fetch(loginstatus, makeHeader(token.token));
    t.ok(result.ok, 'fetch found an acceptable HTTP code ' + result.status)
  }

  // teardown
  server.close();
  db.close();
  knex.destroy();

  t.end();
});
