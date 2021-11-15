import sqlite3 from 'better-sqlite3';
import crypto from 'crypto';
import * as express from 'express';
import FormData from 'form-data';
import {string} from 'fp-ts';
import {readFileSync} from 'fs';
import * as t from 'io-ts';
import multer from 'multer';
import {Params, path, Path} from 'static-path';
import {URL} from 'url';
import {promisify} from 'util';

import * as Table from './DbTables';
import * as i from './pathsInterfaces';

const SCHEMA_VERSION_REQUIRED = 1;

type Db = ReturnType<typeof sqlite3>;
let ALL_BOOKMARKS = '';

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
  db.pragma('journal_mode = WAL'); // https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/performance.md
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
  allBookmarksRender(db);
  return db;
}

type MimeContent = Pick<Table.mediaRow, 'mime'|'content'>;
function getFilename(db: Db, filename: string): MimeContent|undefined {
  return db.prepare(`select mime, content from media where filename=$filename`).get({filename});
}

function allBookmarksRender(db: Db) {
  const res = db.prepare(`select group_concat(render, '\n') as renders from bookmark order by modifiedTime desc`).get();
  const js = readFileSync('bookmarklet.js', 'utf8');
  ALL_BOOKMARKS = `<p><a href="javascript:${js}">山手</a></p>` + (res.renders || '');
}

function addCommentToBookmark(db: Db, comment: string, bookmarkId: number|bigint): string {
  const now = Date.now();

  const firstInsert =
      db.prepare(`insert into comment (bookmarkId, content, createdTime, modifiedTime, render, renderedTime) 
  values ($bookmarkId, $content, $createdTime, $modifiedTime, $render, $renderedTime)`);
  const secondUpdate = db.prepare(`update comment set render=$render, renderedTime=$renderedTime where id=$id`);

  let commentRender = '';

  const commentTransaction = db.transaction((commentRow: Table.commentRow) => {
    const result = firstInsert.run(commentRow);
    const id = result.lastInsertRowid;
    const now = new Date();
    commentRender = `<pre id="comment-${id}" class="unrendered">${comment}

${now.toISOString()}</pre>`;
    secondUpdate.run({id, render: commentRender, renderedTime: now.valueOf()});
  });
  const commentRow: Table.commentRow = {
    bookmarkId: bookmarkId,
    content: comment,
    createdTime: now,
    modifiedTime: now,
    render: '',
    renderedTime: now,
  };
  commentTransaction(commentRow);

  return commentRender;
}

function bodyToBookmark(db: Db, body: Record<string, string>): string {
  const {url, title, comment} = body;
  if (typeof url === 'string' && typeof title === 'string') {
    if (url || title) {
      // I need at least one of these to be non-empty

      // optimization possibiity: don't get `render` if no `comment`
      const bookmark: {count: number, id: number|null, render: string|null} =
          db.prepare(`select count(*) as count, id, render from bookmark where url=$url and title=$title`)
              .get({title, url})

      // There's a bookmark already
      if (bookmark.count > 0 && typeof bookmark.id === 'number' && typeof bookmark.render === 'string') {
        const now = Date.now();
        if (typeof comment === 'string') {
          const commentRender = addCommentToBookmark(db, comment, bookmark.id);
          const breakStr = '\n';
          const newline = bookmark.render.indexOf(breakStr);
          if (newline < 0) {
            throw new Error('no newline in render ' + bookmark.id);
          }
          // RERENDER: assume first line is the bookmark stuff, and after newline, we have comments
          const newRender = bookmark.render.substring(0, newline + breakStr.length) + commentRender + '\n';
          const now = Date.now();
          db.prepare(`update bookmark set render=$render, renderedTime=$renderedTime, modifiedTime=$modifiedTime`)
              .run({render: newRender, renderedTime: now, modifiedTime: now})
        } else {
          // no comment, just bump the modifiedTime: we're not rendering this anywhere (yet)
          db.prepare(`update bookmark set modifiedTime=$modifiedTime`).run({modifiedTime: Date.now()});
        }
      }
      else {
        // brand new bookmark!
        let now = Date.now();
        const bookmarkRow: Table
            .bookmarkRow = {userId: -1, url, title, createdTime: now, modifiedTime: now, render: '', renderedTime: now};
        const insertResult =
            db.prepare(`insert into bookmark (userId, url, title, createdTime, modifiedTime, render, renderedTime)
          values ($userId, $url, $title, $createdTime, $modifiedTime, $render, $renderedTime)`)
                .run(bookmarkRow)
        let render = '';
        {
          let commentRender = '';
          if (comment) {
            commentRender = addCommentToBookmark(db, comment, insertResult.lastInsertRowid)
          }
          let header = '';
          if (url && title) {
            let urlsnippet = '';
            try {
              const urlobj = new URL(url);
              urlsnippet = ` <small class="url-snippet">${urlobj.hostname}</small>`;
            } catch {}
            header = `<a href="${url}">${title}</a>${urlsnippet}`;
          } else if (url) {
            header = `<a href="${url}">${url}</a>`;
          } else if (title) {
            header = title;
          }
          render = `<div id="bookmark-${insertResult.lastInsertRowid}">${header}
${commentRender}
</div>`;
        }
        now = Date.now();
        db.prepare(`update bookmark set render=$render, renderedTime=$renderedTime, modifiedTime=$modifiedTime`)
            .run({render: render, renderedTime: now, modifiedTime: now})
      }
      allBookmarksRender(db);
      return '';
    }
    return 'need url OR title'
  }
  return 'need `url` and `title` as strings'
}

