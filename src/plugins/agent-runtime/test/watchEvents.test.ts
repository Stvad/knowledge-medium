import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatchEventsRegistry, type WatchEventsRegistry } from '../watchEvents.ts'
import type { PowerSyncDb } from '@/data/internals/commitPipeline'
import type { WatchEventsWatcher } from '@knowledge-medium/agent-cli/protocol'

/** Fake PowerSyncDb: controllable rows + manual change firing. The
 *  facility only touches getAll/onChange. */
const createFakeDb = () => {
  let rows: unknown[] = []
  const subscriptions: Array<{onChange: () => void, tables: string[], disposed: boolean}> = []
  const db = {
    getAll: vi.fn(async () => rows),
    onChange: (handler: {onChange: () => void}, options?: {tables?: readonly string[]}) => {
      const entry = {onChange: handler.onChange, tables: [...(options?.tables ?? [])], disposed: false}
      subscriptions.push(entry)
      return () => { entry.disposed = true }
    },
  } as unknown as PowerSyncDb
  return {
    db,
    subscriptions,
    setRows: (next: unknown[]) => { rows = next },
    fireChange: (table = 'blocks') => {
      for (const entry of subscriptions) {
        if (!entry.disposed && entry.tables.includes(table)) entry.onChange()
      }
    },
  }
}

const sqlWatcher = (overrides: Partial<Extract<WatchEventsWatcher, {kind: 'sql'}>> = {}): WatchEventsWatcher => ({
  kind: 'sql',
  name: 'inbox',
  sql: 'SELECT id FROM blocks WHERE deleted = 0',
  settleMs: 1_000,
  ...overrides,
})

let fake: ReturnType<typeof createFakeDb>
let registry: WatchEventsRegistry
let emitted: Array<Record<string, unknown>>

beforeEach(() => {
  vi.useFakeTimers()
  fake = createFakeDb()
  registry = createWatchEventsRegistry()
  emitted = []
  registry.setTransport(async event => { emitted.push(event) })
})

afterEach(() => {
  registry.disposeAll()
  vi.useRealTimers()
})

/** Fire a change and let the (async) recompute run. */
const change = async (rows: unknown[], table = 'blocks') => {
  fake.setRows(rows)
  fake.fireChange(table)
  await vi.advanceTimersByTimeAsync(0)
}

describe('watch-events registry', () => {
  it('baselines without emitting, then emits once the result set settles on a new value', async () => {
    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})

    // The pre-existing result set never fires.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(emitted).toEqual([])

    await change([{id: 'a'}, {id: 'b'}])
    // Not yet settled.
    await vi.advanceTimersByTimeAsync(999)
    expect(emitted).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(emitted).toEqual([{type: 'watcher-settled', consumer: 'daemon', watcher: 'inbox'}])
  })

  it('does not emit when a change signal re-resolves to the same result set', async () => {
    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})

    await change([{id: 'a'}]) // unrelated table churn, same rows
    await vi.advanceTimersByTimeAsync(5_000)
    expect(emitted).toEqual([])

    // Fence: a REAL change still fires, proving the watcher stayed live.
    await change([{id: 'a'}, {id: 'b'}])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(emitted).toHaveLength(1)
  })

  it('restarts the settle window on every further change (quiet-period semantics)', async () => {
    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})

    await change([{id: 'a'}, {id: 'b'}])
    await vi.advanceTimersByTimeAsync(900)
    await change([{id: 'a'}, {id: 'b'}, {id: 'c'}]) // keeps "typing"
    await vi.advanceTimersByTimeAsync(900)
    expect(emitted).toEqual([]) // 1.8s elapsed, but never 1s of quiet
    await vi.advanceTimersByTimeAsync(100)
    expect(emitted).toHaveLength(1)
  })

  it('re-registering an identical spec keeps state and refreshes the TTL (unchanged: true)', async () => {
    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})

    // A pending settle window survives the refresh.
    await change([{id: 'a'}, {id: 'b'}])
    const refreshed = await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})
    expect(refreshed.unchanged).toBe(true)
    expect(fake.subscriptions.filter(entry => !entry.disposed)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(emitted).toHaveLength(1)
  })

  it('a changed spec replaces the registration and re-baselines', async () => {
    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})
    fake.setRows([{id: 'a'}, {id: 'b'}])
    const replaced = await registry.register(fake.db, {
      consumer: 'daemon',
      watchers: [sqlWatcher({settleMs: 2_000})],
    })
    expect(replaced.unchanged).toBe(false)
    expect(fake.subscriptions[0]!.disposed).toBe(true)

    // The rows present at re-registration are the new baseline: no emit.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(emitted).toEqual([])
  })

  it('an empty watcher list unregisters the consumer', async () => {
    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})
    await registry.register(fake.db, {consumer: 'daemon', watchers: []})
    expect(fake.subscriptions[0]!.disposed).toBe(true)

    await change([{id: 'a'}, {id: 'b'}])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(emitted).toEqual([])
  })

  it('backlinks watchers use the canned reference query and its tables', async () => {
    fake.setRows([])
    await registry.register(fake.db, {
      consumer: 'daemon',
      watchers: [{kind: 'backlinks', name: 'claude-mentions', targetId: 'page-1', settleMs: 1_000}],
    })

    const getAll = fake.db.getAll as ReturnType<typeof vi.fn>
    const [sql, params] = getAll.mock.calls[0]!
    expect(sql).toContain('block_references')
    expect(params).toEqual(['page-1'])
    expect(fake.subscriptions[0]!.tables.sort()).toEqual(['block_references', 'blocks'])

    // Reference-table-only changes reach it too.
    await change([{id: 'src-1', edited_at: 5}], 'block_references')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(emitted).toEqual([{type: 'watcher-settled', consumer: 'daemon', watcher: 'claude-mentions'}])
  })

  it('expires a registration whose TTL lapsed without a refresh', async () => {
    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()], ttlMs: 60_000})

    await vi.advanceTimersByTimeAsync(61_000)
    await change([{id: 'a'}, {id: 'b'}])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(emitted).toEqual([])
    expect(fake.subscriptions[0]!.disposed).toBe(true)
  })

  it('a failing transport is logged and does not break later emits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    registry.setTransport(async event => {
      calls += 1
      if (calls === 1) throw new Error('bridge hiccup')
      emitted.push(event)
    })

    fake.setRows([{id: 'a'}])
    await registry.register(fake.db, {consumer: 'daemon', watchers: [sqlWatcher()]})

    await change([{id: 'a'}, {id: 'b'}])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(warn).toHaveBeenCalled()

    await change([{id: 'a'}, {id: 'b'}, {id: 'c'}])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(emitted).toHaveLength(1)
  })

  it('a failing baseline query rejects the registration and leaves nothing armed', async () => {
    const failing = createFakeDb()
    ;(failing.db.getAll as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no such table'))
    await expect(
      registry.register(failing.db, {consumer: 'daemon', watchers: [sqlWatcher()]}),
    ).rejects.toThrow('no such table')
    expect(failing.subscriptions).toHaveLength(0)
  })
})
