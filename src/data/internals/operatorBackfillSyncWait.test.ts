// @vitest-environment node

import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  workspaceBackfillsFacet,
  type BackfillCompletionClaim,
  type WorkspaceBackfill,
  type WorkspaceBackfillContext,
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
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

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
      stillOwned: async () => { events.push('stillOwned'); return true },
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

/** Under fake timers `vi.waitFor` also moves the clock one interval per check,
 *  so a poll the run arms while this waits still fires. */
const waitFor = async (predicate: () => void | Promise<void>): Promise<void> => {
  await vi.waitFor(predicate, {interval: 10, timeout: 3_000})
}

/** Settles a run whose sync wait polls on FAKE timers between REAL database
 *  reads, moving the clock `stepMs` per check until it does. One large
 *  `advanceTimersByTimeAsync` is wrong here: a read still in flight when it
 *  lands arms the next poll after it returns, on a clock nothing moves again. */
const settle = async <T>(running: Promise<T>, stepMs = 100): Promise<T> => {
  let settled = false
  void running.then(() => { settled = true }, () => { settled = true })
  await waitFor(async () => {
    if (!settled) await vi.advanceTimersByTimeAsync(stepMs)
    expect(settled, 'the run has not settled').toBe(true)
  })
  return running
}

/** A step that lets the slow poll reach the 5-minute deadline in a few checks. */
const DEADLINE_STEP_MS = 30_000

/** A transient gap on a LOCAL arm — rows downloaded but still staged — which an
 *  operator batch waits on, unlike a download still in flight. Real answers
 *  otherwise. */
const stageableGap = (repo: Repo, isStaged: () => boolean): {readonly seen: number} => {
  let seen = 0
  const realWorkspaceViewGap = repo.workspaceViewGap.bind(repo)
  vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async (...args) => {
    if (!isStaged()) return realWorkspaceViewGap(...args)
    seen += 1
    return {reason: 'downloaded rows are still staged', transient: true}
  })
  return {get seen() { return seen }}
}

const persistedBatchIds = async (): Promise<string[]> => (
  (await sharedDb.db.getAll<{id: string}>(
    "SELECT id FROM blocks WHERE id LIKE 'operator-sync-wait-batch-%' ORDER BY id",
  )).map(row => row.id)
)

const twoBatchWriter = (
  batches: number[],
  afterBatch?: (index: number, ctx: WorkspaceBackfillContext) => void,
): WorkspaceBackfill['run'] => async ctx => {
  for (let index = 0; index < 2; index++) {
    await ctx.tx(async tx => {
      batches.push(index)
      await tx.create({
        id: `operator-sync-wait-batch-${index}`, workspaceId: WS,
        parentId: null, orderKey: `b${index}`, content: `batch ${index}`,
      })
    }, {description: `batch ${index}`})
    afterBatch?.(index, ctx)
  }
}

