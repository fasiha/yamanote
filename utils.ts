export function groupBy<T, U, V>(arr: T[], f: (x: T) => U): Map<U, T[]> {
  const ret: Map<U, T[]> = new Map();
  for (const x of arr) {
    const y = f(x);
    const hit = ret.get(y);
    if (hit) {
      hit.push(x);
    } else {
      ret.set(y, [x]);
    }
  }
  return ret;
}

export function groupBy2<T, U, V>(arr: T[], f: (x: T) => U, g: (x: T, group?: V) => V): Map<U, V> {
  const ret: Map<U, V> = new Map();
  for (const x of arr) {
    const y = f(x);
    const hit = ret.get(y);
    ret.set(y, g(x, hit));
  }
  return ret;
}

export function add1(x: number|bigint): number|bigint {
  if (typeof x === 'number') { return x + 1; }
  return x + BigInt(1);
}