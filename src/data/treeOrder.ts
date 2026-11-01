import type { BlockData } from '@/data/api'

/** Whether path `a` renders before path `b`: an ancestor before its
 *  descendants, siblings as every children query sorts them (order key,
 *  then id). Each path runs down from a root, or any shared ancestor, to
 *  its block; paths that start at different blocks have no order. */
export const precedesInTree = (a: readonly BlockData[], b: readonly BlockData[]): boolean => {
  if (a[0].id !== b[0].id) return false
  for (let depth = 1; depth < Math.min(a.length, b.length); depth++) {
    const [x, y] = [a[depth], b[depth]]
    if (x.id === y.id) continue
    return x.orderKey < y.orderKey || (x.orderKey === y.orderKey && x.id < y.id)
  }
  return a.length < b.length
}
