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
 *  Extended for Sleep Lab: `useData` / `usePropertyValue` model a single
 *  block's own reactive row (the night/dose decorators' raw-property reads,
 *  mirroring the Strength Tracker's `SetLine`), published per block id
 *  rather than as one shared query result. `useWorkspaceId` is fixed —
 *  every test publishes rows under the one workspace id below, and nothing
 *  here exercises a multi-workspace UI.
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
/** Per-block published rows, keyed by block id — what `useData` /
 *  `usePropertyValue` read. Separate from `layoffs`/`tree`, which model a
 *  QUERY result rather than one block's own row. */
let blocks = new Map<string, {properties: Record<string, unknown>}>()

/** Back to "nothing has answered yet". Call in `beforeEach`. */
export const resetBlockHooks = (): void => {
  tree = undefined
  layoffs = []
  blocks = new Map()
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

/** Publish (or clear, with `undefined`) one block's row. */
export const publishBlock = (id: string, data: {properties: Record<string, unknown>} | undefined): void => {
  if (data === undefined) blocks.delete(id)
  else blocks.set(id, data)
  emit()
}

/** `useProgram` uses this for the workout tree, and only for that. */
export const useHandle = <T,>(): T | undefined =>
  useSyncExternalStore(subscribe, () => tree, () => tree) as T | undefined

/** …and this for layoffs, which have no unresolved state to model. Also
 *  Sleep Lab's `useLabRows`, which ignores the query argument the same way
 *  the real hook's caller shape allows a fake to. */
export const useBlockQuery = <T,>(): readonly T[] =>
  useSyncExternalStore(subscribe, () => layoffs, () => layoffs) as readonly T[]

/** Reactive read of one block's raw row, keyed by `block.id` — the
 *  decorators' own raw-property path (`DoseLine`'s todo-status read). */
export const useData = (block: {id: string}): {properties: Record<string, unknown>} | undefined =>
  useSyncExternalStore(subscribe, () => blocks.get(block.id), () => blocks.get(block.id))

/** Reads through the same per-block store as `useData`, falling back to the
 *  schema's own default when the property is absent — the real hook's
 *  contract. The setter is unused by anything under test (every write here
 *  goes through a km function, never the raw property setter), so it is a
 *  documented no-op rather than a faithful `repo.mutate` round-trip. */
export const usePropertyValue = <T,>(
  block: {id: string}, schema: {name: string; defaultValue: T},
): [T, (value: T) => void] => {
  const data = useData(block)
  const raw = data?.properties[schema.name]
  return [(raw === undefined ? schema.defaultValue : raw) as T, () => {}]
}

export const WORKSPACE_ID = 'ws-1'

/** Fixed: nothing under test switches workspaces mid-render. */
export const useWorkspaceId = (): string => WORKSPACE_ID