function startServer(db: Db, port = 3456, fieldSize = 1024 * 1024 * 20, maxFiles = 10) {
  const upload = multer({storage: multer.memoryStorage(), limits: {fieldSize}});

  const app = express.default();
  app.use(require('cors')());
  app.use(require('body-parser').json());
  app.get('/', (req, res) => { res.send(ALL_BOOKMARKS); });

  // bookmarks
  app.post(i.bookmarkPath.pattern, (req, res) => {
    console.log('POST! ', req.body);
    if (!req.body) {
      res.status(400).send('post json');
      return;
    }
    const err = bodyToBookmark(db, req.body);
    if (!err) {
      res.send('thx');
      return;
    }
    res.status(400).send(err);
  });

  // media
  app.post(i.mediaPath.pattern, upload.array('files', maxFiles), (req, res) => {
    const files = req.files;
    if (files && files instanceof Array) {
      const ret: Record<string, number> = {};
      const createdTime = Date.now();
      const insertStatement = db.prepare(
          `insert into media (filename, content, mime, numBytes, createdTime) values ($filename, $content, $mime, $numBytes, $createdTime)`);

      for (const file of files) {
        const media: Table.mediaRow =
            {filename: file.originalname, mime: file.mimetype, content: file.buffer, numBytes: file.size, createdTime};
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
  function clean(x: Table.mediaRow) {
    if (x.mime.includes('text/plain')) {
      x.content = x.content.toString();
    }
    return x;
  }

  const db = init('yamanote.db');
  const media: Table.mediaRow = {
    filename: 'raw.dat',
    mime: 'text/plain',
    content: Buffer.from([0x62, 0x75, 0x66, 0x66, 0x65, 0x72]),
    createdTime: Date.now(),
    numBytes: 6,
  };
  try {
    db.prepare(
          `insert into media (filename, content, mime, numBytes, createdTime) values ($filename, $content, $mime, $numBytes, $createdTime)`)
        .run(media);
  } catch (e) {
    if (!uniqueConstraintError(e)) {
      throw e;
    }
  }
  const all: Table.mediaRow[] = db.prepare(`select * from media`).all();
  console.dir(all.map(clean), {depth: null});

  const port = 3456;
  const app = startServer(db, port);

  {
    const form = new FormData();
    const contentType = "text/plain";
    for (const name of 'a,b,c'.split(',')) {
      const txt = name === 'a' ? 'fileA contents' : name === 'b' ? 'fileBBB' : 'c';
      form.append('files', Buffer.from(txt), {filename: `file${name}.txt`, contentType, knownLength: txt.length});
    }
    const url = `http://localhost:${port}${i.mediaPath({})}`;
    form.submit(url, (err, res) => {
      if (err) {
        console.error('error!', err)
      } else {
        {
          // via https://stackoverflow.com/a/54025408
          let reply = '';
          res.on('data', (chunk) => { reply += chunk; });
          res.on('end', () => { console.log({reply: JSON.parse(reply)}); });
        }
        const all: Table.mediaRow[] = db.prepare(`select * from media`).all();
        console.dir(all.map(clean), {depth: null});
      }
    });
  }
}