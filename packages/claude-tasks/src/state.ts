/**
 * Cursor persistence for query watchers. Backlink watchers deliberately
 * do NOT use this — their state lives on the blocks themselves — so the
 * file only holds "which row ids has each query watcher already seen".
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isErrnoException } from '@knowledge-medium/agent-cli/config'

interface StateData {
  queryCursors: Record<string, string[]>
}

const emptyState = (): StateData => ({queryCursors: {}})

const normalizeState = (value: unknown): StateData => {
  if (!value || typeof value !== 'object') return emptyState()
  const cursors = (value as {queryCursors?: unknown}).queryCursors
  if (!cursors || typeof cursors !== 'object') return emptyState()

  const queryCursors: Record<string, string[]> = {}
  for (const [name, ids] of Object.entries(cursors as Record<string, unknown>)) {
    if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
      queryCursors[name] = ids
    }
  }
  return {queryCursors}
}

export interface StateStore {
  /** null = never seen (first run baselines without firing). */
  getCursor: (watcherName: string) => Promise<string[] | null>
  setCursor: (watcherName: string, ids: string[]) => Promise<void>
}

export const createStateStore = (filePath: string): StateStore => {
  let cache: StateData | null = null

  const load = async (): Promise<StateData> => {
    if (cache) return cache
    try {
      cache = normalizeState(JSON.parse(await fs.readFile(filePath, 'utf8')))
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') cache = emptyState()
      else if (error instanceof SyntaxError) cache = emptyState()
      else throw error
    }
    return cache
  }

  const persist = async (state: StateData): Promise<void> => {
    await fs.mkdir(path.dirname(filePath), {recursive: true})
    await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  return {
    getCursor: async name => (await load()).queryCursors[name] ?? null,
    setCursor: async (name, ids) => {
      const state = await load()
      state.queryCursors[name] = ids
      await persist(state)
    },
  }
}
