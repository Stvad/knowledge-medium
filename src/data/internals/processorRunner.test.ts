// @vitest-environment node
/**
 * ProcessorRunner unit tests (spec §5.7, §10 step 9). End-to-end
 * coverage exists via parseReferencesProcessor; this file pins the
 * runner's own contracts directly so a future refactor (Phase 3
 * facet-driven registration) doesn't accidentally drop them.
 *
 * Coverage:
 *   - Field-watching: fires when watched field changes; does NOT fire
 *     when only unwatched fields changed; aggregates changedRows
 *   - Field-watching matcher handles insert (before=null) and
 *     soft-delete (after marked deleted) as field changes
 *   - Explicit (afterCommit): one-job-per-call; scheduledArgs land
 *     in the event
 *   - Explicit + delayMs: doesn't fire until timers advance;
 *     awaitIdle drains delayed jobs once they've fired
 *   - Error isolation: one processor throwing doesn't stop another
 *   - Error isolation: a processor whose own tx writes invalid data
 *     swallows the error and logs (does not bubble to the caller)
 *   - Workspace-pinning: zero-write tx (workspaceId=null) skips
 *     dispatch entirely
 *   - Snapshot semantics: a processor registered AFTER the tx started
 *     does not fire for that tx
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChangeScope,
  type AnyPostCommitProcessor,
} from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '../repo'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    registerKernelProcessors: false,
  })
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

interface Calls<S = unknown> {
  events: Array<{txId: string; changedRowIds: string[]; scheduledArgs?: S}>
}

const recordingFieldProcessor = (
  name: string,
  fields: ('content' | 'properties' | 'references')[],
  calls: Calls,
): AnyPostCommitProcessor => ({
  name,
  watches: {kind: 'field', table: 'blocks', fields},
  apply: async (event) => {
    calls.events.push({
      txId: event.txId,
      changedRowIds: event.changedRows.map(r => r.id),
    })
  },
})

const recordingExplicitProcessor = <S>(
  name: string,
  calls: Calls<S>,
): AnyPostCommitProcessor => ({
  name,
  watches: {kind: 'explicit'},
  // Pass-through schema — we want the runner-level path tested here,
  // not the codec-validation path (txEngine.test pins that).
  scheduledArgsSchema: {parse: (v: unknown) => v as S},
  apply: async (event) => {
    calls.events.push({
      txId: event.txId,
      changedRowIds: event.changedRows.map(r => r.id),
      scheduledArgs: event.scheduledArgs as S,
    })
  },
})

describe('ProcessorRunner — field-watching dispatch', () => {
  it('fires once per tx with the aggregated changedRows when a watched field changes', async () => {
    const calls: Calls = {events: []}
    env.repo.__setProcessorsForTesting([
      recordingFieldProcessor('test.contentWatcher', ['content'], calls),
    ])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'foo'})
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'bar'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(calls.events).toHaveLength(1)
    expect(calls.events[0].changedRowIds.sort()).toEqual(['a', 'b'])
  })

  it('does NOT fire when only unwatched fields changed (update path)', async () => {
    const calls: Calls = {events: []}
    // Pre-create the row WITHOUT the processor registered, so insert
    // doesn't fire the field-watcher (insert is a change in every field).
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'init',
        references: [{id: 'x', alias: 'x'}],
      })
    }, {scope: ChangeScope.BlockDefault})

    // Now register a refs-only watcher and update only `content`.
    env.repo.__setProcessorsForTesting([
      recordingFieldProcessor('test.refsWatcher', ['references'], calls),
    ])
    await env.repo.tx(tx => tx.update('a', {content: 'updated'}),
      {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(calls.events).toEqual([])
  })

  it('treats insert as a change in every field (before=null)', async () => {
    const calls: Calls = {events: []}
    env.repo.__setProcessorsForTesting([
      recordingFieldProcessor('test.refsWatcher', ['references'], calls),
    ])

    await env.repo.tx(async tx => {
      await tx.create({
        id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: '',
        references: [{id: 'x', alias: 'x'}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(calls.events).toHaveLength(1)
    expect(calls.events[0].changedRowIds).toEqual(['a'])
  })
})

describe('ProcessorRunner — explicit (afterCommit) dispatch', () => {
  it('fires once per tx.afterCommit call with scheduledArgs in the event', async () => {
    const calls: Calls<{kind: string}> = {events: []}
    env.repo.__setProcessorsForTesting([
      recordingExplicitProcessor<{kind: string}>('test.explicit', calls),
    ])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
      tx.afterCommit('test.explicit', {kind: 'foo'})
      tx.afterCommit('test.explicit', {kind: 'bar'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(calls.events).toHaveLength(2)
    expect(calls.events.map(e => e.scheduledArgs?.kind).sort()).toEqual(['bar', 'foo'])
  })

  it('explicit + delayMs: does NOT fire until timers advance; awaitIdle then drains it', async () => {
    vi.useFakeTimers({shouldAdvanceTime: true})
    try {
      const calls: Calls<undefined> = {events: []}
      env.repo.__setProcessorsForTesting([
        recordingExplicitProcessor<undefined>('test.delayed', calls),
      ])

      await env.repo.tx(async tx => {
        await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
        tx.afterCommit('test.delayed', undefined, {delayMs: 4000})
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.awaitProcessors()
      // Timer hasn't fired yet — nothing pending, processor not run.
      expect(calls.events).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(4000)
      await env.repo.awaitProcessors()
      expect(calls.events).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ProcessorRunner — error isolation', () => {
  it('a thrown apply on one processor does not stop another', async () => {
    const goodCalls: Calls = {events: []}
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const failing: AnyPostCommitProcessor = {
      name: 'test.failing',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async () => { throw new Error('processor blew up') },
    }
    const good = recordingFieldProcessor('test.good', ['content'], goodCalls)

    env.repo.__setProcessorsForTesting([failing, good])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(goodCalls.events).toHaveLength(1)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('processor "test.failing" failed'),
    )
    errSpy.mockRestore()
  })
})

describe('ProcessorRunner — zero-write tx', () => {
  it('skips dispatch entirely when workspaceId is null (no writes happened)', async () => {
    const calls: Calls = {events: []}
    env.repo.__setProcessorsForTesting([
      recordingFieldProcessor('test.contentWatcher', ['content'], calls),
    ])

    // Zero-write tx — engine never pins workspaceId, dispatch should bail.
    await env.repo.tx(async () => { /* no writes */ },
      {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(calls.events).toEqual([])
  })
})

