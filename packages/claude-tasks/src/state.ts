/**
 * Persisted daemon state: query-watcher cursors and the spend-limiter's
 * launch timestamps. Backlink watchers deliberately do NOT keep cursors
 * here — their state lives on the blocks themselves — but the launch
 * log MUST persist, otherwise the runsPerHour circuit-breaker re-arms on
 * every crash/restart (the exact loop it exists to bound).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { isErrnoException } from '@knowledge-medium/agent-cli/config'

interface StateData {
  queryCursors: Record<string, string[]>
  /** Epoch-ms of recent run launches; pruned to the rolling window. */
  launchTimes: number[]
}

const emptyState = (): StateData => ({queryCursors: {}, launchTimes: []})

const normalizeState = (value: unknown): StateData => {
  const state = emptyState()
  if (!value || typeof value !== 'object') return state

  const cursors = (value as {queryCursors?: unknown}).queryCursors
  if (cursors && typeof cursors === 'object') {
    for (const [name, ids] of Object.entries(cursors as Record<string, unknown>)) {
      if (Array.isArray(ids) && ids.every(id => typeof id === 'string')) {
        state.queryCursors[name] = ids
      }
    }
  }

  const launches = (value as {launchTimes?: unknown}).launchTimes
  if (Array.isArray(launches)) {
    state.launchTimes = launches.filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms))
  }
  return state
}

export interface StateStore {
  /** null = never seen (first run baselines without firing). */
  getCursor: (watcherName: string) => Promise<string[] | null>
  setCursor: (watcherName: string, ids: string[]) => Promise<void>
  /** Launch timestamps within the retention window (persisted). */
  getLaunchTimes: () => Promise<number[]>
  /** Replace the persisted launch log (caller prunes to the window). */
  setLaunchTimes: (times: number[]) => Promise<void>
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

  // Serialize writes: launch-log and cursor persists both fire (some
  // fire-and-forget) and share one `.tmp` path — concurrent writes to it
  // could interleave into truncated JSON. A promise chain makes them
  // strictly sequential without a lock library.
  let writeChain: Promise<void> = Promise.resolve()

  const persist = (state: StateData): Promise<void> => {
    const snapshot = `${JSON.stringify(state, null, 2)}\n`
    const result = writeChain.then(async () => {
      await fs.mkdir(path.dirname(filePath), {recursive: true})
      // tmp + rename: a crash mid-write must not leave truncated JSON
      // (which load() would silently treat as "never seen anything").
      const tmpPath = `${filePath}.tmp`
      await fs.writeFile(tmpPath, snapshot)
      await fs.rename(tmpPath, filePath)
    })
    // The chain swallows failures so one bad write doesn't wedge every
    // later persist; the caller still sees the real outcome via `result`.
    writeChain = result.catch(() => {})
    return result
  }

  return {
    getCursor: async name => (await load()).queryCursors[name] ?? null,
    setCursor: async (name, ids) => {
      const state = await load()
      state.queryCursors[name] = ids
      await persist(state)
    },
    getLaunchTimes: async () => [...(await load()).launchTimes],
    setLaunchTimes: async times => {
      const state = await load()
      state.launchTimes = times
      await persist(state)
    },
  }
}
