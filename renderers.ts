import assert from 'assert';
import {encode} from 'html-entities';
import {URL} from 'url';

import * as Table from './DbTablesV4';
import {Db, FullRow, Selected, SelectedAll} from "./pathsInterfaces";
import {add1} from './utils';

export type CoreBookmark = Pick<FullRow<Table.bookmarkRow>, 'id'|'url'|'title'|'numComments'>;
export type CoreComment = Pick<FullRow<Table.commentRow>, 'createdTime'|'id'|'modifiedTime'|'content'|'siblingIdx'>;

export function rerenderCoreComment(db: Db, comment: CoreComment): string {
  const id = comment.id;

  let anchor = `comment-${id}`;
  let timestamp = (new Date(comment.createdTime)).toISOString();
  if (comment.createdTime !== comment.modifiedTime) {
    const mod = (new Date(comment.modifiedTime)).toISOString();
    timestamp += ` → ${mod}`;
  }
  const anchorLink = ` <a title="Link to this comment" href="#${anchor}" class="emojilink">🔗</a>`;
  const editLink = ` <a title="Edit comment" id="edit-comment-button-${
      id}" href="#" class="emojilink edit-comment-button comment-button">💌</a>`;

  const innerRender = `<div id="${anchor}" class="comment"><pre class="unrendered">
      ${encode(comment.content)}</pre>
      ${anchorLink}${editLink} ${timestamp}
      </div>`;

  // db.prepare<Pick<Table.commentRow, 'innerRender'|'renderedTime'|'id'>>(
  //       `update comment set innerRender=$innerRender, renderedTime=$renderedTime where id=$id`)
  //     .run({id, innerRender, renderedTime: Date.now()});
  return innerRender;
}

export function rerenderPartialComment(db: Db, idOrComment: CoreComment|(number | bigint), bookmark: CoreBookmark) {
  let id: number|bigint;
  let comment: CoreComment;
  if (typeof idOrComment === 'object') {
    id = idOrComment.id;
    comment = idOrComment;
  } else {
    id = idOrComment;
    comment =
        db.prepare(`select createdTime, id, modifiedTime, content, siblingIdx from comment where id=$id`).get({id});
  }

  assert(bookmark.id && 'title' in bookmark && 'url' in bookmark && bookmark.numComments, 'bookmark valid');

  const coreRender = rerenderCoreComment(db, comment);

  const codas = ['<span class="coda"> '];
  if (comment.siblingIdx < bookmark.numComments) {
    codas.push(
        `<a class="emojilink coda-prev" href="#bookmark-${bookmark.id}-comment-${add1(comment.siblingIdx)}">👈</a>`);
  }
  if (comment.siblingIdx > 1) {
    codas.push(
        `<a class="emojilink coda-next" href="#bookmark-${bookmark.id}-comment-${add1(comment.siblingIdx, -1)}">👉</a>`);
  }
  if (bookmark.numComments > 1) {
    codas.push(`<span class="coda-this">${comment.siblingIdx}/${bookmark.numComments}</span>`);
  }
  codas.push('</span>');
  const coda = codas.join(' ');

  const suffix = `-comment-${comment.siblingIdx}`;
  const [pre, post] = renderBookmarkHeader(bookmark, suffix);
  const partial = [pre, coreRender, coda, post].join('');

  // TODO FIXME race condition possible here if siblingIdx or numComments changes under our feet
  // Check via common table expression in UPDATE https://sqlite.org/lang_update.html
  db.prepare<{bookmarkId: number | bigint, id: number | bigint, partial: string, renderedTime: number}>(`
        with cte as (select numComments from bookmark where bookmark.id=$bookmarkId)
        update comment set 
        innerRender=$partial,
        fullRender=replace(replace($partial, "%TOTAL", cte.numComments), "%SIBLING", comment.siblingIdx),
        renderedTime=$renderedTime
        where id=$id`)
      .run({id, partial, bookmarkId: bookmark.id, renderedTime: Date.now()});
}

function encodeTitle(title: string): string {
  return encode(title.replace(/[\n\r]+/g, '↲')); // alternatives include pilcrow, ¶
}

export function renderBookmarkHeader(partBookmark: CoreBookmark, idSuffix: string = ''): [string, string] {
  const {id, url, title} = partBookmark;
  const anchor = `bookmark-${id}${idSuffix}`;

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
  header += ` <a title="Link to this bookmark" href="#${anchor}" class="emojilink">🔗</a>`;
  header += ` <a title="Add a comment" id="add-comment-button-${
      id}" href="#" class="emojilink add-comment-button comment-button">💌</a>`;
  header += ` <a title="See raw snapshot" href="/backup/${id}" class="emojilink">💁</a>`;
  header += ` <a title="See just this bookmark (and delete it)" href="/bookmark/${id}" class="emojilink">💥</a>`;
  const pre = `<div id="${anchor}" class="bookmark"><span class="bookmark-header">${header}</span>`
  const post = `</div>`;
  return [pre, post];
}

// as in, don't recurse into comments to render those: assume those are fine.
export function rerenderJustBookmark(db: Db, idOrPartBookmark: (number|bigint)|CoreBookmark,
                                     preexistingRenders?: {render: string}[]) {
  let id: number|bigint;
  let bookmark: CoreBookmark;
  if (typeof idOrPartBookmark === 'object') {
    id = idOrPartBookmark.id;
    bookmark = idOrPartBookmark;
  } else {
    id = idOrPartBookmark;
    bookmark = db.prepare<Pick<CoreBookmark, 'id'>>(`select url, title, id from bookmark where id=$id`).get({
      id: idOrPartBookmark
    });
  }

  if (!bookmark) { throw new Error('unknown bookmark ' + idOrPartBookmark); }
  const [pre, post] = renderBookmarkHeader(bookmark);

  let commentsRender = '';
  if (!preexistingRenders) {
    const rows: SelectedAll<Pick<Table.commentRow, 'innerRender'>> =
        db.prepare<{id: number | bigint}>(
              `select innerRender from comment where bookmarkId=$id order by createdTime desc`)
            .all({id});
    commentsRender = rows.map(o => o.innerRender).join('\n');
  } else {
    commentsRender = preexistingRenders.map(o => o.render).join('\n');
  }

  // As a super-fast way to update renders upon re-bookmarking, let the entire header live on a single line
  const render = [pre, commentsRender, post].join('\n');
  db.prepare<Pick<Table.bookmarkRow, 'render'|'renderedTime'|'id'>>(
        `update bookmark set render=$render, renderedTime=$renderedTime where id=$id`)
      .run({render, renderedTime: Date.now(), id});
}

export function fastUpdateBookmarkWithNewComment(db: Db, bookmarkRender: string, bookmarkId: number|bigint,
                                                 commentRender: string, numComments: number|bigint) {
  // Update bookmark if it exists
  const now = Date.now();

  const breakStr = '\n';
  const newline = bookmarkRender.indexOf(breakStr);
  if (newline < 0) { throw new Error('no newline in render ' + bookmarkId); }
  // RERENDER: assume first line is the bookmark stuff, and after newline, we have comments
  const newRender = bookmarkRender.substring(0, newline + breakStr.length) + commentRender + '\n' +
                    bookmarkRender.slice(newline + breakStr.length);
  db.prepare<Pick<Table.bookmarkRow, 'render'|'renderedTime'|'modifiedTime'|'numComments'|'id'>>(
        `update bookmark set render=$render, renderedTime=$renderedTime, modifiedTime=$modifiedTime, numComments=$numComments where id=$id`)
      .run({render: newRender, renderedTime: now, modifiedTime: now, id: bookmarkId, numComments: add1(numComments)})
}