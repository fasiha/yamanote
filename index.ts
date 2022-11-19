import sqlite3 from 'better-sqlite3';
import bodyParser from 'body-parser';
import {createHash} from 'crypto';
import * as express from 'express';
import {readFileSync} from 'fs';
import {JSDOM} from 'jsdom';
import {sync as mkdirpSync} from 'mkdirp';
import multer from 'multer';
import fetch from 'node-fetch';
import assert from 'node:assert';
import http from 'node:http';
import srcsetlib from 'srcset';

import * as Table from './DbTablesV4';
import {ensureAuthenticated, passportSetup, reqToUser} from './federated-auth';
import {makeBackupTriggers} from './makeBackupTriggers.js';
import {
  AddBookmarkOrCommentPayload,
  AddCommentOnlyPayload,
  AddHtmlPayload,
  AskForHtmlPayload,
  backupPath,
  bookmarkIdPath,
  bookmarkPath,
  commentPath,
  Db,
  FullRow,
  mediaPath,
  mergePath,
  Selected,
  SelectedAll,
  uniqueConstraintError
} from './pathsInterfaces.js';
import {
  fastUpdateBookmarkWithNewComment,
  renderBookmarkHeader,
  rerenderComment,
  rerenderJustBookmark
} from './renderers.js';
import {add1, groupBy2} from './utils';

let ALL_BOOKMARKS: Map<number|bigint, string> = new Map();
let ALL_COMMENTS: Map<number|bigint, string> = new Map();

const SCHEMA_VERSION_REQUIRED = 4;
const DEFAULT_PORT = process.env.PORT ? parseInt(process.env.PORT) : 3456;
/**
 * Save a new backup after a ~month
 */
const SAVE_BACKUP_THROTTLE_MILLISECONDS = 3600e3 * 24 * 30;
const USER_AGENT = `Yamanote (contact info at https://github.com/fasiha/yamanote)`;
const [MIN_WAIT, MAX_WAIT] = [500, 2000]; // milliseconds between network requests

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
  return db;
}

