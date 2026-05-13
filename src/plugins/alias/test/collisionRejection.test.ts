// @vitest-environment node
/**
 * Alias collision rejection — exercises the same-tx alias.sync
 * processor's collision-detection path. When a block tries to claim
 * an alias already held by a different live block, the processor
 * throws `ProcessorRejection`. SQLite rolls back the whole user tx
 * atomically: no rows commit, no undo entry, no stuck state.
 *
 * Covers:
 *   - A1-style collision (content edit adds new alias claim)
 *   - AR1-style collision (user writes aliases directly)
 *   - Direct-claim collision (user adds an alias via setProperty
 *     without changing content — same-tx detects regardless of
 *     which side the user touched)
 *   - Self-reclaim is not a collision (block re-asserts its own
 *     existing alias)
 *   - User-error listener fires with the rejection so the toast
 *     layer can surface it
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, ProcessorRejection } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/internals/coreProperties'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { referencesDataExtension } from '@/plugins/references/dataExtension.ts'
import { computeAliasSeatId } from '@/data/targets'
import { aliasDataExtension } from '../dataExtension.ts'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
  read(id: string): Promise<{id: string; content: string; deleted: 0 | 1; properties_json: string} | null>
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
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
    aliasDataExtension,
  ]))
  return {
    h,
    repo,
    read: async id => h.db.getOptional(
      `SELECT id, content, deleted, properties_json FROM blocks WHERE id = ?`,
      [id],
    ),
  }
}

let env: Harness
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({shouldAdvanceTime: true})
})
afterEach(async () => {
  vi.useRealTimers()
  await env.h.cleanup()
})

const readAliases = async (id: string): Promise<string[]> => {
  const row = await env.read(id)
  if (row === null) return []
  return (JSON.parse(row.properties_json).alias ?? []) as string[]
}

const flush = async () => {
  await vi.advanceTimersByTimeAsync(1)
  await env.repo.awaitProcessors()
}

/** Create a block claiming `alias` at slot 0 (the canonical seat).
 *  Uses computeAliasSeatId so the row IS the canonical claimant; the
 *  collision check probes through the same seat space. */
const seatAt = async (alias: string, content: string): Promise<string> => {
  const id = computeAliasSeatId(alias, WS, 0)
  await env.repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a0', content})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
  await flush()
  return id
}

describe('alias.collision — A1-style (content edit adds new claim)', () => {
  it('rejects when another live block already claims the alias', async () => {
    await seatAt('Existing', 'Existing')

    // Second block, no aliases yet; user retypes its content to the
    // taken name, expecting alias sync to add `Existing` to its alias
    // list. Sync detects the collision and throws.
    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'mine'})
      await tx.setProperty('b', aliasesProp, ['mine'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      await env.repo.mutate.setContent({id: 'b', content: 'Existing'})
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')
    expect((caught as ProcessorRejection).meta?.alias).toBe('Existing')

    // Block b is unchanged — content stayed "mine", aliases stayed ["mine"].
    expect((await env.read('b'))!.content).toBe('mine')
    expect(await readAliases('b')).toEqual(['mine'])
  })
})

describe('alias.collision — AR1-style (alias swap to a taken name)', () => {
  it('rejects when user renames their alias to one held by another block', async () => {
    await seatAt('Foo', 'Foo')

    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Bar'})
      await tx.setProperty('b', aliasesProp, ['Bar'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      // User renames b's alias from [Bar] to [Foo] — content is
      // "Bar", removed=["Bar"], added=["Foo"]. AR1 sync plan would
      // rewrite content to "Foo" AND newly claim "Foo".
      await env.repo.tx(
        tx => tx.setProperty('b', aliasesProp, ['Foo']),
        {scope: ChangeScope.BlockDefault},
      )
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')

    // b stayed at content "Bar", aliases ["Bar"].
    expect((await env.read('b'))!.content).toBe('Bar')
    expect(await readAliases('b')).toEqual(['Bar'])
  })
})

describe('alias.collision — direct claim (no content change)', () => {
  it('rejects when user adds a taken alias via setProperty', async () => {
    await seatAt('Shared', 'Shared')

    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'distinct'})
      await tx.setProperty('b', aliasesProp, ['distinct'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    let caught: unknown
    try {
      // Adds 'Shared' alongside the existing 'distinct' — not a
      // 1-for-1 swap, not a content edit, but still claims a taken
      // name. The "directly claimed" branch of planSync catches this.
      await env.repo.tx(
        tx => tx.setProperty('b', aliasesProp, ['distinct', 'Shared']),
        {scope: ChangeScope.BlockDefault},
      )
    } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect((caught as ProcessorRejection).code).toBe('alias.collision')

    expect(await readAliases('b')).toEqual(['distinct'])
  })
})

describe('alias.collision — self-reclaim is not a collision', () => {
  it('a block re-asserting its own alias commits normally', async () => {
    const id = await seatAt('Self', 'Self')

    // Re-write the same alias property — same-tx sync should NOT
    // detect a collision because the claimant is this block itself.
    await env.repo.tx(
      tx => tx.setProperty(id, aliasesProp, ['Self']),
      {scope: ChangeScope.BlockDefault},
    )

    expect(await readAliases(id)).toEqual(['Self'])
  })
})

describe('alias.collision — user-error listener wiring', () => {
  it('fires onUserError with the ProcessorRejection', async () => {
    await seatAt('Taken', 'Taken')
    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'mine'})
      await tx.setProperty('b', aliasesProp, ['mine'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    const errors: ProcessorRejection[] = []
    const unsubscribe = env.repo.onUserError(e => errors.push(e))

    try {
      await env.repo.mutate.setContent({id: 'b', content: 'Taken'})
    } catch { /* expected */ }

    unsubscribe()

    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('alias.collision')
    expect(errors[0].meta).toMatchObject({alias: 'Taken', attemptedOn: 'b'})
  })

  it('listener errors are caught + logged, do not poison the throw chain', async () => {
    await seatAt('X', 'X')
    await env.repo.tx(async tx => {
      await tx.create({id: 'b', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'b'})
      await tx.setProperty('b', aliasesProp, ['b'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.repo.onUserError(() => { throw new Error('listener bug') })

    let caught: unknown
    try {
      await env.repo.mutate.setContent({id: 'b', content: 'X'})
    } catch (err) { caught = err }

    // Original ProcessorRejection still propagates (listener crash
    // doesn't replace it).
    expect(caught).toBeInstanceOf(ProcessorRejection)
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
