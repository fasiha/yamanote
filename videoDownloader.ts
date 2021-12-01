/*
This relies on index.ts to replace <video> tags' src in the backup's `content`.

This script will look at backup's `original`, which will have the original URLs, and, if needed, download them via
youtube-dl and add them to the `media` table.

That way, when you browse the backup, videos should automatically work.
*/
import sqlite3 from 'better-sqlite3';
import {spawnSync} from 'child_process';
import {readdirSync, readFileSync, rmSync} from 'fs';
import {JSDOM} from 'jsdom';
import mime from 'mime';

import * as Table from './DbTablesV2';
import {
  Db,
} from './pathsInterfaces';

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

function downloadVideos(db: Db, bookmarkId: number|bigint) {
  const row: Pick<Table.backupRow, 'original'> =
      db.prepare<{bookmarkId: number | bigint}>('select original from backup where bookmarkId=$bookmarkId')
          .get({bookmarkId});
  const bookmark: Pick<Table.bookmarkRow, 'url'> =
      db.prepare<{id: number | bigint}>('select url from bookmark where id=$id').get({id: bookmarkId});
  if (!row || !row.original || !bookmark || !bookmark.url) { return; }

  const dom = new JSDOM(row.original);

  const mediaCount = db.prepare<{path: string}>(`select count(*) as count from media where path=$path`);
  const mediaInsert = db.prepare<Table.mediaRow>(`insert into media
  (path, mime, content, createdTime, numBytes)
  values ($path, $mime, $content, $createdTime, $numBytes)`);

  for (const video of dom.window.document.querySelectorAll('video')) {
    const src = fixUrl(video.src, bookmark.url);
    if (!src) { continue; }
    const row: {count: number} = mediaCount.get({path: src});
    if (!row || row.count === 0) {
      const randbasename = Math.random().toString(36).slice(2);

      const spawned = spawnSync('youtube-dl', ['-q', '-o', `${randbasename}.%(ext)s`, src]);
      if (spawned.status === 0) {
        const ls = readdirSync('.');
        const found = ls.find(s => s.startsWith(randbasename));
        if (found) {
          const inferredMime = mime.getType(found) || '';
          const buf = readFileSync(found);
          const media: Table.mediaRow =
              {path: src, mime: inferredMime, content: buf, createdTime: Date.now(), numBytes: buf.byteLength};
          mediaInsert.run(media);
          console.log(`committed ${found} with mime ${inferredMime} for ${src}, bookmarkId=${bookmarkId}`);
          rmSync(found);
        } else {
          console.error(`cannot find ${randbasename}`);
        }
      } else {
        console.error(`bookmark=${bookmarkId} youtube-dl failed to download ${src}`);
        console.error(spawned.stdout.toString())
        console.error(spawned.stderr.toString())
      }
    }
  }
}

if (require.main === module) {
  const db = sqlite3('.data/yamanote.db');
  const ids: {id: number|bigint}[] = db.prepare('select id from bookmark').all()
  for (const {id} of ids) { downloadVideos(db, id); }
  console.log('done downloading all images');
}