function cacheAllBookmarks(db: Db, userId: bigint|number) {
  const res: Pick<Table.bookmarkRow, 'render'>[] =
      db.prepare(`select render from bookmark where userId=$userId order by modifiedTime desc`).all({userId});
  const renders = res.map(o => o.render).join('\n');

  const js = readFileSync('bookmarklet.js', 'utf8');
  const BOOKMARKLET_NEEDLE = '$BOOKMARKLET_PAYLOAD';
  const prelude =
      readFileSync('prelude.html', 'utf8') + readFileSync('topstuff.html', 'utf8').replace(BOOKMARKLET_NEEDLE, js);
  assert(!prelude.includes(BOOKMARKLET_NEEDLE), 'javascript has been inserted')

  ALL_BOOKMARKS.set(userId, prelude + renders);
  cacheAllComments(db, userId);
}
function cacheAllComments(db: Db, userId: bigint|number) {
  const commentsTimeSorted:
      SelectedAll<Pick<Table.commentRow, 'innerRender'|'bookmarkId'|'id'>&Pick<Table.bookmarkRow, 'url'|'title'>> =
          db.prepare(`select comment.innerRender, comment.id, bookmark.url, bookmark.title, bookmark.id as bookmarkId
      from comment
      join bookmark on bookmark.id=comment.bookmarkId
      where bookmark.userId=1
      order by comment.createdTime desc`)
              .all();
  var bookmarkIdToCommentIdToComment =
      groupBy2(commentsTimeSorted, (x) => x.bookmarkId,
               (x, group?: {comments: typeof commentsTimeSorted, commentIdToIdx: Map<number|bigint, number>}) => {
                 if (group) {
                   group.commentIdToIdx.set(x.id, group.commentIdToIdx.size);
                   group.comments.push(x);
                   return group;
                 }
                 return { comments: [x], commentIdToIdx: new Map([[x.id, 0]]) }
               });
  var renders =
      commentsTimeSorted
          .map((x, xid) => {
            const bookmarkId = x.bookmarkId;
            const sameBookmarkPrev = bookmarkId === commentsTimeSorted[xid - 1]?.bookmarkId;
            const sameBookmarkNext = bookmarkId === commentsTimeSorted[xid + 1]?.bookmarkId

            const group = bookmarkIdToCommentIdToComment.get(bookmarkId);
            if (group === undefined) { throw new Error('1') }
            const idx = group.commentIdToIdx.get(x.id);
            if (idx === undefined) { throw new Error('2') }
            const total = group.comments.length;
            const thisNum = total - idx;
            const prevId: undefined|number|bigint = group.comments[idx - 1]?.id;
            const nextId: undefined|number|bigint = group.comments[idx + 1]?.id;
            const prev = (prevId && !sameBookmarkPrev) ? `<a class="emojilink" href="#comment-${prevId}">👈</a>` : '';
            const next = (nextId && !sameBookmarkNext) ? `<a class="emojilink" href="#comment-${nextId}">👉</a>` : '';
            const thisVsTotal = (prev || next) ? `(${thisNum}/${total})` : '';
            const coda = ['', prev, next, thisVsTotal].join(' ') + '\n';

            const needle = '</div>';
            if (!x.innerRender.endsWith(needle)) { throw new Error('3') }
            const commentRender = x.innerRender.slice(0, -(needle.length)) + coda + needle;

            const suffix = total > 1 ? `-${thisNum}-of-${total}` : '';
            let bookmarkHeader = ['', ''];
            if (!sameBookmarkPrev || !sameBookmarkNext) {
              bookmarkHeader = renderBookmarkHeader({id: bookmarkId, url: x.url, title: x.title}, suffix)
              if (sameBookmarkPrev) { bookmarkHeader[0] = ''; }
              if (sameBookmarkNext) { bookmarkHeader[1] = ''; }
            }
            return [bookmarkHeader[0], commentRender, bookmarkHeader[1]].join('');
          })
          .join('\n');

  const js = readFileSync('bookmarklet.js', 'utf8');
  const BOOKMARKLET_NEEDLE = '$BOOKMARKLET_PAYLOAD';
  const prelude =
      readFileSync('prelude.html', 'utf8') + readFileSync('topstuff.html', 'utf8').replace(BOOKMARKLET_NEEDLE, js);
  assert(!prelude.includes(BOOKMARKLET_NEEDLE), 'javascript has been inserted')

  ALL_COMMENTS.set(userId, prelude + renders);
}

function ensureBookmarkCommentConsistency(db: Db) {
  const bookmarks: SelectedAll<Pick<Table.bookmarkRow, 'id'|'numComments'>> =
      db.prepare(`select id, numComments from bookmark`).all();
  const commentStatement =
      db.prepare<Pick<Table.commentRow, 'bookmarkId'>>(`select siblingIdx from comment where bookmarkId=$bookmarkId`);
  for (const {id: bookmarkId, numComments} of bookmarks) {
    const rows: SelectedAll<Pick<Table.commentRow, 'siblingIdx'>> = commentStatement.all({bookmarkId})
    assert(rows.length === numComments);
    // todo check they're all there?
  }
}

function addCommentToBookmark(db: Db, comment: string, bookmarkId: number|bigint,
                              existingComments: number|bigint): string {
  const now = Date.now();
  const commentRow: Table.commentRow = {
    bookmarkId: bookmarkId,
    content: comment,
    createdTime: now,
    modifiedTime: now,
    innerRender: '', // will be overwritten later in this function, by `rerenderComment`
    fullRender: '',  // unused right now
    siblingIdx: add1(existingComments),
    renderedTime: -1, // again, will be overwritten
  };
  const result =
      db.prepare<Table.commentRow>(
            `insert into comment (bookmarkId, content, createdTime, modifiedTime, siblingIdx, innerRender, fullRender, renderedTime)
            values ($bookmarkId, $content, $createdTime, $modifiedTime, $siblingIdx, $innerRender, $fullRender, $renderedTime)`)
          .run(commentRow);
  return rerenderComment(db, {...commentRow, id: result.lastInsertRowid})
}

