import sqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import * as express from 'express';
import {readFileSync} from 'fs';
import * as t from 'io-ts';
import {Params, path, Path} from 'static-path';
import {promisify} from 'util';

import * as Table from './DbTables';

type BufferMedia = Omit<Table.mediaRow, 'content'>&{content: Buffer};

const SCHEMA_VERSION_REQUIRED = 1;

type Db = ReturnType<typeof sqlite3>;

function uniqueConstraintError(e: unknown): boolean {
  return e instanceof sqlite3.SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * We need someting like `Selected` because sql-ts emits my tables' `id` as
 * `null|number` because I don't have to specify an `INTEGER PRIMARY KEY` when
 * *inserting*, as SQLite will make it for me. However, when *selecting*, the
 * `INTEGER PRIMARY KEY` field *will* be present.
 *
 * This could also be:
 * ```
 * type Selected<T> = Required<{[k in keyof T]: NonNullable<T[k]>}>|undefined;
 * ```
 * The above says "*All* keys are required and non-nullable". But I think it's
 * better to just use our knowledge that `id` is the only column thus affected,
 * as below. If we ever add more nullable columns, the following is safer:
 */
type Selected<T> = (T&{id: number})|undefined;

export function init(fname: string) {
  const db = sqlite3(fname);

  let s = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`);
  const tableThere = s.get('_yamanote_db_state');

  if (tableThere) {
    // ensure it's the correct version, else bail; implement up/down migration later
    s = db.prepare(`select schemaVersion from _yamanote_db_state`);
    const dbState: Selected<Table._yamanote_db_stateRow> = s.get();
    if (!dbState || dbState.schemaVersion !== SCHEMA_VERSION_REQUIRED) {
      throw new Error('migrations not yet supported');
    }
  } else {
    console.log('uninitialized, will create v1 schema');
    db.exec(readFileSync('db-v1.sql', 'utf8'));
  }
  return db;
}

type MimeContent = Pick<BufferMedia, 'mime'|'content'>;
function getFilename(db: Db, filename: string): MimeContent|undefined {
  return db.prepare(`select mime, content from media where filename=$filename`).get({filename});
}

function startServer(db: Db, port = 3456) {
  // https://github.com/garybernhardt/static-path/issues/5
  type paramify<T> = T extends Path<infer X>? Params<X>: never;

  const filenamePath = path('/media/:filename');

  const app = express.default();
  app.get('/', (req, res) => { res.send('hello world'); });
  app.get(filenamePath.pattern, (req, res) => {
    const filename = (req.params as paramify<typeof filenamePath>).filename;
    if (filename && typeof filename === 'string') {
      const got = getFilename(db, filename);
      if (got) {
        res.contentType(got.mime);
        res.send(got.content);
        return;
      }
    }
    res.status(404).send('nonesuch');
  });
  app.listen(port, () => console.log(`Example app listening at http://localhost:${port}`));
  return app;
}

if (require.main === module) {
  const db = init('yamanote.db');
  const media: Table.mediaRow = {
    filename: 'raw.dat',
    mime: 'text/plain',
    content: Buffer.from([0x62, 0x75, 0x66, 0x66, 0x65, 0x72]),
    createdTime: Date.now(),
    checksumValue: '',
    checksumAlgo: ''
  };
  try {
    db.prepare(`insert into media (filename, content, mime, createdTime, checksumValue, checksumAlgo) 
  values ($filename, $content, $mime, $createdTime, $checksumValue, $checksumAlgo)`)
        .run(media);
  } catch (e) {
    if (!uniqueConstraintError(e)) {
      throw e;
    }
  }
  const all: BufferMedia[] = db.prepare(`select * from media`).all();
  console.dir(all, {depth: null});

  const app = startServer(db);
}