// @vitest-environment node
/**
 * Parity safety net for chunk C — direct A/B verification that the
 * new `repo.query.X(args).load()` surface returns the SAME data as
 * the legacy `repo.findX(...)` / reactive `repo.subtree(id)` etc.
 * methods on the same fixtures.
 *
 * The shape-level coverage in `kernelQueries.test.ts` and
 * `repoQueries.test.ts` each independently confirms its own surface
 * works — but neither asserts equivalence between the two. Chunk C
 * is about to delete the legacy methods, so this file pins the
 * "before deletion" parity contract: every kernel query must be
 * a drop-in for the legacy method it replaces.
 *
 * After chunk C deletes the legacy methods, this file goes away.
 *
 * Test strategy:
 *   - Seed one fixture per query with the variations that matter
 *     (multiple workspaces, soft-deleted rows, ordering, edge cases).
 *   - Call BOTH surfaces against the same args.
 *   - Assert deep equality on the returned BlockData[] / value.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { aliasesProp, typeProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from './repo'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

interface Harness {
  h: TestDb
  cache: BlockCache
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
  return {h, cache, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const create = async (args: {
  id: string
  parentId?: string | null
  orderKey?: string
  content?: string
  workspaceId?: string
  aliases?: string[]
  type?: string
  references?: BlockReference[]
}) => {
  const properties: Record<string, unknown> = {}
  if (args.aliases) properties[aliasesProp.name] = aliasesProp.codec.encode(args.aliases)
  if (args.type) properties[typeProp.name] = typeProp.codec.encode(args.type)
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: args.workspaceId ?? WS,
      parentId: args.parentId ?? null,
      orderKey: args.orderKey ?? 'a0',
      content: args.content ?? '',
      properties,
      references: args.references ?? [],
    })
  }, {scope: ChangeScope.BlockDefault})
}

// ════════════════════════════════════════════════════════════════════
// Helper: deep-equal assertion that walks BlockData arrays in order.
// ════════════════════════════════════════════════════════════════════

const seedTreeFixture = async () => {
  await create({id: 'r'})
  await create({id: 'c1', parentId: 'r', orderKey: 'a0', content: 'first'})
  await create({id: 'c2', parentId: 'r', orderKey: 'a1', content: 'second'})
  await create({id: 'gc1', parentId: 'c1', orderKey: 'a0'})
  await create({id: 'gc2', parentId: 'c1', orderKey: 'a1'})
}

const seedReferenceFixture = async () => {
  await create({id: 'target', content: 'Target page'})
  await create({id: 'src1', references: [{id: 'target', alias: 'target'}]})
  await create({id: 'src2', references: [{id: 'target', alias: 'target'}]})
  await create({id: 'unrelated'})
}

const seedTypeFixture = async () => {
  await create({id: 'note1', type: 'note', content: 'first note'})
  await create({id: 'note2', type: 'note', content: 'second note'})
  await create({id: 'task1', type: 'task'})
  await create({id: 'untyped'})
}

const seedAliasFixture = async () => {
  await create({id: 'a', content: 'Inbox content', aliases: ['Inbox', 'Important']})
  await create({id: 'b', content: 'Tasks content', aliases: ['Tasks']})
  await create({id: 'c', aliases: ['Inbox-2']}) // duplicate-ish substring
  await create({id: 'tomb', aliases: ['Dead']})
  await env.repo.tx(tx => tx.delete('tomb'), {scope: ChangeScope.BlockDefault})
}

// ════════════════════════════════════════════════════════════════════
// Tree queries
// ════════════════════════════════════════════════════════════════════

describe('subtree parity', () => {
  it('matches loadSubtree across full tree fixtures', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.loadSubtree('r')
    const next = await env.repo.query.subtree({id: 'r'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches on missing-root (both empty)', async () => {
    const legacy = await env.repo.loadSubtree('no-such')
    const next = await env.repo.query.subtree({id: 'no-such'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches with soft-deleted descendant excluded', async () => {
    await seedTreeFixture()
    await env.repo.tx(tx => tx.delete('c1'), {scope: ChangeScope.BlockDefault})
    const legacy = await env.repo.loadSubtree('r')
    const next = await env.repo.query.subtree({id: 'r'}).load()
    expect(next).toEqual(legacy)
  })
})

describe('ancestors parity', () => {
  it('matches loadAncestors on a deep chain', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.loadAncestors('gc1')
    const next = await env.repo.query.ancestors({id: 'gc1'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches when id is at the root (both empty)', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.loadAncestors('r')
    const next = await env.repo.query.ancestors({id: 'r'}).load()
    expect(next).toEqual(legacy)
  })
})

describe('children parity', () => {
  it('matches repo.children handle on the same parent', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.children('r').load()
    const next = await env.repo.query.children({id: 'r'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches on a leaf (both empty)', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.children('gc1').load()
    const next = await env.repo.query.children({id: 'gc1'}).load()
    expect(next).toEqual(legacy)
  })
})

describe('childIds parity', () => {
  it('lean variant matches the legacy lean handle', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.childIds('r').load()
    const next = await env.repo.query.childIds({id: 'r'}).load()
    expect(next).toEqual(legacy)
  })

  it('hydrate variant matches the legacy hydrating handle', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.childIds('r', {hydrate: true}).load()
    const next = await env.repo.query.childIds({id: 'r', hydrate: true}).load()
    expect(next).toEqual(legacy)
  })
})

// ════════════════════════════════════════════════════════════════════
// Reference / search queries
// ════════════════════════════════════════════════════════════════════

describe('backlinks parity', () => {
  it('matches findBacklinks with same workspaceId + targetId', async () => {
    await seedReferenceFixture()
    const legacy = await env.repo.findBacklinks(WS, 'target')
    const next = await env.repo.query.backlinks({workspaceId: WS, id: 'target'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches with no backlinks (both empty)', async () => {
    await seedReferenceFixture()
    const legacy = await env.repo.findBacklinks(WS, 'unrelated')
    const next = await env.repo.query.backlinks({workspaceId: WS, id: 'unrelated'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches with cross-workspace isolation', async () => {
    await create({id: 'target', workspaceId: WS})
    await create({id: 'remote-src', workspaceId: OTHER_WS, references: [{id: 'target', alias: 'target'}]})
    const legacyWs = await env.repo.findBacklinks(WS, 'target')
    const nextWs = await env.repo.query.backlinks({workspaceId: WS, id: 'target'}).load()
    expect(nextWs).toEqual(legacyWs)
    const legacyOther = await env.repo.findBacklinks(OTHER_WS, 'target')
    const nextOther = await env.repo.query.backlinks({workspaceId: OTHER_WS, id: 'target'}).load()
    expect(nextOther).toEqual(legacyOther)
  })

  it('matches empty-args guard returns []', async () => {
    expect(await env.repo.query.backlinks({workspaceId: '', id: 'x'}).load())
      .toEqual(await env.repo.findBacklinks('', 'x'))
    expect(await env.repo.query.backlinks({workspaceId: WS, id: ''}).load())
      .toEqual(await env.repo.findBacklinks(WS, ''))
  })
})

describe('byType parity', () => {
  it('matches findBlocksByType', async () => {
    await seedTypeFixture()
    const legacy = await env.repo.findBlocksByType(WS, 'note')
    const next = await env.repo.query.byType({workspaceId: WS, type: 'note'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches when no rows of that type', async () => {
    await seedTypeFixture()
    const legacy = await env.repo.findBlocksByType(WS, 'missing')
    const next = await env.repo.query.byType({workspaceId: WS, type: 'missing'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches with soft-deleted rows excluded', async () => {
    await seedTypeFixture()
    await env.repo.tx(tx => tx.delete('note1'), {scope: ChangeScope.BlockDefault})
    const legacy = await env.repo.findBlocksByType(WS, 'note')
    const next = await env.repo.query.byType({workspaceId: WS, type: 'note'}).load()
    expect(next).toEqual(legacy)
  })
})

describe('searchByContent parity', () => {
  it('matches case-insensitive substring + limit + ordering', async () => {
    await seedTypeFixture()
    const legacyDefault = await env.repo.searchBlocksByContent(WS, 'note')
    const nextDefault = await env.repo.query.searchByContent({workspaceId: WS, query: 'note'}).load()
    expect(nextDefault).toEqual(legacyDefault)

    const legacyLimit = await env.repo.searchBlocksByContent(WS, 'note', 1)
    const nextLimit = await env.repo.query.searchByContent({workspaceId: WS, query: 'note', limit: 1}).load()
    expect(nextLimit).toEqual(legacyLimit)
  })

  it('matches empty-query guard returns []', async () => {
    expect(await env.repo.query.searchByContent({workspaceId: WS, query: ''}).load())
      .toEqual(await env.repo.searchBlocksByContent(WS, ''))
  })
})

describe('firstChildByContent parity', () => {
  it('matches findFirstChildByContent (returns the same row or null)', async () => {
    await create({id: 'p'})
    await create({id: 'c2', parentId: 'p', orderKey: 'a2', content: 'hi'})
    await create({id: 'c1', parentId: 'p', orderKey: 'a1', content: 'hi'})

    const legacy = await env.repo.findFirstChildByContent('p', 'hi')
    const next = await env.repo.query.firstChildByContent({parentId: 'p', content: 'hi'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches null on no-match', async () => {
    await create({id: 'p'})
    const legacy = await env.repo.findFirstChildByContent('p', 'absent')
    const next = await env.repo.query.firstChildByContent({parentId: 'p', content: 'absent'}).load()
    expect(next).toEqual(legacy)
  })
})

// ════════════════════════════════════════════════════════════════════
// Alias queries
// ════════════════════════════════════════════════════════════════════

describe('aliasesInWorkspace parity', () => {
  it('matches getAliasesInWorkspace (no filter)', async () => {
    await seedAliasFixture()
    const legacy = await env.repo.getAliasesInWorkspace(WS)
    const next = await env.repo.query.aliasesInWorkspace({workspaceId: WS}).load()
    expect(next).toEqual(legacy)
  })

  it('matches with case-insensitive filter', async () => {
    await seedAliasFixture()
    const legacy = await env.repo.getAliasesInWorkspace(WS, 'IN')
    const next = await env.repo.query.aliasesInWorkspace({workspaceId: WS, filter: 'IN'}).load()
    expect(next).toEqual(legacy)
  })
})

describe('aliasMatches parity', () => {
  it('matches findAliasMatchesInWorkspace (one row per alias × block)', async () => {
    await seedAliasFixture()
    const legacy = await env.repo.findAliasMatchesInWorkspace(WS, '')
    const next = await env.repo.query.aliasMatches({workspaceId: WS, filter: ''}).load()
    expect(next).toEqual(legacy)
  })

  it('matches with substring + limit', async () => {
    await seedAliasFixture()
    const legacyLimit = await env.repo.findAliasMatchesInWorkspace(WS, 'in', 2)
    const nextLimit = await env.repo.query.aliasMatches({workspaceId: WS, filter: 'in', limit: 2}).load()
    expect(nextLimit).toEqual(legacyLimit)
  })
})

describe('aliasLookup parity', () => {
  it('matches findBlockByAliasInWorkspace on exact-match', async () => {
    await seedAliasFixture()
    const legacy = await env.repo.findBlockByAliasInWorkspace(WS, 'Inbox')
    const next = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Inbox'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches null on no-match', async () => {
    const legacy = await env.repo.findBlockByAliasInWorkspace(WS, 'absent')
    const next = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'absent'}).load()
    expect(next).toEqual(legacy)
  })

  it('matches across workspaces independently', async () => {
    await create({id: 'a', aliases: ['Foo'], workspaceId: WS})
    await create({id: 'b', aliases: ['Foo'], workspaceId: OTHER_WS})
    const legacyA = await env.repo.findBlockByAliasInWorkspace(WS, 'Foo')
    const nextA = await env.repo.query.aliasLookup({workspaceId: WS, alias: 'Foo'}).load()
    expect(nextA).toEqual(legacyA)
    const legacyB = await env.repo.findBlockByAliasInWorkspace(OTHER_WS, 'Foo')
    const nextB = await env.repo.query.aliasLookup({workspaceId: OTHER_WS, alias: 'Foo'}).load()
    expect(nextB).toEqual(legacyB)
  })
})

// ════════════════════════════════════════════════════════════════════
// Dynamic-plugin discovery
// ════════════════════════════════════════════════════════════════════

describe('findExtensionBlocks parity', () => {
  it('matches findBlocksByType(workspaceId, "extension")', async () => {
    await create({id: 'ext1', type: 'extension'})
    await create({id: 'ext2', type: 'extension'})
    await create({id: 'note', type: 'note'})
    // Legacy is invoked through findBlocksByType — there is no
    // dedicated repo.findExtensionBlocks. The new query is the
    // first-class shape; parity is "same content as findBlocksByType
    // with the type filter pinned".
    const legacy = await env.repo.findBlocksByType(WS, 'extension')
    const next = await env.repo.query.findExtensionBlocks({workspaceId: WS}).load()
    expect(next).toEqual(legacy)
  })
})

// ════════════════════════════════════════════════════════════════════
// Reactive handle parity (subtree / ancestors / backlinks): both
// surfaces produce the same data on a fresh load. (Identity is NOT
// expected to match — they're different handle slots; chunk C deletes
// the legacy slots.)
// ════════════════════════════════════════════════════════════════════

describe('subtree handle parity (loaded value, not identity)', () => {
  it('repo.subtree(id) and repo.query.subtree({id}) produce the same data', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.subtree('r').load()
    const next = await env.repo.query.subtree({id: 'r'}).load()
    expect(next).toEqual(legacy)
  })
})

describe('ancestors handle parity (loaded value)', () => {
  it('repo.ancestors(id) and repo.query.ancestors({id}) produce the same data', async () => {
    await seedTreeFixture()
    const legacy = await env.repo.ancestors('gc1').load()
    const next = await env.repo.query.ancestors({id: 'gc1'}).load()
    expect(next).toEqual(legacy)
  })
})

describe('backlinks handle parity (loaded value)', () => {
  it('repo.backlinks(id) and repo.query.backlinks({workspaceId, id}) produce the same data', async () => {
    await seedReferenceFixture()
    // Legacy resolves workspaceId from cache or load(); the new query
    // requires it as an arg. Pre-load so the cache has the row, which
    // is the typical caller shape.
    await env.repo.load('target')
    const legacy = await env.repo.backlinks('target').load()
    const next = await env.repo.query.backlinks({workspaceId: WS, id: 'target'}).load()
    expect(next).toEqual(legacy)
  })
})
