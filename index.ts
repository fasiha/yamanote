import sqlite3 from 'better-sqlite3';
import bodyParser from 'body-parser';
import * as express from 'express';
import FormData from 'form-data';
import {readFileSync} from 'fs';
import multer from 'multer';
import assert from 'node:assert';
import {promisify} from 'util';

import * as Table from './DbTablesV2';
import {
  AddBookmarkOrCommentPayload,
  AddCommentOnlyPayload,
  AddHtmlPayload,
  AskForHtmlPayload,
  bookmarkPath,
  Db,
  filenamePath,
  mediaPath,
  paramify,
  Selected,
  SelectedAll
} from './pathsInterfaces';
import {fastUpdateBookmarkWithNewComment, rerenderComment, rerenderJustBookmark} from './renderers';

const SCHEMA_VERSION_REQUIRED = 2;

let ALL_BOOKMARKS = '';
/**
 * Save a new backup after a ~month
 */
const SAVE_BACKUP_THROTTLE_MILLISECONDS = 3600e3 * 24 * 30;

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
      throw new Error('db wrong version: need ' + SCHEMA_VERSION_REQUIRED);
    }
  } else {
    console.log('uninitialized, will create v1 schema');
    db.exec(readFileSync('db-v1.sql', 'utf8'));
  }
  cacheAllBookmarks(db);
  return db;
}