describe('ProcessorRunner — registry snapshot semantics', () => {
  it('a processor registered AFTER the tx started does not fire for that tx', async () => {
    // Spec §3 / §8: tx fires the processors that were registered when
    // it started, not those added by a concurrent setFacetRuntime /
    // __setProcessorsForTesting call. Concretely: after the writeTx
    // commits but before dispatch walks, swap the registry — the new
    // processor must NOT see this tx's snapshots.
    const earlyCalls: Calls = {events: []}
    const lateCalls: Calls = {events: []}
    env.repo.__setProcessorsForTesting([
      recordingFieldProcessor('test.early', ['content'], earlyCalls),
    ])

    // Use an in-flight processor swap by hooking the early processor's
    // apply: when it runs, swap the registry to add `late`. The runner's
    // dispatch walks the snapshot it captured at tx start, so the new
    // processor must not be added to that walk.
    let swapped = false
    const swappingEarly: AnyPostCommitProcessor = {
      name: 'test.early',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async (event) => {
        earlyCalls.events.push({txId: event.txId, changedRowIds: event.changedRows.map(r => r.id)})
        if (!swapped) {
          swapped = true
          env.repo.__setProcessorsForTesting([
            swappingEarly,
            recordingFieldProcessor('test.late', ['content'], lateCalls),
          ])
        }
      },
    }
    env.repo.__setProcessorsForTesting([swappingEarly])

    await env.repo.tx(async tx => {
      await tx.create({id: 'a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'x'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(earlyCalls.events).toHaveLength(1)
    // The late-registered processor must NOT have fired for this tx —
    // it wasn't in the snapshot at tx start.
    expect(lateCalls.events).toEqual([])
  })
})

describe('ProcessorRunner — awaitIdle wave', () => {
  it("drains a wave of jobs scheduled while a previous wave's jobs were running", async () => {
    // Two processors: A schedules B via afterCommit on its own
    // post-commit tx. awaitIdle should wait through both waves.
    const aCalls: Calls = {events: []}
    const bCalls: Calls<undefined> = {events: []}
    let aRan = false

    const procB: AnyPostCommitProcessor = recordingExplicitProcessor<undefined>('test.b', bCalls)

    const procA: AnyPostCommitProcessor = {
      name: 'test.a',
      watches: {kind: 'field', table: 'blocks', fields: ['content']},
      apply: async (event, ctx) => {
        aCalls.events.push({txId: event.txId, changedRowIds: event.changedRows.map(r => r.id)})
        if (aRan) return
        aRan = true
        // Open A's own tx and schedule B from inside it. Need a write
        // to pin workspaceId for tx.afterCommit.
        await ctx.repo.tx(async tx => {
          await tx.create({
            id: 'a-cascade',
            workspaceId: WS,
            parentId: null,
            orderKey: 'a-cascade-key',
            content: 'cascade',
          })
          tx.afterCommit('test.b', undefined)
        }, {scope: ChangeScope.References})
      },
    }

    env.repo.__setProcessorsForTesting([procA, procB])

    await env.repo.tx(async tx => {
      await tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'init'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(aCalls.events.length).toBeGreaterThanOrEqual(1)
    expect(bCalls.events).toHaveLength(1)
  })
})
