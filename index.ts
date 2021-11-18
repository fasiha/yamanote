import sqlite3 from 'better-sqlite3';
import bodyParser from 'body-parser';
import * as express from 'express';
import FormData from 'form-data';
import {readFileSync} from 'fs';
import multer from 'multer';
import assert from 'node:assert';
import {promisify} from 'util';

import * as Table from './DbTables';
import {
  bookmarkPath,
  BookmarkPost,
  Db,
  filenamePath,
  mediaPath,
  paramify,
  Selected,
  SelectedAll
} from './pathsInterfaces';
import {rerenderComment, rerenderJustBookmark} from './renderers';

const SCHEMA_VERSION_REQUIRED = 1;

let ALL_BOOKMARKS = '';
/**
 * Save a new backup after a week
 */
const SAVE_BACKUP_THROTTLE_MILLISECONDS = 3600e3 * 24 * 7;

function uniqueConstraintError(e: unknown): boolean {
  return e instanceof sqlite3.SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

export function dbInit(fname: string) {
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
                  `<p>Bookmarklet: <a id="bookmarklet" href="${
                      js}">山の手</a>. Code: <a href="https://github.com/fasiha/yamanote">GitHub</a></p>`;
  ALL_BOOKMARKS = prelude + (renders || '');
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

function bodyToBookmark(db: Db, body: Record<string, any>): string {
  // optimization possibiity: don't get `render` if no `comment`
  type SmallBookmark = Pick<Table.bookmarkRow, 'id'|'render'|'modifiedTime'>;
  let bookmark: Selected<SmallBookmark>;

  // Do we look up a specific bookmark by id, in which case it has to exist?
  // Or are we just submitting a url/title that may or may not exist?
  const res = BookmarkPost.decode(body);
  if (res._tag === 'Right') {
    const right = res.right;
    if (right.id !== undefined) {
      if (!isFinite(right.id) || right.id <= 0) {
        return 'need positive id';
      }
      bookmark = db.prepare(`select id, render, modifiedTime from bookmark where id=$id`).get({id: right.id});
      if (!bookmark) {
        return 'not authorized';
      }
      // bookmark is now valid
    } else if (right.url || right.title) {
      // url or right (one of them) is non-empty
      bookmark = db.prepare(`select id, render, modifiedTime from bookmark where url=$url and title=$title`)
                     .get({title: right.title ?? '', url: right.url ?? ''});
      // bookmark MIGHT be valid
    } else {
      return 'invalid request: need {id} or {url, title}, if latter, url or title or both non-empty';
    }
  } else {
    return 'invalid request, failed io-ts specification'
  }

  const comment = res.right.comment ?? '';
  let dobackup = false;

  let id: number|bigint;

  if (bookmark) {
    // There's a bookmark already
    id = bookmark.id;

    const now = Date.now();

    if (bookmark.modifiedTime) {
      dobackup = (now - bookmark.modifiedTime) > SAVE_BACKUP_THROTTLE_MILLISECONDS;
    }

    const commentRender = addCommentToBookmark(db, comment ?? '', id);
    const breakStr = '\n';
    const newline = bookmark.render.indexOf(breakStr);
    if (newline < 0) {
      throw new Error('no newline in render ' + id);
    }
    // RERENDER: assume first line is the bookmark stuff, and after newline, we have comments
    const newRender = bookmark.render.substring(0, newline + breakStr.length) + commentRender + '\n' +
                      bookmark.render.slice(newline + breakStr.length);
    db.prepare(
          `update bookmark set render=$render, renderedTime=$renderedTime, modifiedTime=$modifiedTime where id=$id`)
        .run({render: newRender, renderedTime: now, modifiedTime: now, id: id})
  } else {
    // brand new bookmark!

    const url = res.right.url ?? '';
    const title = res.right.title ?? '';
    assert(title || url, 'url or title or both non-empty'); // guaranteed above

    dobackup = true;
    let now = Date.now();
    const bookmarkRow: Table.bookmarkRow = {
      userId: -1,
      url,
      title,
      createdTime: now,
      modifiedTime: now,
      render: '',        // will be overridden shortly, in `rerenderJustBookmark`
      renderedTime: now, // ditto
    };
    const insertResult =
        db.prepare(`insert into bookmark (userId, url, title, createdTime, modifiedTime, render, renderedTime)
          values ($userId, $url, $title, $createdTime, $modifiedTime, $render, $renderedTime)`)
            .run(bookmarkRow)

    id = insertResult.lastInsertRowid;
    const commentRender = addCommentToBookmark(db, comment ?? '', id);

    rerenderJustBookmark(db, {...bookmarkRow, id: id}, [{render: commentRender}]);
  }
  cacheAllBookmarks(db);

  // handle full-HTML backup
  const {html} = res.right;
  if (html && dobackup) {
    db.prepare(`insert into backup (bookmarkId, content, createdTime) values ($bookmarkId, $content, $createdTime)`)
        .run({bookmarkId: id, content: html, createdTime: Date.now()});
  }

  return '';
}

async function startServer(db: Db, port = 3456, fieldSize = 1024 * 1024 * 20, maxFiles = 10) {
  const upload = multer({storage: multer.memoryStorage(), limits: {fieldSize}});

  const app = express.default();
  app.use(require('cors')());
  app.use(bodyParser.json({limit: 1 * 1024 ** 2}));
  app.get('/', (req, res) => { res.send(ALL_BOOKMARKS); });
  app.get('/popup', (req, res) => res.sendFile(__dirname + '/prelude.html'));
  app.get('/yamanote-favico.png', (req, res) => res.sendFile(__dirname + '/yamanote-favico.png'));

  // bookmarks
  app.post(bookmarkPath.pattern, (req, res) => {
    console.log('POST! ', {title: req.body.title, url: req.body.url});
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
  app.post(mediaPath.pattern, upload.array('files', maxFiles), (req, res) => {
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
    const db = dbInit('yamanote.db');
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
      const url = `http://localhost:${port}${mediaPath({})}`;
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
      const all: SelectedAll<Table.commentRow> = db.prepare(`select * from comment order by modifiedTime desc`).all()
      // for (const x of all) { console.log(rerenderComment(db, x)); }
      // cacheAllBookmarks(db);
    }
    {
      const all: SelectedAll<Table.bookmarkRow> = db.prepare(`select * from bookmark order by modifiedTime desc`).all()
      // for (const x of all) { rerenderJustBookmark(db, x); }
      // cacheAllBookmarks(db);
    }
    {
      const all: SelectedAll<Table.backupRow> = db.prepare(`select * from backup`).all()
      console.log(all.map(o => o.content.length / 1024 + ' kb'));
    }
  })();
}