function createNewBookmark(db: Db, url: string, title: string, comment: string, userId: number|bigint): number|bigint {
  const now = Date.now();
  const bookmarkRow: Table.bookmarkRow = {
    userId,
    url,
    title,
    createdTime: now,
    modifiedTime: now,
    numComments: 1,
    render: '',        // will be overridden shortly, in `rerenderJustBookmark`
    renderedTime: now, // ditto
  };
  const insertResult =
      db.prepare<Table.bookmarkRow>(
            `insert into bookmark (userId, url, title, createdTime, modifiedTime, numComments, render, renderedTime)
            values ($userId, $url, $title, $createdTime, $modifiedTime, $numComments, $render, $renderedTime)`)
          .run(bookmarkRow)

  const id = insertResult.lastInsertRowid;
  const commentRender = addCommentToBookmark(db, comment, id, 0);

  rerenderJustBookmark(db, {...bookmarkRow, id: id}, [{render: commentRender}]);
  return id;
}

function bodyToBookmark(db: Db, body: Record<string, any>,
                        userId: number|bigint): [number, string|Record<string, any>] {
  type SmallBookmark = Selected<Pick<Table.bookmarkRow, 'id'|'render'|'modifiedTime'|'numComments'>>;

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

        if (quote && comment) { comment = '> ' + comment.replace(/\n/g, '\n> '); }

        const bookmark: SmallBookmark =
            db.prepare(
                  `select id, render, modifiedTime, numComments from bookmark where url=$url and title=$title and userId=$userId`)
                .get({title, url, userId});

        if (bookmark) {
          // existing bookmark
          id = bookmark.id;
          const commentRender = addCommentToBookmark(db, comment, id, bookmark.numComments);
          fastUpdateBookmarkWithNewComment(db, bookmark.render, id, commentRender, bookmark.numComments);

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
          id = createNewBookmark(db, url, title, comment, userId);
        }
        cacheAllBookmarks(db, userId);

        if (html) {
          // same as below
          const backup: Table.backupRow = {bookmarkId: id, content: html, original: html, createdTime: Date.now()};
          db.prepare(`insert into backup (bookmarkId, content, original, createdTime)
          values ($bookmarkId, $content, $original, $createdTime)`)
              .run(backup);
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
          db.prepare(`select id, render, modifiedTime, numComments from bookmark where id=$id and userId=$userId`)
              .get({id, userId});
      if (bookmark) {
        fastUpdateBookmarkWithNewComment(
            db, bookmark.render, id, addCommentToBookmark(db, comment, id, bookmark.numComments), bookmark.numComments);
        cacheAllBookmarks(db, userId);
        return [200, {}];
      }
      return [401, 'not authorized'];
    }
  }
  {
    const res = AddHtmlPayload.decode(body);
    if (res._tag === 'Right') {
      const {id, html} = res.right;
      if (!userBookmarkAuth(db, userId, id)) { return [401, 'not autorized'] }
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
  if (!url || url.startsWith('data:')) { return undefined; }

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
  if (!srcset) { return undefined; }

  const list = srcsetlib.parse(srcset);
  const newlist: typeof list = [];
  const urls = [];
  for (const entry of list) {
    const originalUrl = fixUrl(entry.url, parentUrl);
    if (!originalUrl) { continue; }
    urls.push(originalUrl);                                                   // we'll download this original URL
    newlist.push({...entry, url: mediaBookmarkUrl(bookmarkId, originalUrl)}); // we'll replace the html with this
  }
  return {urls, srcsetNew: srcsetlib.stringify(newlist)};
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(() => resolve(), milliseconds));
}

