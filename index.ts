import sqlite3 from 'better-sqlite3';
import bodyParser from 'body-parser';
import {createHash} from 'crypto';
import * as express from 'express';
import {readFileSync} from 'fs';
import {JSDOM} from 'jsdom';
import multer from 'multer';
import fetch from 'node-fetch';
import assert from 'node:assert';
import * as srcsetlib from 'srcset';

import * as Table from './DbTablesV3';
import {makeBackupTriggers} from './makeBackupTriggers.js';
import {
  AddBookmarkOrCommentPayload,
  AddCommentOnlyPayload,
  AddHtmlPayload,
  AskForHtmlPayload,
  backupPath,
  bookmarkPath,
  commentPath,
  Db,
  mediaPath,
  Selected,
  SelectedAll
} from './pathsInterfaces.js';
import {fastUpdateBookmarkWithNewComment, rerenderComment, rerenderJustBookmark} from './renderers.js';

const SCHEMA_VERSION_REQUIRED = 3;
const HASH_ALGORITHM = 'sha256';

let ALL_BOOKMARKS = '';

/**
 * Save a new backup after a ~month
 */
const SAVE_BACKUP_THROTTLE_MILLISECONDS = 3600e3 * 24 * 30;
const USER_AGENT = `Yamanote (contact info at https://github.com/fasiha/yamanote)`;
const [MIN_WAIT, MAX_WAIT] = [500, 2000]; // milliseconds between network requests

