// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import type { Dependency } from '@/data/internals/handleStore'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { invalidationRulesFacet, queriesFacet } from '@/data/facets.js'
import { referencesInvalidationRule } from '@/plugins/references/invalidation.js'
import {
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksReferenceKey,
  typedBlocksStructureKey,
} from '@/data/invalidation'
import { BACKLINKS_FOR_BLOCK_QUERY, backlinksForBlockQuery } from '../../query.ts'
import {
  BACKLINKS_COUNT_FOR_BLOCK_QUERY,
  backlinksCountForBlockQuery,
} from '../countQuery.ts'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

// Register both queries so each parity assertion can compare the count against
// the actual `backlinks.forBlock` list length, plus the references rule so
// reactivity tests see sync-style invalidation.
const ext: AppExtension = [
  queriesFacet.of(backlinksForBlockQuery, { source: 'backlinks' }),
  queriesFacet.of(backlinksCountForBlockQuery, { source: 'backlinks-inline-counts' }),
  invalidationRulesFacet.of(referencesInvalidationRule, { source: 'references' }),
]

interface Harness {
  h: TestDb
  repo: Repo
}

let sharedDb: TestDb
let env: Harness

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: { id: 'user-1' },
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension, ext]))
  return { h, repo }
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { env.repo.stopSyncObserver() })

const create = async (args: {
  id: string
  content?: string
  workspaceId?: string
  parentId?: string | null
  references?: BlockReference[]
}) => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: args.workspaceId ?? WS,
      parentId: args.parentId ?? null,
      orderKey: `key-${args.id}`,
      content: args.content ?? '',
      references: args.references ?? [],
    })
  }, { scope: ChangeScope.BlockDefault })
}

const count = (id: string, ws = WS): Promise<number> =>
  env.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId: ws, id }).load()
const forBlockLen = async (id: string, ws = WS): Promise<number> =>
  (await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({ workspaceId: ws, id }).load()).length

/** The contract: countForBlock === forBlock(...).length, and equals `expected`. */
const expectCount = async (id: string, expected: number, ws = WS) => {
  expect(await count(id, ws)).toBe(expected)
  expect(await count(id, ws)).toBe(await forBlockLen(id, ws))
}

const depIds = (deps: readonly Dependency[], kind: Dependency['kind']) =>
  deps
    .filter(d => d.kind === kind)
    .map(d => {
      if (d.kind === 'row') return d.id
      if (d.kind === 'parent-edge') return d.parentId
      if (d.kind === 'workspace') return d.workspaceId
      if (d.kind === 'plugin') return `${d.channel}:${d.key}`
      return d.table
    })
    .sort()

describe('backlinks.countForBlock — parity with forBlock(...).length', () => {
  it('counts distinct sources referencing the target', async () => {
    await create({ id: 'target' })
    await create({ id: 'src1', references: [{ id: 'target', alias: 't' }] })
    await create({ id: 'src2', references: [{ id: 'target', alias: 't' }] })
    await create({ id: 'unrelated' })
    await expectCount('target', 2)
  })

  it('excludes the self-reference', async () => {
    await create({ id: 'self', references: [{ id: 'self', alias: 'self' }] })
    await expectCount('self', 0)
  })

  it('excludes soft-deleted sources', async () => {
    await create({ id: 'target' })
    await create({ id: 'src', references: [{ id: 'target', alias: 't' }] })
    await env.repo.tx(tx => tx.delete('src'), { scope: ChangeScope.BlockDefault })
    await expectCount('target', 0)
  })

  it('counts a source once even when it references the target several times', async () => {
    await create({ id: 'target' })
    await create({
      id: 'src',
      references: [
        { id: 'target', alias: 'A' },
        { id: 'target', alias: 'B' },
      ],
    })
    await expectCount('target', 1)
  })

  it('scopes to workspace', async () => {
    await create({ id: 'target', workspaceId: WS })
    await create({
      id: 'src-other',
      workspaceId: OTHER_WS,
      references: [{ id: 'target', alias: 't' }],
    })
    await expectCount('target', 0, WS)
    await expectCount('target', 1, OTHER_WS)
  })

  it('returns 0 for empty workspaceId or id', async () => {
    await expect(count('x', '')).resolves.toBe(0)
    await expect(env.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId: WS, id: '' }).load())
      .resolves.toBe(0)
  })
})

describe('backlinks.countForBlock — handle behaviour', () => {
  it('is identity-stable across calls', () => {
    const a = env.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId: WS, id: 't' })
    const b = env.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId: WS, id: 't' })
    expect(a).toBe(b)
  })

  it('declares the same precise deps as forBlock (reference + structure, no coarse deps)', async () => {
    await create({ id: 't' })
    await create({ id: 'linker', references: [{ id: 't', alias: 't' }] })

    const handle = env.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId: WS, id: 't' })
    await handle.load()
    const deps = handle.__depsForTest()

    expect(depIds(deps, 'row')).toEqual([])
    expect(depIds(deps, 'plugin')).toContain(
      `${TYPED_BLOCKS_REFERENCE_CHANNEL}:${typedBlocksReferenceKey(WS, 't')}`,
    )
    expect(depIds(deps, 'plugin')).toContain(
      `${TYPED_BLOCKS_STRUCTURE_CHANNEL}:${typedBlocksStructureKey(WS, 't')}`,
    )
    expect(deps.some(d => d.kind === 'table')).toBe(false)
    expect(deps.some(d => d.kind === 'workspace')).toBe(false)
  })

  it('re-resolves only when a source gains or loses a reference to the target', async () => {
    await create({ id: 'target' })
    await create({ id: 'unrelated' })
    await create({ id: 'src' })
    const handle = env.repo.query[BACKLINKS_COUNT_FOR_BLOCK_QUERY]({ workspaceId: WS, id: 'target' })
    const fired: number[] = []
    handle.subscribe(value => { fired.push(value) })
    await vi.waitFor(() => expect(fired).toEqual([0]))

    // A content edit that doesn't touch references must not re-fire the count.
    await env.repo.mutate.setContent({ id: 'unrelated', content: 'noise' })
    await Promise.resolve()
    await Promise.resolve()
    expect(fired).toEqual([0])

    // Adding a reference to the target bumps the count.
    await env.repo.tx(tx => tx.update('src', {
      references: [{ id: 'target', alias: 'T' }],
    }), { scope: ChangeScope.BlockDefault })
    await vi.waitFor(() => expect(fired).toEqual([0, 1]))

    // Removing it drops it back.
    await env.repo.tx(tx => tx.update('src', { references: [] }), {
      scope: ChangeScope.BlockDefault,
    })
    await vi.waitFor(() => expect(fired).toEqual([0, 1, 0]))
  })
})
