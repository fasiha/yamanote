import {Params, path, Path} from 'static-path';
import * as Table from './DbTables';

export type paramify<T> =
    T extends Path<infer X>? Params<X>: never; // https://github.com/garybernhardt/static-path/issues/5
export const filenamePath = path('/media/:filename');
export const mediaPath = path('/media');
export const bookmarkPath = path('/bookmark');
