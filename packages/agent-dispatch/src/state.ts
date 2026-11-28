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
import { isErrnoException } from '@knowledge-medium/agent-cli/config'

// Snapshots preserve prompt columns when a claim or the run's edits remove
// the row from its SQL result. The block owns status and attempt count.
const rowTaskState = z.object({
  baselineIds: z.array(z.string()),
  baselineMs: z.number(),
  pending: z.array(z.looseObject({id: z.string().min(1)})),
})
export type RowTaskState = z.infer<typeof rowTaskState>

const stateSchema = z.strictObject({
  rowTasks: z.record(z.string(), rowTaskState).default({}),
  queryCursors: z.record(z.string(), z.array(z.string())).default({}),
  launchTimes: z.array(z.number()).default([]),
  backlinkBaselines: z.record(z.string(), z.number()).default({}),
})
type StateData = z.infer<typeof stateSchema>

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

export const createStateStore = (filePath: string): StateStore => {
  let cache: StateData | null = null

  const load = async (): Promise<StateData> => {
    if (cache) return cache
    const contents = await fs.readFile(filePath, 'utf8').catch(error => {
      if (isErrnoException(error) && error.code === 'ENOENT') return '{}'
      throw error
    })
    try {
      cache = stateSchema.parse(JSON.parse(contents))
    } catch (error) {
      throw new Error(`state file at ${filePath} contains invalid state. See the README for recovery.`, {cause: error})
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
      // Rename the complete snapshot atomically so a crash cannot truncate the previous state.
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
