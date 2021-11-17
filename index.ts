import sqlite3 from 'better-sqlite3';
import * as express from 'express';
import FormData from 'form-data';
import {readFileSync} from 'fs';
import {encode} from 'html-entities';
import multer from 'multer';
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
type Selected<T> = (T&{id: number | bigint})|undefined;

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
  cacheAllBookmarks(db);
  return db;
}

type MimeContent = Pick<Table.mediaRow, 'mime'|'content'>;
function getFilename(db: Db, filename: string): MimeContent|undefined {
  return db.prepare(`select mime, content from media where filename=$filename`).get({filename});
}

function cacheAllBookmarks(db: Db) {
  const res: Pick<Table.bookmarkRow, 'render'>[] =
      db.prepare(`select render from bookmark order by modifiedTime desc`).all();
  const renders = res.map(o => o.render).join('\n');
  const js = readFileSync('bookmarklet.js', 'utf8');
  const prelude = readFileSync('prelude.html', 'utf8') +
                  `<p>Bookmarklet: <a href="javascript:${
                      js}">山の手</a>. Code: <a href="https://github.com/fasiha/yamanote">GitHub</a></p>`;
  ALL_BOOKMARKS = prelude + (renders || '');
}

function rerenderComment(db: Db, idOrComment: NonNullable<Selected<Table.commentRow>>|(number | bigint)): string {
  let id: number|bigint;
  let comment: Table.commentRow;
  if (typeof idOrComment === 'object') {
    id = idOrComment.id;
    comment = idOrComment;
  } else {
    id = idOrComment;
    comment = db.prepare(`select * from comment where id=$id`).get({id: idOrComment});
  }

  let anchor = `comment-${id}`;
  let timestamp = `<a href="#${anchor}">${(new Date(comment.createdTime)).toISOString()}</a>`;
  if (comment.createdTime !== comment.modifiedTime) {
    const mod = (new Date(comment.modifiedTime)).toISOString();
    timestamp += ` → ${mod}`;
  }

  const render =
      `<div id="${anchor}" class="comment"><pre class="unrendered">${encode(comment.content)}</pre> ${timestamp}</div>`;
  db.prepare(`update comment set render=$render, renderedTime=$renderedTime where id=$id`)
      .run({id, render, renderedTime: Date.now()});
  return render;
}

function addCommentToBookmark(db: Db, comment: string, bookmarkId: number|bigint): string {
  const now = Date.now();
  const commentRow: Table.commentRow = {
    bookmarkId: bookmarkId,
    content: comment,
    createdTime: now,
    modifiedTime: now,
    render: '',       // will be overwritten later in this function, by `rerenderComment`
    renderedTime: -1, // again, will be overwritten
  };
  const result = db.prepare(`insert into comment (bookmarkId, content, createdTime, modifiedTime, render, renderedTime) 
  values ($bookmarkId, $content, $createdTime, $modifiedTime, $render, $renderedTime)`)
                     .run(commentRow);
  return rerenderComment(db, {...commentRow, id: result.lastInsertRowid})
}

function encodeTitle(title: string): string {
  return encode(title.replace(/[\n\r]+/g, '↲')); // alternatives include pilcrow, ¶
}