type MimeContent = Pick<Table.mediaRow, 'mime'|'content'>;
function getFilename(db: Db, path: string): MimeContent|undefined {
  return db.prepare(`select mime, content from media where path=$path`).get({filename: path});
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

function createNewBookmark(db: Db, url: string, title: string, comment: string): number|bigint {
  const now = Date.now();
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

  const id = insertResult.lastInsertRowid;
  const commentRender = addCommentToBookmark(db, comment, id);

  rerenderJustBookmark(db, {...bookmarkRow, id: id}, [{render: commentRender}]);
  return id;
}

function bodyToBookmark(db: Db, body: Record<string, any>): [number, string|Record<string, any>] {
  type SmallBookmark = Selected<Pick<Table.bookmarkRow, 'id'|'render'|'modifiedTime'>>;

  {
    const res = AddBookmarkOrCommentPayload.decode(body);
    if (res._tag === 'Right') {
      const {url, title, html, quote} = res.right;
      let {comment} = res.right;

      // ask for HTML if there's a URL without HTML, unless we already have a (recent) snapshot
      let askForHtml = !!url && !html;

      if (title || url) {
        // one of these has to be non-empty

        let id: bigint|number;

        if (quote && comment) {
          comment = '> ' + comment.replace(/\n/g, '\n> ');
        }

        const bookmark: SmallBookmark =
            db.prepare(`select id, render, modifiedTime from bookmark where url=$url and title=$title`)
                .get({title, url});

        if (bookmark) {
          // existing bookmark
          id = bookmark.id;
          const commentRender = addCommentToBookmark(db, comment, id);
          fastUpdateBookmarkWithNewComment(db, bookmark.render, id, commentRender);

          if (askForHtml) {
            // we're going to ask for HTML so far: URL, no HTML given. But if we have recent HTML, we can set
            // `askForHtml=false`. Let's check.
            const backup: Pick<Table.backupRow, 'createdTime'>|undefined =
                db.prepare(`select max(createdTime) as createdTime from backup where bookmarkId=$id`).get({id});
            if (backup) {
              const backupIsRecent = (Date.now() - backup.createdTime) < SAVE_BACKUP_THROTTLE_MILLISECONDS;
              askForHtml = askForHtml && !(backup && backupIsRecent);
              // EFFECTIVELY we're doing `askForHtml = url && !html && !(have backup && its recent)`.
            }
          }
        } else {
          // new bookmark
          id = createNewBookmark(db, url, title, comment);
        }
        cacheAllBookmarks(db);

        if (html) {
          db.prepare(`insert into backup (bookmarkId, content, createdTime)
                values ($bookmarkId, $content, $createdTime)`)
              .run({bookmarkId: id, content: html, createdTime: Date.now()});
        }
        const reply: AskForHtmlPayload = {id, htmlWanted: askForHtml};

        // the below will throw later if id is bigint, which better-sqlite3 will return if >2**53 or 10**16, because
        // JSON.stringify doesn't work on bigint, and I don't want to bother with json-bigint.
        return [200, reply];
      }
      return [400, 'need a `url` or `title` (or both)'];
    }
  }
  {
    const res = AddCommentOnlyPayload.decode(body);
    if (res._tag === 'Right') {
      const {id, comment} = res.right;
      const bookmark: SmallBookmark =
          db.prepare(`select id, render, modifiedTime from bookmark where id=$id`).get({id});
      if (bookmark) {
        fastUpdateBookmarkWithNewComment(db, bookmark.render, id, addCommentToBookmark(db, comment, id));
        cacheAllBookmarks(db);
        return [200, {}];
      }
      return [401, 'not authorized'];
    }
  }
  {
    const res = AddHtmlPayload.decode(body);
    if (res._tag === 'Right') {
      const {id, html} = res.right;
      db.prepare(`insert into backup (bookmarkId, content, createdTime)
      values ($bookmarkId, $content, $createdTime)`)
          .run({bookmarkId: id, content: html, createdTime: Date.now()});

      return [200, {}];
    }
  }

  return [400, 'no message type matched io-ts specification']
}

async function startServer(db: Db, port = 3456, fieldSize = 1024 * 1024 * 20, maxFiles = 10) {
  const upload = multer({storage: multer.memoryStorage(), limits: {fieldSize}});

  const app = express.default();
  app.use(require('cors')());
  app.use(require('compression')());
  app.use(bodyParser.json({limit: fieldSize}));
  app.get('/', (req, res) => { res.send(ALL_BOOKMARKS); });
  app.get('/popup', (req, res) => res.sendFile(__dirname + '/prelude.html'));
  app.get('/yamanote-favico.png', (req, res) => res.sendFile(__dirname + '/yamanote-favico.png'));
  app.get('/prelude.js', (req, res) => res.sendFile(__dirname + '/prelude.js'));

  // bookmarks
  app.post(bookmarkPath.pattern, (req, res) => {
    console.log('POST! ', {title: req.body.title, url: req.body.url, comment: (req.body.comment || '').slice(0, 100)});
    if (!req.body) {
      res.status(400).send('post json');
      return;
    }
    const [code, msg] = bodyToBookmark(db, req.body);
    if (code === 200) {
      assert(typeof msg === 'object', '200 will send JSON');
      res.json(msg);
      return;
    }
    assert(typeof msg === 'string', 'non-200 must be text');
    res.status(code).send(msg);
  });

  // media
  app.post(mediaPath.pattern, upload.array('files', maxFiles), (req, res) => {
    const files = req.files;
    if (files && files instanceof Array) {
      const ret: Record<string, number> = {};
      const createdTime = Date.now();
      const insertStatement = db.prepare(
          `insert into media (path, content, mime, numBytes, createdTime) values ($path, $content, $mime, $numBytes, $createdTime)`);

      for (const file of files) {
        const media: Table.mediaRow =
            {path: file.originalname, mime: file.mimetype, content: file.buffer, numBytes: file.size, createdTime};
        try {
          const insert = insertStatement.run(media);
          ret[media.path] = insert.changes >= 1 ? 200 : 500;
        } catch (e) {
          if (uniqueConstraintError(e)) {
            ret[media.path] = 409;
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
      path: 'raw.dat',
      mime: 'text/plain',
      content: Buffer.from([0x62, 0x75, 0x66, 0x66, 0x65, 0x72]),
      createdTime: Date.now(),
      numBytes: 6,
    };
    try {
      db.prepare(
            `insert into media (path, content, mime, numBytes, createdTime) values ($path, $content, $mime, $numBytes, $createdTime)`)
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
    if (0) {
      const all: SelectedAll<Table.commentRow> = db.prepare(`select * from comment order by modifiedTime desc`).all()
      for (const x of all) { rerenderComment(db, x); }
      cacheAllBookmarks(db);
    }
    if (0) {
      const all: SelectedAll<Table.bookmarkRow> = db.prepare(`select * from bookmark order by modifiedTime desc`).all()
      for (const x of all) { rerenderJustBookmark(db, x); }
      cacheAllBookmarks(db);
    }
    {
      const all: SelectedAll<Table.backupRow> = db.prepare(`select * from backup`).all()
      console.log(all.map(o => o.content.length / 1024 + ' kb'));
    }
    {
      const title = 'TITLE YOU WANT TO DELETE';
      const res: SelectedAll<Table.bookmarkRow> = db.prepare(`select * from bookmark where title=$title`).all({title});
      if (res.length === 1) {
        console.log(`sqlite3 yamanote.db
delete from bookmark where id=${res[0].id};
delete from comment where bookmarkId=${res[0].id};
delete from backup where bookmarkId=${res[0].id};
`);
      }
    }
  })();
}