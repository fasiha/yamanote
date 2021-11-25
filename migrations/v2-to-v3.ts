import assert from 'assert';
import sqlite3 from 'better-sqlite3';
import {readdirSync, readFileSync, renameSync} from 'fs';
import {JSDOM} from 'jsdom';

import * as Old from '../DbTablesV2';
import * as New from '../DbTablesV3';
import {sha256hash, uniqueConstraintError, updateDomUrls} from '../index';
import {SelectedAll} from '../pathsInterfaces'

type Db = ReturnType<typeof sqlite3>;

const FROM = 2;
const TO = 3;

function tables(db: Db) {
  const x: {name: string}[] = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  return x.map(o => o.name);
}

function up(a: Db, b: Db) {
  const tablesList = tables(a);
  for (const table of tablesList) {
    if (table.startsWith('_') || table.startsWith('change_log')) {
      continue;
    }
    if (table === 'media') {
      // skip copying until after all other rows copied, specifically we want backup copied because when we process
      // media table, we'll overwrite backup.content
    } else {
      const all: Record<string, string>[] = a.prepare(`select * from ${table}`).all();
      if (all.length === 0) {
        continue;
      }

      const keys = Object.keys(all[0]);
      const st = b.prepare(`insert into ${table} (${keys.join(',')}) values (${keys.map(s => '$' + s).join(',')})`);
      for (const x of all) { st.run(x); }
    }
  }

  {
    const backups: SelectedAll<Old.backupRow&Pick<Old.bookmarkRow, 'url'>> = a.prepare(`
      select backup.*, bookmark.url
      from backup inner join bookmark
      on bookmark.id=backup.bookmarkId`).all();

    const mediaSelect = a.prepare<{path: string}>(`select * from media where path=$path`);

    const mediaInsert = b.prepare<New.mediaRow>(`insert into media
          (path, bookmarkId, sha256, createdTime)
          values ($path, $bookmarkId, $sha256, $createdTime)`);

    const blobInsert = b.prepare<New.blobRow>(`insert into blob
          (content, mime, createdTime, numBytes, sha256)
          values ($content, $mime, $createdTime, $numBytes, $sha256)`);

    const backupContentUpdate = b.prepare<{content: string, id: number | bigint}>(`
          update backup set content=$content where id=$id`);

    for (const backup of backups) {
      const dom = new JSDOM(backup.original);
      const urls = updateDomUrls(dom, backup.url, backup.bookmarkId);
      backupContentUpdate.run({id: backup.id, content: dom.serialize()});
      for (const path of urls) {
        const medias: SelectedAll<Old.mediaRow> = mediaSelect.all({path});
        for (const oldMedia of medias) {
          const sha256 = sha256hash(oldMedia.content as Buffer);

          const newMedia:
              New.mediaRow = {path, bookmarkId: backup.bookmarkId, sha256, createdTime: oldMedia.createdTime};
          const newBlob: New.blobRow = {
            content: oldMedia.content,
            mime: oldMedia.mime,
            createdTime: oldMedia.createdTime,
            numBytes: oldMedia.createdTime,
            sha256
          };
          try {
            mediaInsert.run(newMedia);
            blobInsert.run(newBlob);
          } catch (e) {
            if (!uniqueConstraintError(e)) {
              throw e;
            }
          }
        }
      }
    }
  }
}

if (require.main === module) {
  const a = sqlite3('yamanote.db', {readonly: true});
  const randomString = `-${Math.random().toString(36).slice(2)}`;
  const bfname = `yamanote-v${TO}${randomString}.db`;
  const b = sqlite3(bfname);
  if (tables(b).length === 0) {
    b.pragma('journal_mode = WAL'); // https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/performance.md

    b.exec(readFileSync(`db-v${TO}.sql`, 'utf8'));

    up(a, b);

    const ls = readdirSync('.');
    for (const orig of ls.filter(s => s.startsWith(bfname))) {
      const dest = orig.replace(randomString, '');
      assert(!ls.includes(dest), 'will not overwrite')
      renameSync(orig, dest);
    }

    console.log(`done migrating v${FROM} to v${TO}`);
  } else {
    throw new Error(bfname + ' is not empty'); // should never happen, random names
  }
}