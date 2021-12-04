import {encode} from 'html-entities';
import {URL} from 'url';

import * as Table from './DbTablesV4';
import {Db, FullRow, Selected, SelectedAll} from "./pathsInterfaces";
import {add1} from './utils';

export function rerenderComment(db: Db,
                                idOrComment: NonNullable<Selected<Table.commentRow>>|(number | bigint)): string {
  let id: number|bigint;
  let comment: Table.commentRow;
  if (typeof idOrComment === 'object') {
    id = idOrComment.id;
    comment = idOrComment;
  } else {
    id = idOrComment;
    comment = db.prepare(`select * from comment where id=$id`).get({id: idOrComment});
  }

  let anchor = `comment-${id}`;
  let timestamp = (new Date(comment.createdTime)).toISOString();
  if (comment.createdTime !== comment.modifiedTime) {
    const mod = (new Date(comment.modifiedTime)).toISOString();
    timestamp += ` → ${mod}`;
  }
  const anchorLink = ` <a title="Link to this comment" href="#${anchor}" class="emojilink">🔗</a>`;
  const editLink = ` <a title="Edit comment" id="edit-comment-button-${
      id}" href="#" class="emojilink edit-comment-button comment-button">💌</a>`;
  const render = `<div id="${anchor}" class="comment"><pre class="unrendered">
${encode(comment.content)}</pre>
${anchorLink}${editLink} ${timestamp}
</div>`;
  db.prepare(`update comment set render=$render, renderedTime=$renderedTime where id=$id`)
      .run({id, render, renderedTime: Date.now()});
  return render;
}

function encodeTitle(title: string): string {
  return encode(title.replace(/[\n\r]+/g, '↲')); // alternatives include pilcrow, ¶
}

type PartBookmark = Pick<FullRow<Table.bookmarkRow>, 'id'|'url'|'title'>;
export function renderBookmarkHeader(partBookmark: PartBookmark, idSuffix: string = ''): [string, string] {
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
export function rerenderJustBookmark(db: Db, idOrPartBookmark: (number|bigint)|PartBookmark,
                                     preexistingRenders?: {render: string}[]) {
  const bookmark = typeof idOrPartBookmark === 'object'
                       ? idOrPartBookmark
                       : db.prepare<Pick<PartBookmark, 'id'>>(`select url, title, id from bookmark where id=$id`).get({
                           id: idOrPartBookmark
                         }) as PartBookmark;
  const id = typeof idOrPartBookmark === 'object' ? idOrPartBookmark.id : idOrPartBookmark;
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