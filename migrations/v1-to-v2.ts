import assert from 'assert';
import sqlite3 from 'better-sqlite3';
import {readdirSync, readFileSync, renameSync} from 'fs';

export type Db = ReturnType<typeof sqlite3>;

function tables(db: Db) {
  const x: {name: string}[] = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  return x.map(o => o.name);
}

function up(a: Db, b: Db) {
  assert(tables(a).sort().join(',') === tables(b).sort().join(','), 'same tables');
  const tablesList = tables(a);
  for (const table of tablesList) {
    if (table.startsWith('_')) { continue; }
    if (table === 'media') {
      const all: Record<string, string>[] = a.prepare(`select * from ${table}`).all();
      if (all.length === 0) { continue; }
      const oldkeys = Object.keys(all[0]);
      const newkeys = oldkeys.map(o => o === 'filename' ? 'path' : o); // THE ONLY REPLACEMENT lol
      const st =
          b.prepare(`insert into ${table} (${newkeys.join(',')}) values (${newkeys.map(s => '$' + s).join(',')})`);
      for (const x of all) { st.run({...x, path: x.filename}); }
    } else if (table === 'backup') {
      const all: Record<string, string>[] = a.prepare(`select * from ${table}`).all();
      if (all.length === 0) { continue; }

      const keys = Object.keys(all[0]);
      keys.push('original')
      const st = b.prepare(`insert into ${table} (${keys.join(',')}) values (${keys.map(s => '$' + s).join(',')})`);
      for (const x of all) { st.run({...x, original: x.content}); }
    } else {
      const all: Record<string, string>[] = a.prepare(`select * from ${table}`).all();
      if (all.length === 0) { continue; }

      const keys = Object.keys(all[0]);
      const st = b.prepare(`insert into ${table} (${keys.join(',')}) values (${keys.map(s => '$' + s).join(',')})`);
      for (const x of all) { st.run(x); }
    }
  }
}

if (require.main === module) {
  const a = sqlite3('.data/yamanote.db', {readonly: true});
  const randomString = `-${Math.random().toString(36).slice(2)}`;
  const bfname = `.data/yamanote-v2${randomString}.db`;
  const b = sqlite3(bfname);
  if (tables(b).length === 0) {
    b.pragma('journal_mode = WAL'); // https://github.com/JoshuaWise/better-sqlite3/blob/master/docs/performance.md

    b.exec(readFileSync('db-v2.sql', 'utf8'));

    up(a, b);

    const ls = readdirSync('.');
    for (const orig of ls.filter(s => s.startsWith(bfname))) {
      const dest = orig.replace(randomString, '');
      assert(!ls.includes(dest), 'will not overwrite')
      renameSync(orig, dest);
    }

    console.log('done migrating v1 to v2');
  } else {
    throw new Error(bfname + ' is not empty'); // should never happen, random names
  }
}