export function sha256hash(content: Buffer) {
  const hash = createHash('sha256');
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
    try {
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
    } catch (e) { console.error(`FETCH FAILED TO FETCH, continuing`, e); }
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
    if (!src) { continue; }
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
    if (!src) { continue; }

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
  if (!row || !row.original || !bookmark || !bookmark.url) { return; }

  const dom = new JSDOM(row.original);

  for (const url of updateDomUrls(dom, bookmark.url, bookmarkId)) { await saveUrl(db, url, bookmarkId) }

  // with stuff downloaded, update backup.content
  db.prepare(`update backup set content=$content where bookmarkId=$bookmarkId`)
      .run({content: dom.serialize(), bookmarkId});
  console.log(`done downloading ${bookmarkId}`);
}

function userBookmarkAuth(db: Db, userOrId: number|bigint|FullRow<Table.userRow>, bookmarkId: number|bigint): boolean {
  const userId = typeof userOrId === 'object' ? userOrId.id : userOrId;
  const usercheck: {count: number} =
      db.prepare<{bookmarkId: number | bigint, userId: number | bigint}>(
            `select count(*) as count from bookmark where id=$bookmarkId and userId=$userId`)
          .get({bookmarkId, userId})
  return usercheck.count > 0;
}

export async function startServer(db: Db, {
  port = DEFAULT_PORT,
  fieldSize = 1024 * 1024 * 20,
  maxFiles = 10,
  sessionFilename = __dirname + '/.data/session.db',
} = {}) {
  const upload = multer({storage: multer.memoryStorage(), limits: {fieldSize}});

  const app = express.default();
  app.set('trust proxy', 1);
  app.use(require('cors')());
  app.use(require('compression')());
  app.use(bodyParser.json({limit: fieldSize}));
  const {knex} = passportSetup(db, app, sessionFilename);
  app.get('/', (req, res) => {
    if (req.user) {
      const user = reqToUser(req);
      if (!ALL_BOOKMARKS.has(user.id)) { cacheAllBookmarks(db, user.id); }
      res.send(ALL_BOOKMARKS.get(user.id));
      return;
    }
    res.sendFile(__dirname + '/welcome.html');
  });
  app.get('/welcomeback', (req, res) => {
    if (req.user) {
      res.sendFile(__dirname + '/welcomeback.html');
      return;
    }
    res.sendFile(__dirname + '/welcome.html');
  });
  app.get('/c', (req, res) => {
    if (req.user) {
      const user = reqToUser(req);
      if (!ALL_COMMENTS.has(user.id)) { cacheAllComments(db, user.id); }
      res.send(ALL_COMMENTS.get(user.id));
      return;
    }
    res.sendFile(__dirname + '/welcome.html');
  });
  app.get('/popup', (req, res) => res.sendFile(__dirname + '/prelude.html'));
  app.get('/yamanote-favico.png', (req, res) => res.sendFile(__dirname + '/yamanote-favico.png'));
  app.get('/favicon.ico', (req, res) => res.sendFile(__dirname + '/yamanote-favico.png'));
  app.get('/prelude.js', (req, res) => res.sendFile(__dirname + '/prelude.js'));

  // bookmarks
  app.post(bookmarkPath.pattern, ensureAuthenticated, (req, res) => {
    const user = reqToUser(req);
    console.log(
        'POST! ',
        {title: req.body.title, url: req.body.url, comment: (req.body.comment || '').slice(0, 100), user: user.id});
    if (!req.body) {
      res.status(400).send('post json');
      return;
    }
    const [code, msg] = bodyToBookmark(db, req.body, user.id);
    if (code === 200) {
      assert(typeof msg === 'object', '200 will send JSON');
      res.json(msg);
      return;
    }
    assert(typeof msg === 'string', 'non-200 must be text');
    res.status(code).send(msg);
  });
  app.get(bookmarkIdPath.pattern, ensureAuthenticated, (req, res) => {
    const user = reqToUser(req);
    const bookmarkId = parseInt(req.params.id);
    const row: Selected<{render: string}> = db.prepare<{userId: number | bigint, bookmarkId: number | bigint}>(
                                                  `select render from bookmark where userId=$userId and id=$bookmarkId`)
                                                .get({userId: user.id, bookmarkId});
    if (row) {
      const prelude = readFileSync('prelude.html', 'utf8');
      const body = row.render;
      const link = bookmarkIdPath({id: req.params.id});
      const deleter = `<p class="danger delete-bookmark">
<button id="delete-comment-button-${
          bookmarkId}">Delete bookmark, comments, and backups?</button> A backup will be created so this can be undone manually, but as of now there’s no easy “undo” button.
<p>`;
      res.status(200).send([prelude, body, deleter].join('\n'));
      return;
    }
    res.status(401).send();
  });
  app.delete(bookmarkIdPath.pattern, ensureAuthenticated, (req, res) => {
    const user = reqToUser(req);
    const bookmarkId = parseInt(req.params.id);
    if (userBookmarkAuth(db, user, bookmarkId)) {
      console.log('Deleting ' + bookmarkId);
      const p = {bookmarkId};
      db.prepare<{bookmarkId: number}>(`delete from backup where bookmarkId=$bookmarkId`).run(p);
      db.prepare<{bookmarkId: number}>(`delete from media where bookmarkId=$bookmarkId`).run(p);
      db.prepare<{bookmarkId: number}>(`delete from comment where bookmarkId=$bookmarkId`).run(p);
      db.prepare<{bookmarkId: number}>(`delete from bookmark where id=$bookmarkId`).run(p);
      cacheAllBookmarks(db, user.id);
      res.status(200).send();
      return;
    }
    res.status(401).send();
  });

  // backups
  app.get(backupPath.pattern, ensureAuthenticated, (req, res) => {
    const user = reqToUser(req);
    const backup: Pick<Table.backupRow, 'content'>|undefined =
        db.prepare<{userId: number | bigint, bookmarkId: number | bigint}>(`select backup.content from backup
            inner join bookmark on bookmark.id=backup.bookmarkId
            where bookmarkId=$bookmarkId and userId=$userId
            order by backup.createdTime desc limit 1`)
            .get({bookmarkId: parseInt(req.params.bookmarkId), userId: user.id});
    if (backup) {
      // prevent the browser from going anywhere to request data. This disables external JS, CSS, images, etc.
      res.set({'Content-Security-Policy': `default-src 'self'`});
      res.send(backup.content);
    } else {
      res.status(409).send('not authorized');
    }
  });

  // media
  app.post(mediaPath.pattern, ensureAuthenticated, upload.array('files', maxFiles), (req, res) => {
    const bookmarkId = parseInt(req.params.bookmarkId);
    if (!userBookmarkAuth(db, reqToUser(req), bookmarkId)) {
      res.status(401).send();
      return;
    }

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
          if (!uniqueConstraintError(e)) { throw e; }
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
  app.get(/^\/media\//, ensureAuthenticated, (req, res) => {
    const match = req.url.match(/^\/media\/([0-9]+)\/(.+)$/);
    if (match) {
      const bookmarkId = parseInt(match[1]);
      if (!userBookmarkAuth(db, reqToUser(req), bookmarkId)) {
        res.status(401).send();
        return;
      }

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
  // This is for editing a comment in-place
  app.put(commentPath.pattern, ensureAuthenticated, function commentPut(req, res) {
    const commentId = parseInt(req.params.commentId);
    const {content} = req.body;
    if (isFinite(commentId) && typeof content === 'string') {
      const row: {bookmarkId: number} =
          db.prepare<{id: number}>(`select bookmarkId from comment where id=$id`).get({id: commentId});
      if (row && row.bookmarkId >= 0) { // sqlite row IDs start at 1 by the way
        const user = reqToUser(req);
        if (userBookmarkAuth(db, user, row.bookmarkId)) {
          db.prepare<{content: string, modifiedTime: number, id: number}>(
                `update comment set content=$content, modifiedTime=$modifiedTime where id=$id`)
              .run({content, modifiedTime: Date.now(), id: commentId});
          rerenderComment(db, commentId);
          rerenderJustBookmark(db, row.bookmarkId);
          cacheAllBookmarks(db, user.id);
          res.status(200).send();
          return;
        }
      } else {
        res.status(401).send();
      }
    }
    res.status(400).send();
  });

  // housekeeping
  app.get(mergePath.pattern, ensureAuthenticated, (req, res) => {
    // move comments, delete backup and media (don't delete blobs: they might be used by others and I don't want to
    // check that a blob is unused here). Delete bookmark.
    const user = reqToUser(req);
    const fromId = parseInt(req.params.fromId);
    const toId = parseInt(req.params.toId);
    if ([toId, fromId].every(id => userBookmarkAuth(db, user, id))) {
      db.prepare<{fromId: number, toId: number}>(`update comment set bookmarkId=$toId where bookmarkId=$fromId`)
          .run({fromId, toId});
      db.prepare<{fromId: number}>(`delete from backup where bookmarkId=$fromId`).run({fromId});
      db.prepare<{fromId: number}>(`delete from media where bookmarkId=$fromId`).run({fromId});
      db.prepare<{fromId: number}>(`delete from bookmark where id=$fromId`).run({fromId});

      // this might have changed the bookmark's `modifiedTime`
      const row: {createdTime: number}|undefined =
          db.prepare<{toId: number}>(`select max(createdTime) as createdTime from comment where bookmarkId=$toId`)
              .get({toId});
      if (row) {
        db.prepare<{toId: number, createdTime: number}>(`update bookmark set modifiedTime=$createdTime where id=$toId`)
            .run({toId, createdTime: row.createdTime});
        // TODO can I do both of these in one SQL update?
      }
      // should there be an `else`? The `else` should *never* run since that would mean there's a bookmark with no
      // comments

      rerenderJustBookmark(db, toId);
      cacheAllBookmarks(db, user.id);
      res.status(200).send();
      return;
    }
    res.status(401).send();
  });

  // metadata: sizes of various content
  app.get('/sizecheck', ensureAuthenticated, (req, res) => {
    const userId = reqToUser(req).id;
    const backups: {len: number, bookmarkId: string, url: string}[] = db.prepare<{userId: number | bigint}>(`
        select length(content) as len, bookmarkId, url
        from backup join bookmark on bookmark.id=backup.bookmarkId
        where bookmark.userId=$userId
        order by len desc limit 25`).all({userId});

    const blobs = db.prepare<{userId: number | bigint}>(`
        select length(content) as len, blob.sha256, bookmarkId, path, bookmark.url
        from blob
        join media on blob.sha256=media.sha256
        join bookmark on media.bookmarkId=bookmark.id
        where bookmark.userId=$userId
        order by len desc limit 25`)
                      .all({userId});

    res.json({backups, blobs});
  });

  const server: ReturnType<typeof app.listen> =
      await new Promise((resolve, reject) => {const server: http.Server = app.listen(port, () => resolve(server))});
  console.log(`Example app listening at http://localhost:${port}`);
  return {app, server, knex};
}

if (require.main === module) {
  (async function main() {
    mkdirpSync(__dirname + '/.data');
    const db = dbInit(__dirname + `/.data/yamanote-v${SCHEMA_VERSION_REQUIRED}.db`);
    ensureBookmarkCommentConsistency(db);

    const app = await startServer(db);

    if (0) {
      const all: SelectedAll<Table.commentRow> = db.prepare(`select * from comment order by modifiedTime desc`).all()
      for (const x of all) { rerenderComment(db, x); }
      cacheAllBookmarks(db, 1);
      console.log('done rerendering comments');
    }
    if (0) {
      const all: SelectedAll<Table.bookmarkRow> = db.prepare(`select * from bookmark order by modifiedTime desc`).all()
      for (const x of all) { rerenderJustBookmark(db, x); }
      cacheAllBookmarks(db, 1);
      console.log('done rerendering bookmarks');
    }
    {
      const title = 'TITLE YOU WANT TO DELETE';
      const res: SelectedAll<Table.bookmarkRow> = db.prepare(`select * from bookmark where title=$title`).all({title});
      if (res.length === 1) {
        console.log(`sqlite3 .data/yamanote-v${SCHEMA_VERSION_REQUIRED}.db
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