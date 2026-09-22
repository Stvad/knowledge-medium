// @vitest-environment node

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  workspaceBackfillsFacet,
  type BackfillCompletionClaim,
  type WorkspaceBackfill,
} from '@/data/facets'
import {ChangeScope} from '@/data/api'
import {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'

const WS = 'operator-sync-wait'
const OTHER_WS = 'operator-sync-wait-other'
const BACKFILL_ID = 'operator-sync-wait-v1'

let sharedDb: TestDb

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

/** This gate has the production contract: it reports settled synchronously
 *  when open, and retains callbacks while a download is in flight. */
const controllableGate = () => {
  let settled = true
  let waiters: Array<() => void> = []
  return {
    gate: (callback: () => void) => {
      if (settled) { callback(); return () => {} }
      waiters.push(callback)
      return () => { waiters = waiters.filter(waiter => waiter !== callback) }
    },
    close: () => { settled = false },
    open: () => {
      settled = true
      const pending = waiters
      waiters = []
      for (const callback of pending) callback()
    },
  }
}

const makeRepo = async (
  backfill: WorkspaceBackfill,
  events: string[],
  options: {
    backfillSyncGate?: (callback: () => void) => () => void
    backfillCompletionClaim?: BackfillCompletionClaim
  } = {},
): Promise<Repo> => {
  const {backfillCompletionClaim, ...repoOptions} = options
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'operator-sync-wait-user'},
    ...repoOptions,
    backfillCompletionClaim: backfillCompletionClaim ?? {
      tryClaim: async () => { events.push('tryClaim'); return 'minted' as const },
      markComplete: async () => { events.push('markComplete') },
      releaseClaim: async () => { events.push('releaseClaim') },
    },
  })
  repo.setActiveWorkspaceId(WS)
  repo.setRuntimeContributions(workspaceBackfillsFacet, 'operator-sync-wait-tests', [backfill])
  await repo.tx(async tx => {
    await tx.create({
      id: 'operator-sync-wait-seed', workspaceId: WS, parentId: null,
      orderKey: 'a0', content: 'seed',
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed test workspace'})
  return repo
}

const waitFor = async (predicate: () => void): Promise<void> => {
  await vi.waitFor(predicate, {interval: 10, timeout: 3_000})
}

const persistedBatchIds = async (): Promise<string[]> => (
  (await sharedDb.db.getAll<{id: string}>(
    "SELECT id FROM blocks WHERE id LIKE 'operator-sync-wait-batch-%' ORDER BY id",
  )).map(row => row.id)
)

describe('operator backfill transient sync waits', () => {
  it('resumes after a download gap between committed batches and writes each batch once', async () => {
    const events: string[] = []
    const batches: number[] = []
    const gate = controllableGate()
    const backfill: WorkspaceBackfill = {
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async ({tx}) => {
        for (let index = 0; index < 2; index++) {
          await tx(async t => {
            batches.push(index)
            await t.create({
              id: `operator-sync-wait-batch-${index}`, workspaceId: WS,
              parentId: null, orderKey: `b${index}`, content: `batch ${index}`,
            })
          }, {description: `batch ${index}`})
          if (index === 0) gate.close()
        }
      },
    }
    const repo = await makeRepo(backfill, events, {backfillSyncGate: gate.gate})
    const realWorkspaceViewGap = repo.workspaceViewGap.bind(repo)
    let sawDownloadGap = false
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async (...args) => {
      const gap = await realWorkspaceViewGap(...args)
      if (gap?.transient) sawDownloadGap = true
      return gap
    })

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(sawDownloadGap).toBe(true))
    await vi.advanceTimersByTimeAsync(300)
    expect(batches).toEqual([0])
    expect(events).not.toContain('markComplete')
    expect(events).not.toContain('releaseClaim')
    expect(await repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)).toMatchObject({
      outcome: 'already-running',
    })

    gate.open()
    await vi.advanceTimersByTimeAsync(100)
    expect(await running).toMatchObject({outcome: 'ran', undoHistoryCleared: true})
    expect(batches).toEqual([0, 1])
    expect(await persistedBatchIds()).toEqual([
      'operator-sync-wait-batch-0', 'operator-sync-wait-batch-1',
    ])
    expect(events.filter(event => event === 'markComplete')).toHaveLength(1)
  })

  it('waits at the final completion check while a transient gap remains', async () => {
    const events: string[] = []
    let passFinished = false
    let gapObserved = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async () => { passFinished = true },
    }, events)
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => {
      if (passFinished) {
        gapObserved = true
        return {reason: 'download is still running', transient: true}
      }
      return null
    })

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gapObserved).toBe(true))
    expect(events).not.toContain('markComplete')
    expect(events).not.toContain('releaseClaim')

    passFinished = false
    await vi.advanceTimersByTimeAsync(100)
    expect(await running).toMatchObject({outcome: 'ran'})
    expect(events.filter(event => event === 'markComplete')).toHaveLength(1)
  })

  it('waits before the inner claim when the outer claim creates the transient gap', async () => {
    const events: string[] = []
    let gap = false
    let gapObserved = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async () => { events.push('pass') },
    }, events, {backfillCompletionClaim: {
      tryClaim: async () => {
        events.push('tryClaim')
        if (events.filter(event => event === 'tryClaim').length === 1) gap = true
        return 'minted'
      },
      markComplete: async () => { events.push('markComplete') },
      releaseClaim: async () => { events.push('releaseClaim') },
    }})
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => {
      if (gap) {
        gapObserved = true
        return {reason: 'claim has not materialized yet', transient: true}
      }
      return null
    })

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gapObserved).toBe(true))
    expect(events).toEqual(['tryClaim'])

    gap = false
    await vi.advanceTimersByTimeAsync(100)
    expect(await running).toMatchObject({outcome: 'ran'})
    expect(events).toEqual(['tryClaim', 'tryClaim', 'pass', 'markComplete', 'releaseClaim'])
  })

  it('does not take the inner claim if write access is revoked while that claim waits', async () => {
    const events: string[] = []
    let gap = false
    let gapObserved = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async () => { events.push('pass') },
    }, events, {backfillCompletionClaim: {
      tryClaim: async () => {
        events.push('tryClaim')
        if (events.filter(event => event === 'tryClaim').length === 1) gap = true
        return 'minted'
      },
      markComplete: async () => { events.push('markComplete') },
      releaseClaim: async () => { events.push('releaseClaim') },
    }})
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => {
      if (gap) {
        gapObserved = true
        return {reason: 'outer claim has not materialized yet', transient: true}
      }
      return null
    })

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gapObserved).toBe(true))
    expect(events).toEqual(['tryClaim'])

    gap = false
    repo.setReadOnly(true)
    await vi.advanceTimersByTimeAsync(100)
    expect(await running).toMatchObject({outcome: 'deferred', retryable: false})
    expect(events).toEqual(['tryClaim', 'releaseClaim'])
  })

  it('returns a durable gap immediately after a batch without claiming completion', async () => {
    const events: string[] = []
    const batches: number[] = []
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async ({tx}) => {
        for (let index = 0; index < 2; index++) {
          await tx(async t => {
            batches.push(index)
            await t.create({
              id: `operator-sync-wait-batch-${index}`, workspaceId: WS,
              parentId: null, orderKey: `b${index}`, content: `batch ${index}`,
            })
          }, {description: `batch ${index}`})
        }
      },
    }, events)
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => batches.length === 0
      ? null
      : {reason: 'synced rows were never materialized', transient: false})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)

    expect(result).toMatchObject({outcome: 'deferred', retryable: false})
    expect(batches).toEqual([0])
    expect(events).toContain('releaseClaim')
    expect(events).not.toContain('markComplete')
    expect(warn.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('will retry when it clears'))).toBe(false)
    warn.mockRestore()
  })

  it('times out a persistent transient gap, releases the claim, and does not promise a retry', async () => {
    const events: string[] = []
    const batches: number[] = []
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async ({tx}) => {
        await tx(async t => {
          batches.push(0)
          await t.create({
            id: 'operator-sync-wait-batch-0', workspaceId: WS,
            parentId: null, orderKey: 'b0', content: 'batch 0',
          })
        }, {description: 'first batch'})
        await tx(async t => {
          batches.push(1)
          await t.create({
            id: 'operator-sync-wait-batch-1', workspaceId: WS,
            parentId: null, orderKey: 'b1', content: 'batch 1',
          })
        }, {description: 'second batch'})
      },
    }, events)
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => batches.length === 0
      ? null
      : {reason: 'download is still running', transient: true})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scheduled = vi.spyOn(repo, 'scheduleWorkspaceBackfills')

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(batches).toEqual([0]))
    await vi.advanceTimersByTimeAsync(30_000)
    const result = await running

    expect(result).toMatchObject({outcome: 'deferred', retryable: true})
    expect(result.reason).toContain('30 seconds')
    expect(batches).toEqual([0])
    expect(events).toContain('releaseClaim')
    expect(events).not.toContain('markComplete')
    expect(scheduled).not.toHaveBeenCalled()
    expect(warn.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('will retry when it clears'))).toBe(false)
    warn.mockRestore()
  })

  it.each([
    ['workspace switch', (repo: Repo) => repo.setActiveWorkspaceId(OTHER_WS)],
    ['workspace away and back', (repo: Repo) => {
      repo.setActiveWorkspaceId(OTHER_WS)
      repo.setActiveWorkspaceId(WS)
    }],
    ['write access revocation', (repo: Repo) => repo.setReadOnly(true)],
  ])('aborts promptly after %s while waiting and performs no more writes', async (_label, changeSession) => {
    const events: string[] = []
    const batches: number[] = []
    const gate = controllableGate()
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async ({tx}) => {
        for (let index = 0; index < 2; index++) {
          await tx(async t => {
            batches.push(index)
            await t.create({
              id: `operator-sync-wait-batch-${index}`, workspaceId: WS,
              parentId: null, orderKey: `b${index}`, content: `batch ${index}`,
            })
          }, {description: `batch ${index}`})
          if (index === 0) gate.close()
        }
      },
    }, events, {backfillSyncGate: gate.gate})
    const realWorkspaceViewGap = repo.workspaceViewGap.bind(repo)
    let sawGap = false
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async (...args) => {
      const gap = await realWorkspaceViewGap(...args)
      if (gap?.transient) sawGap = true
      return gap
    })

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(sawGap).toBe(true))
    changeSession(repo)
    await vi.advanceTimersByTimeAsync(100)

    const result = await running
    expect(result.outcome).toBe('deferred')
    expect(result.reason).toContain(_label === 'write access revocation'
      ? 'lost write access'
      : _label === 'workspace away and back' ? 're-opened' : 'no longer active')
    expect(batches).toEqual([0])
    expect(events).toContain('releaseClaim')
    expect(events).not.toContain('markComplete')
  })

  it('keeps the workspace-open path aborting promptly on a transient gap', async () => {
    const events: string[] = []
    const batches: number[] = []
    const gate = controllableGate()
    const repo = await makeRepo({
      id: 'workspace-open-sync-wait-v1',
      trigger: 'workspace-open',
      run: async ({tx}) => {
        for (let index = 0; index < 2; index++) {
          await tx(async t => {
            batches.push(index)
            await t.create({
              id: `operator-sync-wait-batch-${index}`, workspaceId: WS,
              parentId: null, orderKey: `b${index}`, content: `batch ${index}`,
            })
          }, {description: `batch ${index}`})
          if (index === 0) gate.close()
        }
      },
    }, events, {backfillSyncGate: gate.gate})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    repo.scheduleWorkspaceBackfills(WS)
    await vi.advanceTimersByTimeAsync(0)
    await waitFor(() => expect(warn.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('will retry when it clears'))).toBe(true))

    expect(batches).toEqual([0])
    expect(warn.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('30 seconds'))).toBe(false)
    warn.mockRestore()
  })

  it('still refuses a transient gap before taking the outer claim', async () => {
    const events: string[] = []
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async () => { events.push('pass') },
    }, events)
    vi.spyOn(repo, 'workspaceViewGap').mockResolvedValue({
      reason: 'download is still running', transient: true,
    })

    expect(await repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)).toMatchObject({
      outcome: 'deferred', retryable: true,
    })
    expect(events).toEqual([])
  })
})