// as in, don't recurse into comments to render those: assume those are fine.
function rerenderJustBookmark(db: Db, idOrBookmark: (number|bigint)|NonNullable<Selected<Table.bookmarkRow>>,
                              preexistingRenders?: {render: string}[]) {
  const bookmark: Table.bookmarkRow = typeof idOrBookmark === 'object'
                                          ? idOrBookmark
                                          : db.prepare(`select * from bookmark where id=$id`).get({id: idOrBookmark})
  const id = typeof idOrBookmark === 'object' ? idOrBookmark.id : idOrBookmark;
  if (!bookmark) {
    throw new Error('unknown bookmark ' + idOrBookmark);
  }
  const {url, title} = bookmark;
  const anchor = `bookmark-${id}`;

  let header = '';
  if (url && title) {
    let urlsnippet = '';
    try {
      const urlobj = new URL(url);
      urlsnippet = ` <small class="url-snippet">${urlobj.hostname}</small>`;
    } catch {}
    header = `<a href="${url}">${encodeTitle(title)}</a>${urlsnippet}`;
  } else if (url) {
    header = `<a href="${url}">${url}</a>`;
  } else if (title) {
    header = encodeTitle(title);
  }
  header += ` <a href="#${anchor}" class="emojilink">🔗</a>`

  let commentsRender = '';
  if (!preexistingRenders) {
    const rows = db.prepare(`select render from comment where bookmarkId=$id order by createdTime desc`).all({id});
    commentsRender = rows.map(o => o.render).join('\n');
  } else {
    commentsRender = preexistingRenders.map(o => o.render).join('\n');
  }

  // As a super-fast way to update renders upon re-bookmarking, let the entire header live on a single line
  const render = `<div id="${anchor}" class="bookmark">${header}
${commentsRender}
</div>`;
  db.prepare(`update bookmark set render=$render, renderedTime=$renderedTime where id=$id`)
      .run({render, renderedTime: Date.now(), id});
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
          const newRender = bookmark.render.substring(0, newline + breakStr.length) + commentRender + '\n' +
                            bookmark.render.slice(newline + breakStr.length);
          const now = Date.now();
          db.prepare(
                `update bookmark set render=$render, renderedTime=$renderedTime, modifiedTime=$modifiedTime where id=$id`)
              .run({render: newRender, renderedTime: now, modifiedTime: now, id: bookmark.id})
        } else {
          // no comment, just bump the modifiedTime: we're not rendering this anywhere (yet)
          db.prepare(`update bookmark set modifiedTime=$modifiedTime where id=$id`)
              .run({modifiedTime: Date.now(), id: bookmark.id});
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

        const commentRender = comment ? addCommentToBookmark(db, comment, insertResult.lastInsertRowid) : '';

        rerenderJustBookmark(db, {...bookmarkRow, id: insertResult.lastInsertRowid}, [{render: commentRender}]);
      }
      cacheAllBookmarks(db);
      return '';
    }
    return 'need url OR title'
  }
  return 'need `url` and `title` as strings'
}

async function startServer(db: Db, port = 3456, fieldSize = 1024 * 1024 * 20, maxFiles = 10) {
  const upload = multer({storage: multer.memoryStorage(), limits: {fieldSize}});

  const app = express.default();
  app.use(require('cors')());
  app.use(require('body-parser').json());
  app.get('/', (req, res) => { res.send(ALL_BOOKMARKS); });
  app.get('/yamanote-favico.png', (req, res) => res.sendFile(__dirname + '/yamanote-favico.png'));

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
  await new Promise((resolve, reject) => app.listen(port, () => resolve(1)));
  console.log(`Example app listening at http://localhost:${port}`);
  return app;
}

if (require.main === module) {
  function clean(x: Table.mediaRow) {
    if (x.mime.includes('text/plain')) {
      x.content = x.content.toString();
    }
    return x;
  }

  (async function main() {
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
    const app = await startServer(db, port);

    {
      const form = new FormData();
      const contentType = "text/plain";
      for (const name of 'a,b,c'.split(',')) {
        const txt = name === 'a' ? 'fileA contents' : name === 'b' ? 'fileBBB' : 'c';
        form.append('files', Buffer.from(txt), {filename: `file${name}.txt`, contentType, knownLength: txt.length});
      }
      const url = `http://localhost:${port}${i.mediaPath({})}`;
      // This is needlessly complicated because I want to test everything with async/await rather than callbacks, sorry
      const res = await promisify(form.submit.bind(form))(url);
      await new Promise((resolve, reject) => {
        // via https://stackoverflow.com/a/54025408
        let reply = '';
        res.on('data', (chunk) => { reply += chunk; });
        res.on('end', () => {
          console.log({reply: JSON.parse(reply)});
          resolve(1);
        });
      });

      const all: Table.mediaRow[] = db.prepare(`select * from media`).all();
      console.dir(all.map(clean), {depth: null});
    }
    {
      const all: NonNullable<Selected<Table.commentRow>>[] =
          db.prepare(`select * from comment order by modifiedTime desc`).all()
      // for (const x of all) { console.log(rerenderComment(db, x)); }
      // cacheAllBookmarks(db);
    }
    {
      const all: NonNullable<Selected<Table.bookmarkRow>>[] =
          db.prepare(`select * from bookmark order by modifiedTime desc`).all()
      // for (const x of all) { rerenderJustBookmark(db, x); }
      // cacheAllBookmarks(db);
    }
  })();
}