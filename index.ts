import sqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import * as express from 'express';
import {string} from 'fp-ts';
import {readFileSync} from 'fs';
import * as t from 'io-ts';
import multer from 'multer';
import fetch, {RequestInit} from 'node-fetch';
import {Params, path, Path} from 'static-path';
import {promisify} from 'util';

import * as Table from './DbTables';
import * as i from './pathsInterfaces';

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

type MimeContent = Pick<i.BufferMedia, 'mime'|'content'>;
function getFilename(db: Db, filename: string): MimeContent|undefined {
  return db.prepare(`select mime, content from media where filename=$filename`).get({filename});
}

function startServer(db: Db, port = 3456, fieldSize = 1024 * 1024 * 20, maxFiles = 10) {
  const upload = multer({storage: multer.memoryStorage(), limits: {fieldSize}});

  const app = express.default();
  app.use(require('body-parser').json());
  app.get('/', (req, res) => { res.send('hello world'); });
  app.put(i.mediaPath.pattern, upload.array('files', maxFiles), (req, res) => {
    const files = req.files;
    if (files && files instanceof Array) {
      const ret: Record<string, number> = {};
      const createdTime = Date.now();
      const insertStatement = db.prepare(
          `insert into media (filename, content, mime, size, createdTime) values ($filename, $content, $mime, $size, $createdTime)`);

      for (const file of files) {
        const media: i.BufferMedia =
            {filename: file.filename, mime: file.mimetype, content: file.buffer, size: file.size, createdTime};
        try {
          const insert = insertStatement.run(media);
          ret[media.filename] = insert.changes >= 1 ? 200 : 500;
        } catch (e) {
          if (uniqueConstraintError(e)) {
            ret[media.filename] = 409;
          } else {
            throw e;
          }
        }
      }
      res.json(ret);
      return;
    }
    res.status(400).send('need files');
  });
  app.get(i.filenamePath.pattern, (req, res) => {
    const filename = (req.params as i.paramify<typeof i.filenamePath>).filename;
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
    size: 6,
  };
  try {
    db.prepare(
          `insert into media (filename, content, mime, size, createdTime) values ($filename, $content, $mime, $size, $createdTime)`)
        .run(media);
  } catch (e) {
    if (!uniqueConstraintError(e)) {
      throw e;
    }
  }
  const all: i.BufferMedia[] = db.prepare(`select * from media`).all();
  console.dir(all, {depth: null});

  const port = 3456;
  const app = startServer(db, port);
}