describe('operator backfill transient sync waits', () => {
  it('resumes after a staged-rows gap between committed batches and writes each batch once', async () => {
    const events: string[] = []
    const batches: number[] = []
    const observedWaitCounts: number[] = []
    let staged = false
    const backfill: WorkspaceBackfill = {
      id: BACKFILL_ID,
      trigger: 'operator',
      run: twoBatchWriter(batches, (index, ctx) => {
        observedWaitCounts.push(ctx.syncWaitCount)
        if (index === 0) staged = true
      }),
    }
    const repo = await makeRepo(backfill, events)
    const gap = stageableGap(repo, () => staged)

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    // Seen again by a poll: the wait is under way, not merely begun.
    await waitFor(() => expect(gap.seen).toBeGreaterThanOrEqual(2))
    expect(batches).toEqual([0])
    expect(events).not.toContain('markComplete')
    expect(events).not.toContain('releaseClaim')
    expect(await repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)).toMatchObject({
      outcome: 'already-running',
    })

    staged = false
    expect(await settle(running)).toMatchObject({outcome: 'ran', undoHistoryCleared: true})
    expect(batches).toEqual([0, 1])
    expect(observedWaitCounts).toEqual([0, 1])
    expect(await persistedBatchIds()).toEqual([
      'operator-sync-wait-batch-0', 'operator-sync-wait-batch-1',
    ])
    expect(events.filter(event => event === 'markComplete')).toHaveLength(1)
  })

  it('does not wait at the final completion check after the scan has finished', async () => {
    const events: string[] = []
    let passFinished = false
    let gapObserved = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async () => { passFinished = true },
    }, events)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => {
      if (passFinished) {
        gapObserved = true
        return {reason: 'download is still running', transient: true}
      }
      return null
    })

    // Stepped past the deadline, so a regression that waited here would end in
    // "made no progress" rather than hang.
    const result = await settle(repo.runWorkspaceBackfillNow(WS, BACKFILL_ID), DEADLINE_STEP_MS)

    expect(gapObserved).toBe(true)
    expect(result).toMatchObject({outcome: 'deferred', retryable: true})
    expect(result.reason).toContain('download is still running')
    expect(result.reason).not.toContain('made no progress')
    expect(events).not.toContain('markComplete')
    expect(events).toContain('releaseClaim')
    expect(warn.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('will retry when it clears'))).toBe(false)
    warn.mockRestore()
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
      stillOwned: async () => { events.push('stillOwned'); return true },
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
    expect(await settle(running)).toMatchObject({outcome: 'ran'})
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
      stillOwned: async () => { events.push('stillOwned'); return true },
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
    expect(await settle(running)).toMatchObject({outcome: 'deferred', retryable: false})
    expect(events).toEqual(['tryClaim', 'releaseClaim'])
  })

  it('rechecks the inner claim after a wait and stops if a peer took it', async () => {
    const events: string[] = []
    const batches: number[] = []
    let staged = false
    let waitWasCleared = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: twoBatchWriter(batches, index => {
        if (index === 0) staged = true
      }),
    }, events, {backfillCompletionClaim: {
      tryClaim: async () => {
        events.push('tryClaim')
        return 'minted'
      },
      stillOwned: async () => {
        events.push('stillOwned')
        return !waitWasCleared
      },
      markComplete: async () => { events.push('markComplete') },
      releaseClaim: async () => { events.push('releaseClaim') },
    }})
    const gap = stageableGap(repo, () => staged)

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gap.seen).toBeGreaterThan(0))
    expect(batches).toEqual([0])

    waitWasCleared = true
    staged = false
    const result = await settle(running)
    expect(result.outcome).toBe('deferred')
    expect(result.reason).toContain('claim is no longer held')
    expect(batches).toEqual([0])
    expect(events.filter(event => event === 'tryClaim')).toHaveLength(2)
    expect(events.filter(event => event === 'stillOwned')).toHaveLength(2)
    expect(events).not.toContain('markComplete')
  })

  it('checks ownership inside the next transaction after a peer takes the claim at lock entry', async () => {
    const events: string[] = []
    const batches: number[] = []
    let staged = false
    let claimWasReplaced = false
    let insideRepoTransaction = false
    const checked: Array<{insideTransaction: boolean; receivedTransaction: boolean; owned: boolean}> = []
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: twoBatchWriter(batches, index => {
        if (index === 0) staged = true
      }),
    }, events, {backfillCompletionClaim: {
      tryClaim: async () => { events.push('tryClaim'); return 'minted' },
      stillOwned: async (...args: Parameters<BackfillCompletionClaim['stillOwned']>) => {
        const receivedTransaction = typeof args[0] === 'object' && args[0] !== null
        const owned = !claimWasReplaced
        checked.push({insideTransaction: insideRepoTransaction, receivedTransaction, owned})
        return owned
      },
      markComplete: async () => { events.push('markComplete') },
      releaseClaim: async () => { events.push('releaseClaim') },
    }})
    const originalTx = repo.tx.bind(repo)
    let txCount = 0
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, options) => {
      const thisTx = ++txCount
      return originalTx(async tx => {
        insideRepoTransaction = true
        // Simulate a peer replacement becoming visible at lock acquisition,
        // after any checks performed before entering this transaction.
        if (thisTx === 2) claimWasReplaced = true
        try {
          return await fn(tx)
        } finally {
          insideRepoTransaction = false
        }
      }, options)
    })
    const gap = stageableGap(repo, () => staged)

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gap.seen).toBeGreaterThan(0))
    expect(batches).toEqual([0])
    staged = false

    const result = await settle(running)
    expect(result).toMatchObject({outcome: 'deferred', retryable: false})
    expect(result.reason).toContain('claim is no longer held')
    expect(batches).toEqual([0])
    expect(checked).toHaveLength(2)
    expect(checked.every(check => check.insideTransaction && check.receivedTransaction)).toBe(true)
    expect(checked.map(check => check.owned)).toEqual([true, false])
    expect(events).not.toContain('markComplete')
  })

  it('checks claim ownership at every batch even when sync stays settled', async () => {
    const events: string[] = []
    const batches: number[] = []
    const claimChecks: boolean[] = []
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: twoBatchWriter(batches),
    }, events, {backfillCompletionClaim: {
      tryClaim: async () => { events.push('tryClaim'); return 'minted' },
      stillOwned: async () => {
        const owned = claimChecks.length === 0
        claimChecks.push(owned)
        return owned
      },
      markComplete: async () => { events.push('markComplete') },
      releaseClaim: async () => { events.push('releaseClaim') },
    }})
    const gaps: Array<unknown> = []
    const realWorkspaceViewGap = repo.workspaceViewGap.bind(repo)
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async (...args) => {
      const gap = await realWorkspaceViewGap(...args)
      gaps.push(gap)
      return gap
    })

    const result = await repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)

    expect(result).toMatchObject({outcome: 'deferred', retryable: false})
    expect(result.reason).toContain('claim is no longer held')
    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.every(gap => gap === null)).toBe(true)
    expect(claimChecks).toEqual([true, false])
    expect(batches).toEqual([0])
    expect(events).not.toContain('markComplete')
  })

  it('refreshes the schema resolver before the next batch after a wait', async () => {
    const events: string[] = []
    let staged = false
    const oldSchema = {version: 'before-sync'}
    const newSchema = {version: 'after-sync'}
    let viewIsCurrent = false
    const seen: unknown[] = []
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async ctx => {
        for (let index = 0; index < 2; index++) {
          await ctx.tx(async t => {
            if (index === 0) {
              await t.create({
                id: 'operator-sync-wait-batch-0', workspaceId: WS,
                parentId: null, orderKey: 'b0', content: 'batch 0',
              })
            } else {
              seen.push(ctx.resolveNameSchema('sample-name'))
            }
          }, {description: `batch ${index}`})
          if (index === 0) staged = true
        }
      },
    }, events)
    const makeResolver = (schema: object): ReturnType<Repo['propertySchemaResolverFor']> => ({
      resolve: () => ({status: 'resolved', schema}),
    } as unknown as ReturnType<Repo['propertySchemaResolverFor']>)
    vi.spyOn(repo, 'propertySchemaResolverFor').mockImplementation(() =>
      makeResolver(viewIsCurrent ? newSchema : oldSchema))
    const originalTx = repo.tx.bind(repo)
    let txCount = 0
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, options) => {
      const thisTx = ++txCount
      return originalTx(async tx => {
        if (thisTx === 2) viewIsCurrent = true
        return fn(tx)
      }, options)
    })
    const gap = stageableGap(repo, () => staged)

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gap.seen).toBeGreaterThan(0))
    staged = false

    expect(await settle(running)).toMatchObject({outcome: 'ran'})
    expect(seen).toEqual([newSchema])
  })

  it('returns a durable gap immediately after a batch without claiming completion', async () => {
    const events: string[] = []
    const batches: number[] = []
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: twoBatchWriter(batches),
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
      run: twoBatchWriter(batches),
    }, events)
    let gapObserved = false
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => {
      if (batches.length === 0) return null
      gapObserved = true
      return {reason: 'download is still running', transient: true}
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scheduled = vi.spyOn(repo, 'scheduleWorkspaceBackfills')

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gapObserved).toBe(true))
    const result = await settle(running, DEADLINE_STEP_MS)

    expect(result).toMatchObject({outcome: 'deferred', retryable: true})
    expect(result.reason).toContain('5 minutes')
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
    let staged = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: twoBatchWriter(batches, index => {
        if (index === 0) staged = true
      }),
    }, events)
    const gap = stageableGap(repo, () => staged)

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    await waitFor(() => expect(gap.seen).toBeGreaterThan(0))
    changeSession(repo)

    const result = await settle(running)
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
      run: twoBatchWriter(batches, index => {
        if (index === 0) gate.close()
      }),
    }, events, {backfillSyncGate: gate.gate})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    repo.scheduleWorkspaceBackfills(WS)
    await vi.advanceTimersByTimeAsync(0)
    await waitFor(() => expect(warn.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('will retry when it clears'))).toBe(true))

    expect(batches).toEqual([0])
    expect(warn.mock.calls.some(([message]) =>
      typeof message === 'string' && message.includes('made no progress'))).toBe(false)
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

  it('does not hold an operator batch for a download in flight', async () => {
    const events: string[] = []
    const batches: number[] = []
    const observedWaitCounts: number[] = []
    const gate = controllableGate()
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: twoBatchWriter(batches, (index, ctx) => {
        observedWaitCounts.push(ctx.syncWaitCount)
        if (index === 0) gate.close()
      }),
    }, events, {backfillSyncGate: gate.gate})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A batch that waited on the closed gate would poll until this budget ran
    // out; one that does not wait settles with both batches written.
    const result = await settle(repo.runWorkspaceBackfillNow(WS, BACKFILL_ID))
    // Read once the run is over: rows and wait counts land as each batch
    // COMMITS, which lags the batch body `batches` records.
    expect(batches).toEqual([0, 1])
    expect(await persistedBatchIds()).toEqual([
      'operator-sync-wait-batch-0', 'operator-sync-wait-batch-1',
    ])
    // Not waited on, but counted: the sweep it spans cannot prove convergence.
    expect(observedWaitCounts).toEqual([0, 1])
    // The check after the scan still asks every arm, so the run does not
    // record completion over a download it never waited out.
    expect(result).toMatchObject({outcome: 'deferred', retryable: true})
    expect(result.reason).toContain('not caught up with the server')
    expect(events).not.toContain('markComplete')
    warn.mockRestore()
  })

  it('waits out a download in flight when the pass asks to catch up', async () => {
    const events: string[] = []
    const batches: number[] = []
    let downloading = false
    let caughtUp = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async ctx => {
        await twoBatchWriter(batches)(ctx)
        downloading = true
        await ctx.awaitCaughtUp()
        caughtUp = true
      },
    }, events)
    // A download in flight is the device-wide arm, which only a full ask sees.
    const askedArms: string[] = []
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async (_ws, _reads, arms = 'all') => {
      if (downloading) askedArms.push(arms)
      return downloading && arms === 'all'
        ? {reason: 'download is still running', transient: true}
        : null
    })

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    // Asked again by a poll: the wait is under way, not merely begun.
    await waitFor(() => expect(askedArms.length).toBeGreaterThanOrEqual(2))
    expect(caughtUp).toBe(false)
    expect(askedArms.every(arms => arms === 'all')).toBe(true)

    downloading = false
    expect(await settle(running)).toMatchObject({outcome: 'ran'})
    expect(caughtUp).toBe(true)
    expect(batches).toEqual([0, 1])
    expect(events.filter(event => event === 'markComplete')).toHaveLength(1)
  })

  it('renews the wait while this device uploads, and times out once its queue stalls', async () => {
    const events: string[] = []
    let downloading = false
    const repo = await makeRepo({
      id: BACKFILL_ID,
      trigger: 'operator',
      run: async ctx => {
        downloading = true
        await ctx.awaitCaughtUp()
      },
    }, events)
    vi.spyOn(repo, 'workspaceViewGap').mockImplementation(async () => downloading
      ? {reason: 'download is still running', transient: true}
      : null)
    // The upload queue's head, scripted: it is this device's own progress, and
    // the real read is exercised by the plain timeout test above.
    let uploadQueueHead: number | null = 1
    let stagedQueueHead: number | null = null
    let headReads = 0
    // On the database itself: `repo.db` is a timing proxy that calls through
    // to it, so an original taken from the proxy would call this spy again.
    const realGet = sharedDb.db.get.bind(sharedDb.db)
    vi.spyOn(sharedDb.db, 'get').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (!sql.includes('FROM ps_crud')) return realGet(sql, params)
      headReads += 1
      return {upload: uploadQueueHead, staged: stagedQueueHead}
    })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const running = repo.runWorkspaceBackfillNow(WS, BACKFILL_ID)
    let settled = false
    void running.then(() => { settled = true })
    // The windows below count from when the wait begins, which follows the
    // claim's real reads, so the clock moves only once the heads are read.
    await waitFor(() => expect(headReads).toBeGreaterThan(0))
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    // An upload completes inside the first window, so the deadline renews.
    uploadQueueHead = 2
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    // The queue empties and its echoes stage: the drain is progress too.
    uploadQueueHead = null
    stagedQueueHead = 7
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    stagedQueueHead = 8
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(settled).toBe(false)

    // Nothing moves for a whole window: that is a stall.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const result = await running
    expect(result).toMatchObject({outcome: 'deferred', retryable: true})
    expect(result.reason).toContain('made no progress for 5 minutes')
    expect(events).not.toContain('markComplete')
    warn.mockRestore()
    info.mockRestore()
  })
})
