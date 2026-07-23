// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import type { Dependency } from '@/data/internals/handleStore'
import { type AppExtension } from '@/facets/facet.js'
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
  const { repo } = createTestRepo({
    db: h.db,
    user: { id: 'user-1' },
    extensions: [ext],
  })
  return { h, repo }
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

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

    // A content edit on an unrelated block must not invalidate the count loader.
    // Assert the loader-invalidation counter directly (per AGENTS.md): the
    // subscriber path sits downstream of structural-diff dedup, so an erroneous
    // re-resolve to the same number is suppressed and `fired` alone can't see it.
    // The counter increments before any dedup, synchronously inside the post-
    // commit walk. The real reference writes below are the liveness fence.
    const beforeNoop = env.repo.handleStore.metrics.loaderInvalidations
    await env.repo.mutate.setContent({ id: 'unrelated', content: 'noise' })
    expect(env.repo.handleStore.metrics.loaderInvalidations).toBe(beforeNoop)
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

  // The badge must not count sources the expanded list drops, or the user sees
  // a phantom backlink that vanishes on expand.
  it('excludes property-machinery sources in a child-backed workspace (badge/list parity)', async () => {
    const FLIP_WS = 'ws-flip'
    await sharedDb.db.execute(
      `INSERT OR REPLACE INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, 'flip ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
      [FLIP_WS],
    )
    const createIn = (args: {
      id: string; parentId?: string | null; content?: string
      referenceTargetId?: string | null; references?: BlockReference[]
    }) =>
      env.repo.tx(tx => tx.create({
        id: args.id, workspaceId: FLIP_WS, parentId: args.parentId ?? null,
        orderKey: `k-${args.id}`, content: args.content ?? '',
        referenceTargetId: args.referenceTargetId, references: args.references ?? [],
      }), { scope: ChangeScope.BlockDefault })

    await createIn({ id: 'D', content: 'status' })
    await sharedDb.db.execute(
      `INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES ('D', ?, 'property-schema')`,
      [FLIP_WS],
    )
    await createIn({ id: 'Target' })
    await createIn({ id: 'O' })
    await createIn({ id: 'F', parentId: 'O', content: '((D))', referenceTargetId: 'D' })
    // Hidden value row pointing at Target — the owning block's reprojection
    // already carries this backlink, so the list drops it and so must the badge.
    await createIn({ id: 'V', parentId: 'F', references: [{ id: 'Target', alias: 'T' }] })
    await createIn({ id: 'Q', references: [{ id: 'Target', alias: 'T' }] })

    await expectCount('Target', 1, FLIP_WS)
  })
})
