/*
How I did this migrations (previous ones very similar):
1- create db-v4.sql
2- add `4` to `makeSchema.js`
3- run `node makeSchema.js`
4- copy the old `v2-to-v3.ts` to `v3-to-v4.ts` and rewrite it
5- run `node migrations/v3-to-v4.js` (thanks VS Code watch)
*/

import assert from 'assert';
import sqlite3 from 'better-sqlite3';
import {readdirSync, readFileSync, renameSync} from 'fs';

import * as Old from '../DbTablesV3';
import * as New from '../DbTablesV4';
import {justCreateBackupTable} from '../makeBackupTriggers';
import {FullRow, SelectedAll} from '../pathsInterfaces'
import {groupBy2} from '../utils';

type Db = ReturnType<typeof sqlite3>;

const FROM = 3;
const TO = 4;

function tables(db: Db) {
  const x: {name: string}[] = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  return x.map(o => o.name);
}

function up(a: Db, b: Db) {
  const tablesList = tables(a);
  for (const table of tablesList) {
    // of course we want to migrate our change_log. TODO rename it to not have _ so this check won't be needed for v5
    if (table.startsWith('_') && !table.includes('change_log')) { continue; }
    if (table === 'bookmark' || table === 'comment') {
      // skip copying until after all other tables: these two have to be dealt with carefully
    } else {
      // all other tables have no changes and this will throw if we forget that a table had a name change
      const all: Record<string, string>[] = a.prepare(`select * from ${table}`).all();
      if (all.length === 0) { continue; }

      const keys = Object.keys(all[0]);
      const st = b.prepare(`insert into ${table} (${keys.join(',')}) values (${keys.map(s => '$' + s).join(',')})`);
      for (const x of all) { st.run(x); }
    }
  }

  {
    const commentsOldestFirst: SelectedAll<Old.commentRow> =
        a.prepare(`select * from comment order by createdTime asc`).all();

    const bookmarkIdToNumComments: Map<number|bigint, number> = new Map();
    const bookmarkIdToCommentIdToComment = groupBy2(
        commentsOldestFirst, comment => comment.bookmarkId,
        (comment, group?: {commentIdToIdx: Map<number|bigint, number>}) => {
          bookmarkIdToNumComments.set(comment.bookmarkId, (bookmarkIdToNumComments.get(comment.bookmarkId) ?? 0) + 1)
          if (group) {
            group.commentIdToIdx.set(comment.id, group.commentIdToIdx.size + 1);
            return group;
          }
          // start at 1 like sqlite. I know I'll regret this either way...
          return { commentIdToIdx: new Map([[comment.id, 1]]) }
        });

    {
      // we can now migrate `bookmark` table: we have a new column, `numComments`
      const bookmarks: SelectedAll<Old.bookmarkRow> = a.prepare(`select * from bookmark`).all();
      const s = b.prepare<FullRow<New.bookmarkRow>>(`insert into bookmark
          (id, userId, url, title, createdTime, modifiedTime, numComments, render, renderedTime)
          values
          ($id, $userId, $url, $title, $createdTime, $modifiedTime, $numComments, $render, $renderedTime)`);
      for (const old of bookmarks) {
        const numComments = bookmarkIdToNumComments.get(old.id);
        if (!numComments) { throw new Error('no comments found for ' + old.id); }
        const b: FullRow<New.bookmarkRow> = {...old, numComments};
        s.run(b)
      }
    }

    {
      // and the comments table. Three new columns: `siblingIdx` and `innerRender` and `fullRender`
      const s = b.prepare<FullRow<New.commentRow>>(`insert into comment 
          (id, bookmarkId, siblingIdx, content, createdTime, modifiedTime, innerRender, fullRender, renderedTime)
          values
          ($id, $bookmarkId, $siblingIdx, $content, $createdTime, $modifiedTime, $innerRender, $fullRender, $renderedTime)`);
      for (const old of commentsOldestFirst) {
        const innerRender = old.render;
        const fullRender = old.render;
        const siblingIdx = bookmarkIdToCommentIdToComment.get(old.bookmarkId)?.commentIdToIdx.get(old.id);
        assert(typeof siblingIdx === 'number', 'bookmarkId => commentId => sibling idx failed?');
        const replacement: FullRow<New.commentRow> = {...old, siblingIdx, innerRender, fullRender};
        s.run(replacement);
      }
    }
  }
}

if (require.main === module) {
  const dataDir = '.data';
  const a = sqlite3(`${dataDir}/yamanote-v${FROM}.db`, {readonly: true});
  const randomString = `-${Math.random().toString(36).slice(2)}`;
  const bfname = `yamanote-v${TO}${randomString}.db`;
  const b = sqlite3(`${dataDir}/` + bfname);
  if (tables(b).length === 0) {
    b.pragma('journal_mode = WAL'); // https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/performance.md

    b.exec(readFileSync(`db-v${TO}.sql`, 'utf8'));
    justCreateBackupTable(b);

    up(a, b);

    a.close();
    b.close(); // merges `-wal` and `-shm` files into the db file?

    // rename to remove random part of filename
    const ls = readdirSync(dataDir);
    for (const orig of ls.filter(s => s.startsWith(bfname))) {
      const dest = orig.replace(randomString, '');
      assert(!ls.includes(dest), 'will not overwrite')
      console.log(`moving ${orig} ${dest}`);
      renameSync(dataDir + '/' + orig, dataDir + '/' + dest);
    }

    console.log(`done migrating v${FROM} to v${TO}`);
  } else {
    throw new Error(bfname + ' is not empty'); // should never happen, random names
  }
}