export function uniqueConstraintError(e: unknown): boolean {
  return e instanceof sqlite3.SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

function dbVersionCheck(db: Db) {
  const s = db.prepare(`select schemaVersion from _yamanote_db_state`);
  const dbState: Selected<Table._yamanote_db_stateRow> = s.get();
  if (dbState?.schemaVersion !== SCHEMA_VERSION_REQUIRED) {
    throw new Error('db wrong version: need ' + SCHEMA_VERSION_REQUIRED);
  }
}

export function dbInit(fname: string) {
  const db = sqlite3(fname);
  db.pragma('journal_mode = WAL'); // https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/performance.md
  let s = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`);
  const tableThere = s.get('_yamanote_db_state');

  if (tableThere) {
    // ensure it's the correct version, else bail; implement up/down migration later
    dbVersionCheck(db);
  } else {
    console.log('uninitialized, will create schema');
    db.exec(readFileSync(`db-v${SCHEMA_VERSION_REQUIRED}.sql`, 'utf8'));
    dbVersionCheck(db);
  }
  {
    // create (if needed) backup table and triggers
    makeBackupTriggers(db, 'media');
    makeBackupTriggers(db, 'blob');
    makeBackupTriggers(db, 'backup', new Set(['content']));
    const ignore = new Set(['render', 'renderedTime'])
    makeBackupTriggers(db, 'bookmark', ignore);
    makeBackupTriggers(db, 'comment', ignore);
  }
  cacheAllBookmarks(db);
  return db;
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
          downloadImagesVideos(db, id);
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
      const backup: Table.backupRow = {bookmarkId: id, content: html, original: html, createdTime: Date.now()};
      db.prepare(`insert into backup (bookmarkId, content, original, createdTime)
      values ($bookmarkId, $content, $original, $createdTime)`)
          .run(backup);
      downloadImagesVideos(db, id);

      return [200, {}];
    }
  }

  return [400, 'no message type matched io-ts specification']
}

function fixUrl(url: string, parentUrl: string): string|undefined {
  // NO source? Data URL? Skip.
  if (!url || url.startsWith('data:')) {
    return undefined;
  }

  try {
    new URL(url);
    // this will throw if url isn't absolute
    return url; // url is fine as is
  } catch (e) {
    if ((e as any).code === 'ERR_INVALID_URL') {
      // Save it as the absolute URL so different sites with same relative URLs will be fine
      const u = new URL(url, parentUrl);
      return u.href;
    } else {
      throw e;
    }
  }
}

function mediaBookmarkUrl(bookmarkId: number|bigint, url: string): string { return `/media/${bookmarkId}/${url}`; }

export function processSrcset(srcset: string, parentUrl: string, bookmarkId: number|bigint) {
  if (!srcset) {
    return undefined;
  }

  const list = srcsetlib.parse(srcset);
  const newlist: typeof list = [];
  const urls = [];
  for (const entry of list) {
    const originalUrl = fixUrl(entry.url, parentUrl);
    if (!originalUrl) {
      continue;
    }
    urls.push(originalUrl);                                                   // we'll download this original URL
    newlist.push({...entry, url: mediaBookmarkUrl(bookmarkId, originalUrl)}); // we'll replace the html with this
  }
  return {urls, srcsetNew: srcsetlib.stringify(newlist)};
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), milliseconds));
}

export function sha256hash(content: Buffer) {
  const hash = createHash(HASH_ALGORITHM);
  hash.update(content);
  return hash.digest('base64url');
}

async function saveUrl(db: Db, url: string, bookmarkId: number|bigint) {
  const mediaCounter = db.prepare<{path: string, bookmarkId: number | bigint}>(
      `select count(*) as count from media where path=$path and bookmarkId=$bookmarkId`);
  const mediaInsert = db.prepare<Table.mediaRow>(`insert into media
      (path, bookmarkId, sha256, createdTime)
      values ($path, $bookmarkId, $sha256, $createdTime)`);

  const blobCounter = db.prepare<{sha256: string}>(`select count(*) as count from blob where sha256=$sha256`);
  const blobInsert = db.prepare<Table.blobRow>(`insert into blob
      (content, mime, createdTime, numBytes, sha256)
      values ($content, $mime, $createdTime, $numBytes, $sha256)`);

  const pathCount: {count: number} = mediaCounter.get({path: url, bookmarkId});
  if (!pathCount || pathCount.count === 0) {
    console.log(`bookmarkId=${bookmarkId}, url=${url}`);

    const init = {'headers': {'User-Agent': USER_AGENT}};
    const response = await fetch(url, init);
    if (response.ok) {
      const blob = await response.arrayBuffer();
      const mime = response.headers.get('content-type');
      if (!mime) {
        // likely a tracking pixel or something stupid/evil
        console.warn(`no mime, status=${response.status} ${response.statusText}`);
        return;
      }
      const content = Buffer.from(blob);
      const sha256 = sha256hash(content);
      mediaInsert.run({path: url, bookmarkId, sha256, createdTime: Date.now()});

      const blobCount: {count: number} = blobCounter.get({sha256});
      if (!blobCount || blobCount.count === 0) {
        blobInsert.run({content, mime, createdTime: Date.now(), numBytes: content.byteLength, sha256})
      }

      await sleep(MIN_WAIT + Math.random() * (MAX_WAIT - MIN_WAIT))
    } else {
      console.error(`RESPONSE ERROR ${response.status} ${response.statusText}, url=${url}`)
    }
  }
}

// Rewrite URLs in DOM and return a list of the original URLs
export function updateDomUrls(dom: JSDOM, parentUrl: string, bookmarkId: number|bigint): string[] {
  const urls: string[] = [];
  const mediaUrl = (url: string) => mediaBookmarkUrl(bookmarkId, url);

  for (const link of dom.window.document.querySelectorAll('link')) {
    if (link.rel === 'stylesheet' && link.href) {
      const url = fixUrl(link.href, parentUrl);
      if (url) {
        urls.push(url);
        link.href = mediaUrl(url);
      }
    }
  }

  for (const video of dom.window.document.querySelectorAll('video')) {
    const src = fixUrl(video.src, parentUrl);
    if (!src) {
      continue;
    }
    video.src = mediaUrl(src);
    if (video.poster) {
      const url = fixUrl(video.poster, parentUrl);
      if (url) {
        urls.push(url);
        video.poster = mediaUrl(url);
      }
    }
    // TODO call youtube-dl to download video
    console.log(`bookmarkId=${bookmarkId}, youtube-dl ${src}, and upload result`);
  }

  for (const source of dom.window.document.querySelectorAll('source')) {
    if (source.srcset) {
      const srcset = processSrcset(source.srcset, parentUrl, bookmarkId);
      if (srcset) {
        // download
        urls.push(...srcset.urls);
        // override DOM node
        source.srcset = srcset.srcsetNew;
      }
    }
  }

  for (const img of dom.window.document.querySelectorAll('img')) {
    const src = fixUrl(img.src, parentUrl);
    if (!src) {
      continue;
    }

    // download image src
    urls.push(src);
    // override source to point to our mirror
    img.src = mediaUrl(src);

    // handle srcset
    const srcset = processSrcset(img.srcset, parentUrl, bookmarkId);
    if (srcset) {
      // download
      urls.push(...srcset.urls);
      // override DOM node
      img.srcset = srcset.srcsetNew;
    }
  }

  return urls;
}

async function downloadImagesVideos(db: Db, bookmarkId: number|bigint) {
  const row: Pick<Table.backupRow, 'original'> =
      db.prepare<{bookmarkId: number | bigint}>('select original from backup where bookmarkId=$bookmarkId')
          .get({bookmarkId});
  const bookmark: Pick<Table.bookmarkRow, 'url'> =
      db.prepare<{id: number | bigint}>('select url from bookmark where id=$id').get({id: bookmarkId});
  if (!row || !row.original || !bookmark || !bookmark.url) {
    return;
  }

  const dom = new JSDOM(row.original);

  for (const url of updateDomUrls(dom, bookmark.url, bookmarkId)) { await saveUrl(db, url, bookmarkId) }

  // with stuff downloaded, update backup.content
  db.prepare(`update backup set content=$content where bookmarkId=$bookmarkId`)
      .run({content: dom.serialize(), bookmarkId});
  console.log(`done downloading ${bookmarkId}`);
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
  app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/yamanote-favico.png'));
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

  // backups
  app.get(backupPath.pattern, (req, res) => {
    const backup: Pick<Table.backupRow, 'content'>|undefined =
        db.prepare(`select content from backup where bookmarkId=$bookmarkId order by createdTime desc limit 1`).get({
          bookmarkId: req.params.bookmarkId
        });
    if (backup) {
      // prevent the browser from going anywhere to request data. This disables external JS, CSS, images, etc.
      res.set({'Content-Security-Policy': `default-src 'self'`});
      res.send(backup.content);
    } else {
      res.status(409).send('not authorized');
    }
  });

  // media
  app.post(mediaPath.pattern, upload.array('files', maxFiles), (req, res) => {
    const bookmarkId = parseInt(req.params.bookmarkId);
    const files = req.files;
    if (files && files instanceof Array && isFinite(bookmarkId)) {
      const mediaInsert = db.prepare<Table.mediaRow>(`insert into media
      (path, bookmarkId, sha256, createdTime)
      values ($path, $bookmarkId, $sha256, $createdTime)`);
      const blobCounter = db.prepare<{sha256: string}>(`select count(*) as count from blob where sha256=$sha256`);
      const blobInsert = db.prepare<Table.blobRow>(`insert into blob
      (content, mime, createdTime, numBytes, sha256)
      values ($content, $mime, $createdTime, $numBytes, $sha256)`);

      for (const file of files) {
        const content = file.buffer;
        const sha256 = sha256hash(content);
        const media: Table.mediaRow = {path: file.originalname, bookmarkId, sha256, createdTime: Date.now()};
        try {
          mediaInsert.run(media);
        } catch (e) {
          if (!uniqueConstraintError(e)) {
            throw e;
          }
        }
        const blobCount: {count: number|bigint} = blobCounter.get({sha256});
        if (!blobCount.count) {
          blobInsert.run({content, mime: file.mimetype, createdTime: Date.now(), numBytes: content.byteLength, sha256});
        }
      }
      res.status(200).send();
      return;
    }
    res.status(400).send('need files');
  });
  app.get(/^\/media\//, (req, res) => {
    const match = req.url.match(/^\/media\/([0-9]+)\/(.+)$/);
    if (match) {
      const bookmarkId = parseInt(match[1]);
      const path = match[2];
      if (isFinite(bookmarkId) && path) {
        const got: Selected<Pick<Table.blobRow, 'mime'|'content'>> =
            db.prepare<{bookmarkId: number, path: string}>(`select mime, content from blob 
                where sha256=(select sha256 from media where bookmarkId=$bookmarkId and path=$path limit 1)`)
                .get({bookmarkId, path});
        if (got) {
          res.contentType(got.mime);
          res.send(got.content);
          return;
        }
      }
    }
    res.status(404).send();
  });

  // comments (a lot of comment-related stuff is handled under bookmarks above though, stuff where you don't know the
  // comment ID)
  app.put(commentPath.pattern, function commentPut(req, res) {
    const commentId = parseInt(req.params.commentId);
    const {content} = req.body;
    if (isFinite(commentId) && typeof content === 'string') {
      // TODO: check authorization
      const row: {bookmarkId: number} =
          db.prepare<{id: number}>(`select bookmarkId from comment where id=$id`).get({id: commentId});
      if (row && row.bookmarkId >= 0) { // sqlite row IDs start at 1 by the way
        db.prepare<{content: string, modifiedTime: number, id: number}>(
              `update comment set content=$content, modifiedTime=$modifiedTime where id=$id`)
            .run({content, modifiedTime: Date.now(), id: commentId});
        rerenderComment(db, commentId);
        rerenderJustBookmark(db, row.bookmarkId);
        cacheAllBookmarks(db);
        res.status(200).send();
        return;
      } else {
        res.status(401).send();
      }
    }
    res.status(400).send();
  });

  await new Promise((resolve, reject) => app.listen(port, () => resolve(1)));
  console.log(`Example app listening at http://localhost:${port}`);
  return app;
}

if (require.main === module) {
  (async function main() {
    const db = dbInit(`yamanote-v${SCHEMA_VERSION_REQUIRED}.db`);

    const port = 3456;
    const app = await startServer(db, port);

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
      const title = 'TITLE YOU WANT TO DELETE';
      const res: SelectedAll<Table.bookmarkRow> = db.prepare(`select * from bookmark where title=$title`).all({title});
      if (res.length === 1) {
        console.log(`sqlite3 yamanote-v${SCHEMA_VERSION_REQUIRED}.db
delete from bookmark where id=${res[0].id};
delete from comment where bookmarkId=${res[0].id};
delete from backup where bookmarkId=${res[0].id};
`);
      }
    }
    if (0) {
      const ids: {id: number|bigint}[] = db.prepare('select id from bookmark').all()
      for (const {id} of ids) { await downloadImagesVideos(db, id); }
      console.log('done downloading all images');
    }
  })();
}