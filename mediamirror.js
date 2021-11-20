var sqlite3 = require('better-sqlite3');
var {JSDOM} = require('jsdom');
var fetch;
/*
// var fetch = require('node-fetch');
DOES NOT WORK in REPL, but that's ok: run this

fetch = (await import('node-fetch')).default;
*/
if (require.main === module) {
  (async function main() {
    fetch = (await import('node-fetch')).default; // meanwhile this will work in Node

    var db = sqlite3('yamanote.db');

    /**
     * @type{{content:string, url:string, title:string}[]}
     */
    var all =
        db.prepare(
              `select back.content, bm.url, bm.title, bm.id from backup as back left join bookmark as bm on back.bookmarkId = bm.id`)
            .all();

    // for (const x of all) { console.log([x.url, x.content.length / 1024, x.content.slice(0, 100)]) }

    function urls(content) {
      var x = new JSDOM(content);
      var imgs = Array.from(x.window.document.querySelectorAll('img')).map(o => o.src);
      imgs.push(...Array.from(x.window.document.querySelectorAll('source')).map(o => o.src))
      imgs.push(...Array.from(x.window.document.querySelectorAll('source')).map(o => o.srcset))

      var csses =
          Array.from(x.window.document.querySelectorAll('link')).filter(o => o.rel === 'stylesheet').map(o => o.href);
      return {img: new Set(imgs), css: new Set(csses), dom: x};
    }

    var twitters = all.filter(o => o.url?.includes('twitter.com'))
    var t = urls(twitters[0].content)

    var mediaCount = db.prepare(`select count(*) as count from media where path=$path`);
    var mediaInsert = db.prepare(`insert into media
    (path, mime, content, createdTime, numBytes)
    values ($path, $mime, $content, $createdTime, $numBytes)`);
    for (const img of t.img) {
      var row = mediaCount.get({path: img});
      if (!row || row.count === 0) {
        const response = await fetch(img);
        if (response.ok) {
          const blob = await response.arrayBuffer();
          const mime = response.headers.get('content-type');
          const media = {
            path: img,
            mime,
            content: Buffer.from(blob),
            createdTime: Date.now(),
            numBytes: blob.byteLength,
          };
          mediaInsert.run(media);
          console.log('inserted ' + img);
        } else {
          console.error('response error ' + response.status + ' ' + response.statusText);
        }
      } else {
        console.log('skipping ' + img);
      }
    }
  })();
}