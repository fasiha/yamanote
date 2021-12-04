import sqlite3 from 'better-sqlite3';
import * as t from 'io-ts';
import {path} from 'static-path';

// export const filenamePath = path('/media/:filename');
export const mediaPath = path('/media/:bookmarkId');
export const bookmarkPath = path('/bookmark');
export const bookmarkIdPath = path('/bookmark/:id');
export const backupPath = path('/backup/:bookmarkId');
export const commentPath = path('/comment/:commentId');
export const tokenPath = path('/auth/token');
export const tokensPath = path('/auth/tokens');
export const mergePath = path('/merge/:fromId/:toId');

export type Db = ReturnType<typeof sqlite3>;

export function uniqueConstraintError(e: unknown): boolean {
  return e instanceof sqlite3.SqliteError && e.code === 'SQLITE_CONSTRAINT_UNIQUE';
}

/**
 * We need someting like `FullRow` because sql-ts emits my tables' `id` as
 * `null|number` because I don't have to specify an `INTEGER PRIMARY KEY` when
 * *inserting*, as SQLite will make it for me. However, when *selecting*, the
 * `INTEGER PRIMARY KEY` field *will* be present.
 *
 * The below says "*All* keys are required and non-nullable".
 */
export type FullRow<T> = Required<{[k in keyof T]: NonNullable<T[k]>}>;
export type Selected<T> = FullRow<T>|undefined;
export type SelectedAll<T> = FullRow<T>[];

export const AddBookmarkOrCommentPayload = t.intersection([
  t.type({
    _type: t.literal('addBookmarkOrComment'),
    url: t.string,
    title: t.string,
    comment: t.string,
  }),
  // Above are REQUIRED. Below are OPTIONAL (`partial`)
  t.partial({
    html: t.string,
    quote: t.boolean,
  }),
]);
// the above is a runtime const. The below is a compile-time type. This is ok, I promise.
export type AddBookmarkOrCommentPayload = t.TypeOf<typeof AddBookmarkOrCommentPayload>;

export const AddCommentOnlyPayload = t.type({
  _type: t.literal('addCommentOnly'),
  id: t.number,
  comment: t.string,
});

export const AddHtmlPayload = t.type({
  _type: t.literal('addHtml'),
  id: t.number,
  html: t.string,
});

export const AskForHtmlPayload = t.type({
  id: t.union([t.number, t.bigint]),
  htmlWanted: t.boolean,
});
export type AskForHtmlPayload = t.TypeOf<typeof AskForHtmlPayload>;

export const Env = t.type({
  GITHUB_CLIENT_ID: t.string,
  GITHUB_CLIENT_SECRET: t.string,
  SESSION_SECRET: t.string,
  GITHUB_ID_ALLOWLIST: t.string,
  URL: t.string,
});
export type Env = t.TypeOf<typeof Env>;