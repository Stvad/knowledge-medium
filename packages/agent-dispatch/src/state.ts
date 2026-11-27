/**
 * Persisted daemon state: query-watcher cursors, backlink-watcher
 * baselines, and the spend-limiter's launch timestamps. Backlink
 * watchers keep per-TASK state on the blocks themselves (restart
 * re-derives the queue), but their first-tick baseline lives here —
 * and the launch log MUST persist, otherwise the runsPerHour
 * circuit-breaker re-arms on every crash/restart (the exact loop it
 * exists to bound).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { Watcher } from './config.js'
import { isErrnoException } from '@knowledge-medium/agent-cli/config'

// Snapshots preserve prompt columns when a claim or the run's edits remove
// the row from its SQL result. The block owns status and attempt count.
const rowTaskState = z.object({
  baselineIds: z.array(z.string()),
  baselineMs: z.number(),
  pending: z.array(z.looseObject({id: z.string().min(1)})),
})
export type RowTaskState = z.infer<typeof rowTaskState>

interface StateData {
  rowTasks: Record<string, RowTaskState>
  queryCursors: Record<string, string[]>
  /** Epoch-ms of recent run launches; pruned to the rolling window. */
  launchTimes: number[]
  /** Per-backlink-watcher first-tick timestamp: blocks edited before it
   *  are pre-existing content and never become tasks. */
  backlinkBaselines: Record<string, number>
}

const emptyState = (): StateData => ({rowTasks: {}, queryCursors: {}, launchTimes: [], backlinkBaselines: {}})

const normalizeState = (value: unknown, requireObjectRoot: boolean): StateData => {
  const state = emptyState()
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (requireObjectRoot) throw new Error('state root must be an object')
    return state
  }

  if ('rowTasks' in value) state.rowTasks = z.record(z.string(), rowTaskState).parse(value.rowTasks)

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

  const baselines = (value as {backlinkBaselines?: unknown}).backlinkBaselines
  if (baselines && typeof baselines === 'object') {
    for (const [name, ms] of Object.entries(baselines as Record<string, unknown>)) {
      if (typeof ms === 'number' && Number.isFinite(ms)) state.backlinkBaselines[name] = ms
    }
  }
  return state
}

export interface StateStore {
  getRowTasks: (key: string) => Promise<RowTaskState | null>
  setRowTasks: (key: string, snapshot: RowTaskState) => Promise<void>
  /** null = never seen (first run baselines without firing). */
  getCursor: (watcherName: string) => Promise<string[] | null>
  setCursor: (watcherName: string, ids: string[]) => Promise<void>
  /** null = watcher never ticked (first tick sets it without firing). */
  getBaseline: (watcherName: string) => Promise<number | null>
  setBaseline: (watcherName: string, ms: number) => Promise<void>
  /** Launch timestamps within the retention window (persisted). */
  getLaunchTimes: () => Promise<number[]>
  /** Replace the persisted launch log (caller prunes to the window). */
  setLaunchTimes: (times: number[]) => Promise<void>
}

export const createStateStore = (filePath: string, watchers: readonly Watcher[] = []): StateStore => {
  const hasRowTasks = watchers.some(watcher => watcher.kind === 'query' && watcher.rowTasks)
  let cache: StateData | null = null

  const load = async (): Promise<StateData> => {
    if (cache) return cache
    const contents = await fs.readFile(filePath, 'utf8').catch(error => {
      if (isErrnoException(error) && error.code === 'ENOENT') return '{}'
      throw error
    })
    try {
      cache = normalizeState(JSON.parse(contents), hasRowTasks)
    } catch (error) {
      if (hasRowTasks) {
        throw new Error(`state file at ${filePath} contains invalid state. Restore a valid copy to resume.`, {cause: error})
      }
      if (error instanceof SyntaxError) cache = emptyState()
      else throw error
    }
    return cache
  }

  // Serialize writes: launch-log and cursor persists both fire (some
  // fire-and-forget) and share one `.tmp` path — concurrent writes to it
  // could interleave into truncated JSON. A promise chain makes them
  // strictly sequential without a lock library.
  let writeChain: Promise<void> = Promise.resolve()

  const persist = (update: (state: StateData) => StateData): Promise<void> => {
    const result = writeChain.then(async () => {
      const next = update(await load())
      const snapshot = `${JSON.stringify(next, null, 2)}\n`
      await fs.mkdir(path.dirname(filePath), {recursive: true})
      const tmpPath = `${filePath}.tmp`
      await fs.writeFile(tmpPath, snapshot, {mode: 0o600})
      await fs.rename(tmpPath, filePath)
      cache = next
    })
    // The chain swallows failures so one bad write doesn't wedge every
    // later persist; the caller still sees the real outcome via `result`.
    writeChain = result.catch(() => {})
    return result
  }

  return {
    getRowTasks: async key => (await load()).rowTasks[key] ?? null,
    setRowTasks: (key, snapshot) => persist(state => ({...state, rowTasks: {...state.rowTasks, [key]: snapshot}})),
    getCursor: async name => (await load()).queryCursors[name] ?? null,
    setCursor: (name, ids) => persist(state => ({...state, queryCursors: {...state.queryCursors, [name]: ids}})),
    getBaseline: async name => (await load()).backlinkBaselines[name] ?? null,
    setBaseline: (name, ms) => persist(state => ({...state, backlinkBaselines: {...state.backlinkBaselines, [name]: ms}})),
    getLaunchTimes: async () => [...(await load()).launchTimes],
    setLaunchTimes: times => persist(state => ({...state, launchTimes: times})),
  }
}
