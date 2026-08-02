/** Runtime stand-in for the app's `@/hooks/block.js`.
 *
 *  The real hooks subscribe to a `Repo`'s query handles. Standing one up here
 *  would mean a real database, which is what the integration tier is for —
 *  and it would also take away the one thing these tests need most: deciding
 *  exactly WHEN a query answers, and whether it has answered at all.
 *
 *  That distinction is the whole point of `useHandle` in `useProgram`:
 *  `undefined` means "no answer yet", `[]` means "answered, and there is
 *  nothing there". A logging surface must not read the first as a deletion.
 *  Here the test publishes each explicitly.
 *
 *  Aliased in `vitest.config.ts`; `src/` still imports the real path. */

import {useSyncExternalStore} from 'react'

type Rows = readonly unknown[] | undefined

const listeners = new Set<() => void>()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const emit = (): void => listeners.forEach(listener => listener())

let tree: Rows
let layoffs: readonly unknown[] = []

/** Back to "nothing has answered yet". Call in `beforeEach`. */
export const resetBlockHooks = (): void => {
  tree = undefined
  layoffs = []
  listeners.clear()
}

/** Answer the workout-tree query. Pass `[]` for "answered, empty" — which is
 *  a different thing from never calling this at all. */
export const publishTree = (rows: readonly unknown[]): void => {
  tree = rows
  emit()
}

export const publishLayoffs = (rows: readonly unknown[]): void => {
  layoffs = rows
  emit()
}

/** `useProgram` uses this for the workout tree, and only for that. */
export const useHandle = <T,>(): T | undefined =>
  useSyncExternalStore(subscribe, () => tree, () => tree) as T | undefined

/** …and this for layoffs, which have no unresolved state to model. */
export const useBlockQuery = <T,>(): readonly T[] =>
  useSyncExternalStore(subscribe, () => layoffs, () => layoffs) as readonly T[]
