// @vitest-environment node
/**
 * Repo kernel query tests (spec §13.4 / pre-Phase-4 surface). Exercises
 * the raw-SQL helpers exposed on `Repo` for outside-tx reads:
 *
 *   - findBacklinks
 *   - findBlocksByType
 *   - searchBlocksByContent
 *   - findBlockByAliasInWorkspace
 *   - getAliasesInWorkspace
 *   - findAliasMatchesInWorkspace
 *   - findFirstChildByContent
 *
 * These rebuild the behaviors covered by the deleted
 * `findBacklinks.test.ts` / `findBlocksByType.test.ts` /
 * `searchBlocksAndAliases.test.ts` / `aliasUtils.test.ts` against the
 * new flat property shape and `createTestDb` harness.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { aliasesProp, typeProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/internals/repo'

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
    // Don't register parseReferences — these tests seed `references`
    // directly via `tx.create({references})` and the processor would
    // overwrite that with whatever it parses out of `content`.
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

describe('Repo.findBacklinks', () => {
  it('returns [] on empty workspaceId or targetId', async () => {
    expect(await env.repo.findBacklinks(WS, '')).toEqual([])
    expect(await env.repo.findBacklinks('', 'target')).toEqual([])
  })

  it('returns blocks whose references field includes the target id', async () => {
    await create({id: 'target', content: 'Target page'})
    await create({id: 'src1', content: 'links to target', references: [{id: 'target', alias: 'Target page'}]})
    await create({id: 'src2', content: 'also links', references: [{id: 'target', alias: 'Target page'}]})
    await create({id: 'unrelated', content: 'no links'})

    const rows = await env.repo.findBacklinks(WS, 'target')
    expect(rows.map(r => r.id).sort()).toEqual(['src1', 'src2'])
  })

  it('excludes the target itself', async () => {
    await create({
      id: 'self',
      content: 'self-ref',
      references: [{id: 'self', alias: 'self'}],
    })
    expect(await env.repo.findBacklinks(WS, 'self')).toEqual([])
  })

  it('excludes soft-deleted blocks', async () => {
    await create({id: 'target'})
    await create({id: 'src', references: [{id: 'target', alias: 'target'}]})
    await env.repo.tx(tx => tx.delete('src'), {scope: ChangeScope.BlockDefault})
    expect(await env.repo.findBacklinks(WS, 'target')).toEqual([])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'target', workspaceId: WS})
    await create({id: 'src-other', workspaceId: OTHER_WS, references: [{id: 'target', alias: 'target'}]})
    expect(await env.repo.findBacklinks(WS, 'target')).toEqual([])
    const otherWsRows = await env.repo.findBacklinks(OTHER_WS, 'target')
    expect(otherWsRows.map(r => r.id)).toEqual(['src-other'])
  })

  it('hydrates matched rows into the cache', async () => {
    await create({id: 'target'})
    await create({id: 'src', content: 'hi', references: [{id: 'target', alias: 't'}]})
    env.cache.deleteSnapshot('src')

    await env.repo.findBacklinks(WS, 'target')
    expect(env.cache.getSnapshot('src')?.content).toBe('hi')
  })
})

describe('Repo.findBlocksByType', () => {
  it('returns blocks whose type property matches', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note'})
    await create({id: 'c', type: 'task'})
    await create({id: 'd'})

    const rows = await env.repo.findBlocksByType(WS, 'note')
    expect(rows.map(r => r.id).sort()).toEqual(['a', 'b'])
  })

  it('returns [] when no rows match', async () => {
    await create({id: 'a', type: 'note'})
    expect(await env.repo.findBlocksByType(WS, 'missing-type')).toEqual([])
  })

  it('returns [] on empty workspaceId', async () => {
    expect(await env.repo.findBlocksByType('', 'note')).toEqual([])
  })

  it('excludes soft-deleted blocks', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note'})
    await env.repo.tx(tx => tx.delete('a'), {scope: ChangeScope.BlockDefault})

    const rows = await env.repo.findBlocksByType(WS, 'note')
    expect(rows.map(r => r.id)).toEqual(['b'])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'a', type: 'note'})
    await create({id: 'b', type: 'note', workspaceId: OTHER_WS})

    expect((await env.repo.findBlocksByType(WS, 'note')).map(r => r.id)).toEqual(['a'])
    expect((await env.repo.findBlocksByType(OTHER_WS, 'note')).map(r => r.id)).toEqual(['b'])
  })

  it('hydrates results into the cache', async () => {
    await create({id: 'a', type: 'note', content: 'hello'})
    env.cache.deleteSnapshot('a')

    await env.repo.findBlocksByType(WS, 'note')
    expect(env.cache.getSnapshot('a')?.content).toBe('hello')
  })
})

describe('Repo.searchBlocksByContent', () => {
  it('returns [] on empty query', async () => {
    await create({id: 'a', content: 'hello world'})
    expect(await env.repo.searchBlocksByContent(WS, '')).toEqual([])
  })

  it('matches case-insensitive substring', async () => {
    await create({id: 'a', content: 'Hello World'})
    await create({id: 'b', content: 'goodbye'})

    const rows = await env.repo.searchBlocksByContent(WS, 'hello')
    expect(rows.map(r => r.id)).toEqual(['a'])
  })

  it('respects the limit argument', async () => {
    await create({id: 'a', content: 'foo 1'})
    await create({id: 'b', content: 'foo 2'})
    await create({id: 'c', content: 'foo 3'})

    const rows = await env.repo.searchBlocksByContent(WS, 'foo', 2)
    expect(rows).toHaveLength(2)
  })

  it('excludes empty-content and tombstoned blocks', async () => {
    await create({id: 'a', content: 'foo'})
    await create({id: 'b', content: ''})
    await create({id: 'c', content: 'foo'})
    await env.repo.tx(tx => tx.delete('c'), {scope: ChangeScope.BlockDefault})

    const rows = await env.repo.searchBlocksByContent(WS, 'foo')
    expect(rows.map(r => r.id)).toEqual(['a'])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'a', content: 'foo'})
    await create({id: 'b', content: 'foo', workspaceId: OTHER_WS})

    expect((await env.repo.searchBlocksByContent(WS, 'foo')).map(r => r.id)).toEqual(['a'])
  })
})

describe('Repo.findBlockByAliasInWorkspace', () => {
  it('returns null on empty alias', async () => {
    expect(await env.repo.findBlockByAliasInWorkspace(WS, '')).toBeNull()
  })

  it('returns the matching block (case-sensitive exact match)', async () => {
    await create({id: 'page', aliases: ['Inbox', 'inbox-2']})
    const got = await env.repo.findBlockByAliasInWorkspace(WS, 'Inbox')
    expect(got?.id).toBe('page')
  })

  it('returns null when no match', async () => {
    await create({id: 'page', aliases: ['Inbox']})
    expect(await env.repo.findBlockByAliasInWorkspace(WS, 'missing')).toBeNull()
  })

  it('returns the oldest match on duplicate aliases (deterministic)', async () => {
    // create A first (earlier timestamp), then B with the same alias
    await create({id: 'older', aliases: ['Dup']})
    await create({id: 'newer', aliases: ['Dup']})
    const got = await env.repo.findBlockByAliasInWorkspace(WS, 'Dup')
    expect(got?.id).toBe('older')
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'a', aliases: ['Foo']})
    await create({id: 'b', aliases: ['Foo'], workspaceId: OTHER_WS})

    expect((await env.repo.findBlockByAliasInWorkspace(WS, 'Foo'))?.id).toBe('a')
    expect((await env.repo.findBlockByAliasInWorkspace(OTHER_WS, 'Foo'))?.id).toBe('b')
  })

  it('excludes soft-deleted', async () => {
    await create({id: 'a', aliases: ['Foo']})
    await env.repo.tx(tx => tx.delete('a'), {scope: ChangeScope.BlockDefault})
    expect(await env.repo.findBlockByAliasInWorkspace(WS, 'Foo')).toBeNull()
  })

  it('hydrates the cache when a match is found', async () => {
    await create({id: 'page', content: 'body', aliases: ['Inbox']})
    env.cache.deleteSnapshot('page')

    await env.repo.findBlockByAliasInWorkspace(WS, 'Inbox')
    expect(env.cache.getSnapshot('page')?.content).toBe('body')
  })
})

describe('Repo.getAliasesInWorkspace', () => {
  it('returns distinct aliases from all live blocks', async () => {
    await create({id: 'a', aliases: ['Foo', 'Bar']})
    await create({id: 'b', aliases: ['Bar', 'Baz']})

    const aliases = await env.repo.getAliasesInWorkspace(WS)
    expect(aliases.sort()).toEqual(['Bar', 'Baz', 'Foo'])
  })

  it('filters by case-insensitive substring when filter passed', async () => {
    await create({id: 'a', aliases: ['Inbox', 'Tasks']})
    await create({id: 'b', aliases: ['notes']})

    const aliases = await env.repo.getAliasesInWorkspace(WS, 'IN')
    // 'Inbox' contains 'in' (case-insensitive); 'Tasks' / 'notes' don't.
    expect(aliases).toEqual(['Inbox'])
  })

  it('excludes tombstoned blocks', async () => {
    await create({id: 'a', aliases: ['Live']})
    await create({id: 'b', aliases: ['Dead']})
    await env.repo.tx(tx => tx.delete('b'), {scope: ChangeScope.BlockDefault})

    const aliases = await env.repo.getAliasesInWorkspace(WS)
    expect(aliases).toEqual(['Live'])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'a', aliases: ['Same']})
    await create({id: 'b', aliases: ['Other'], workspaceId: OTHER_WS})

    expect(await env.repo.getAliasesInWorkspace(WS)).toEqual(['Same'])
    expect(await env.repo.getAliasesInWorkspace(OTHER_WS)).toEqual(['Other'])
  })

  it('returns [] on empty workspaceId', async () => {
    expect(await env.repo.getAliasesInWorkspace('')).toEqual([])
  })
})

describe('Repo.findAliasMatchesInWorkspace', () => {
  it('returns one row per (alias, block) with content', async () => {
    await create({id: 'a', content: 'Inbox content', aliases: ['Inbox', 'Important']})
    await create({id: 'b', content: 'Tasks content', aliases: ['Tasks']})

    const rows = await env.repo.findAliasMatchesInWorkspace(WS, '')
    expect(rows.map(r => `${r.alias}|${r.blockId}|${r.content}`).sort()).toEqual([
      'Important|a|Inbox content',
      'Inbox|a|Inbox content',
      'Tasks|b|Tasks content',
    ])
  })

  it('filters by substring case-insensitively', async () => {
    await create({id: 'a', aliases: ['Inbox', 'Tasks']})
    await create({id: 'b', aliases: ['Notes']})

    const rows = await env.repo.findAliasMatchesInWorkspace(WS, 'TASK')
    expect(rows.map(r => r.alias)).toEqual(['Tasks'])
  })

  it('respects the limit argument', async () => {
    await create({id: 'a', aliases: ['x1', 'x2', 'x3']})
    const rows = await env.repo.findAliasMatchesInWorkspace(WS, 'x', 2)
    expect(rows).toHaveLength(2)
  })

  it('excludes tombstoned blocks', async () => {
    await create({id: 'a', aliases: ['Live']})
    await create({id: 'b', aliases: ['Dead']})
    await env.repo.tx(tx => tx.delete('b'), {scope: ChangeScope.BlockDefault})

    const rows = await env.repo.findAliasMatchesInWorkspace(WS, '')
    expect(rows.map(r => r.alias)).toEqual(['Live'])
  })
})

describe('Repo.findFirstChildByContent', () => {
  it('returns null when no child matches', async () => {
    await create({id: 'parent'})
    expect(await env.repo.findFirstChildByContent('parent', 'missing')).toBeNull()
  })

  it('returns the first child by (orderKey, id) on exact match', async () => {
    await create({id: 'parent'})
    await create({id: 'c1', parentId: 'parent', orderKey: 'a2', content: 'hello'})
    await create({id: 'c2', parentId: 'parent', orderKey: 'a1', content: 'hello'})
    await create({id: 'c3', parentId: 'parent', orderKey: 'a3', content: 'hello'})

    const got = await env.repo.findFirstChildByContent('parent', 'hello')
    expect(got?.id).toBe('c2')
  })

  it('excludes soft-deleted children', async () => {
    await create({id: 'parent'})
    await create({id: 'c1', parentId: 'parent', orderKey: 'a1', content: 'hi'})
    await create({id: 'c2', parentId: 'parent', orderKey: 'a2', content: 'hi'})
    await env.repo.tx(tx => tx.delete('c1'), {scope: ChangeScope.BlockDefault})

    const got = await env.repo.findFirstChildByContent('parent', 'hi')
    expect(got?.id).toBe('c2')
  })

  it('hydrates the matched row into cache', async () => {
    await create({id: 'parent'})
    await create({id: 'c', parentId: 'parent', content: 'find-me'})
    env.cache.deleteSnapshot('c')

    await env.repo.findFirstChildByContent('parent', 'find-me')
    expect(env.cache.getSnapshot('c')?.content).toBe('find-me')
  })
})
