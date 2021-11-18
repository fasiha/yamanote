import sqlite3 from 'better-sqlite3';
import * as t from 'io-ts';
import {Params, path, Path} from 'static-path';

export type paramify<T> =
    T extends Path<infer X>? Params<X>: never; // https://github.com/garybernhardt/static-path/issues/5
export const filenamePath = path('/media/:filename');
export const mediaPath = path('/media');
export const bookmarkPath = path('/bookmark');
export type Db = ReturnType<typeof sqlite3>;

/**
 * We need someting like `Selected` because sql-ts emits my tables' `id` as
 * `null|number` because I don't have to specify an `INTEGER PRIMARY KEY` when
 * *inserting*, as SQLite will make it for me. However, when *selecting*, the
 * `INTEGER PRIMARY KEY` field *will* be present.
 *
 * This could also be:
 * ```
 * type Selected<T> = Required<{[k in keyof T]: NonNullable<T[k]>}>|undefined;
 * ```
 * The above says "*All* keys are required and non-nullable". But I think it's
 * better to just use our knowledge that `id` is the only column thus affected,
 * as below. If we ever add more nullable columns, the following is safer:
 */
export type Selected<T> = (T&{id: number | bigint})|undefined;

export type SelectedAll<T> = NonNullable<Selected<T>>[];

export const BookmarkPost = t.partial({
  id: t.number,
  url: t.string,
  title: t.string,
  html: t.string,
  comment: t.string,
  quote: t.boolean,
});
// the above is a runtime const. The below is a compile-time type. This is ok, I promise.
export type BookmarkPost = t.TypeOf<typeof BookmarkPost>;
