// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockData, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import type { Dependency } from '@/data/internals/handleStore'
import { aliasesProp } from '@/data/properties'
import { resolveFacetRuntimeSync, type AppExtension } from '@/extensions/facet.ts'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { codeMirrorExtensionsFacet } from '@/extensions/editor.ts'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import { invalidationRulesFacet, localSchemaFacet, queriesFacet } from '@/data/facets.ts'
import { backlinksDataExtension } from '../dataExtension.ts'
import {
  BACKLINKS_TARGET_INVALIDATION_CHANNEL,
  backlinksInvalidationRule,
} from '../invalidation.ts'
import { backlinksLocalSchema } from '../localSchema.ts'
import { backlinksPlugin } from '../index.ts'
import { BACKLINKS_FOR_BLOCK_QUERY, backlinksForBlockQuery } from '../query.ts'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

const backlinksQueryInvalidationExtension: AppExtension = [
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  invalidationRulesFacet.of(backlinksInvalidationRule, {source: 'backlinks'}),
]

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
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    backlinksQueryInvalidationExtension,
  ]))
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const create = async (args: {
  id: string
  content?: string
  workspaceId?: string
  parentId?: string | null
  orderKey?: string
  references?: BlockReference[]
}) => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: args.workspaceId ?? WS,
      parentId: args.parentId ?? null,
      orderKey: args.orderKey ?? `key-${args.id}`,
      content: args.content ?? '',
      references: args.references ?? [],
    })
  }, {scope: ChangeScope.BlockDefault})
}

const asBlocks = (v: BlockData[] | undefined): BlockData[] => v ?? []

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

describe('backlinksDataExtension query', () => {
  it('contributes backlinks.forBlock through queriesFacet', () => {
    const runtime = resolveFacetRuntimeSync(backlinksDataExtension)
    const queries = runtime.read(queriesFacet)

    expect(queries.get(BACKLINKS_FOR_BLOCK_QUERY)).toBeDefined()
  })

  it('contributes its local edge index schema through localSchemaFacet', () => {
    const runtime = resolveFacetRuntimeSync(backlinksDataExtension)
    expect(runtime.read(localSchemaFacet)).toEqual([backlinksLocalSchema])
  })

  it('contributes its reference invalidation through invalidationRulesFacet', () => {
    const runtime = resolveFacetRuntimeSync(backlinksDataExtension)
    expect(runtime.read(invalidationRulesFacet)).toEqual([backlinksInvalidationRule])
  })

  it('owns markdown syntax and CodeMirror extension registrations', () => {
    const runtime = resolveFacetRuntimeSync(backlinksPlugin)

    expect(runtime.contributions(markdownExtensionsFacet).map(c => c.source)).toEqual([
      'backlinks',
      'backlinks',
    ])
    expect(runtime.contributions(codeMirrorExtensionsFacet).map(c => c.source)).toEqual(['backlinks'])
  })

  it('is identity-stable across calls', () => {
    const a = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 't'})
    const b = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 't'})
    expect(a).toBe(b)
  })

  it('returns blocks whose references include the target id', async () => {
    await create({id: 'target'})
    await create({id: 'src1', references: [{id: 'target', alias: 't'}]})
    await create({id: 'src2', references: [{id: 'target', alias: 't'}]})
    await create({id: 'unrelated'})
    const out = asBlocks(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(out.map(r => r.id).sort()).toEqual(['src1', 'src2'])
  })

  it('excludes self-reference', async () => {
    await create({id: 'self', references: [{id: 'self', alias: 'self'}]})
    const out = asBlocks(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'self'}).load(),
    )
    expect(out).toEqual([])
  })

  it('excludes soft-deleted source rows', async () => {
    await create({id: 'target'})
    await create({id: 'src', references: [{id: 'target', alias: 't'}]})
    await env.repo.tx(tx => tx.delete('src'), {scope: ChangeScope.BlockDefault})
    const out = asBlocks(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(out).toEqual([])
  })

  it('scopes to workspaceId', async () => {
    await create({id: 'target', workspaceId: WS})
    await create({
      id: 'src-other',
      workspaceId: OTHER_WS,
      references: [{id: 'target', alias: 't'}],
    })
    const wsOut = asBlocks(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(wsOut).toEqual([])

    const otherWs = asBlocks(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
        workspaceId: OTHER_WS,
        id: 'target',
      }).load(),
    )
    expect(otherWs.map(r => r.id)).toEqual(['src-other'])
  })

  it('filters backlinks by direct references on the source block', async () => {
    await create({id: 'target'})
    await create({id: 'tag'})
    await create({
      id: 'src1',
      references: [{id: 'target', alias: 'T'}, {id: 'tag', alias: 'Tag'}],
    })
    await create({id: 'src2', references: [{id: 'target', alias: 'T'}]})

    const out = asBlocks(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {includeIds: ['tag']},
    }).load())

    expect(out.map(row => row.id)).toEqual(['src1'])
  })

  it('filters backlinks by references on ancestor blocks', async () => {
    await create({id: 'target'})
    await create({id: 'tag'})
    await create({id: 'parent', references: [{id: 'tag', alias: 'Tag'}]})
    await create({
      id: 'child',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({id: 'sibling', references: [{id: 'target', alias: 'T'}]})

    const out = asBlocks(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {includeIds: ['tag']},
    }).load())

    expect(out.map(row => row.id)).toEqual(['child'])
  })

  it('filters backlinks by their containing root page', async () => {
    await create({id: 'target'})
    await create({id: 'page-a'})
    await create({id: 'page-b'})
    await create({
      id: 'child-a',
      parentId: 'page-a',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({
      id: 'child-b',
      parentId: 'page-b',
      references: [{id: 'target', alias: 'T'}],
    })

    const out = asBlocks(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {includeIds: ['page-a']},
    }).load())

    expect(out.map(row => row.id)).toEqual(['child-a'])
  })

  it('filters out backlinks that match remove references in source context', async () => {
    await create({id: 'target'})
    await create({id: 'done'})
    await create({id: 'keep', references: [{id: 'target', alias: 'T'}]})
    await create({
      id: 'skip',
      references: [{id: 'target', alias: 'T'}, {id: 'done', alias: 'DONE'}],
    })

    const out = asBlocks(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {removeIds: ['done']},
    }).load())

    expect(out.map(row => row.id)).toEqual(['keep'])
  })

  it('requires every include filter to match the source context', async () => {
    await create({id: 'target'})
    await create({id: 'tag-a'})
    await create({id: 'tag-b'})
    await create({
      id: 'partial',
      references: [{id: 'target', alias: 'T'}, {id: 'tag-a', alias: 'A'}],
    })
    await create({
      id: 'full',
      references: [
        {id: 'target', alias: 'T'},
        {id: 'tag-a', alias: 'A'},
        {id: 'tag-b', alias: 'B'},
      ],
    })

    const out = asBlocks(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {includeIds: ['tag-a', 'tag-b']},
    }).load())

    expect(out.map(row => row.id)).toEqual(['full'])
  })

  it('returns [] on empty workspaceId or id', async () => {
    await expect(
      env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: '', id: 'x'}).load(),
    ).resolves.toEqual([])
    await expect(
      env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: ''}).load(),
    ).resolves.toEqual([])
  })

  it('declares target row, plugin target, and source row deps', async () => {
    await create({id: 't', workspaceId: WS})
    await create({id: 'linker', workspaceId: WS})
    await env.h.db.execute(
      `UPDATE blocks SET references_json = ? WHERE id = ?`,
      [JSON.stringify([{id: 't', alias: 't'}]), 'linker'],
    )
    await env.repo.flushRowEventsTail()

    const handle = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 't'})
    await handle.load()
    const deps = handle.__depsForTest()

    expect(depIds(deps, 'row')).toEqual(['linker', 't'])
    expect(depIds(deps, 'plugin')).toEqual([`${BACKLINKS_TARGET_INVALIDATION_CHANNEL}:t`])
    expect(deps.some(d => d.kind === 'table')).toBe(false)
    expect(deps.some(d => d.kind === 'workspace')).toBe(false)
  })

  it('filtered query declares source-context row deps for excluded backlinks', async () => {
    await create({id: 'target'})
    await create({id: 'tag'})
    await create({id: 'parent'})
    await create({
      id: 'child',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })

    const handle = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {includeIds: ['tag']},
    })
    await handle.load()

    expect(handle.peek()).toEqual([])
    expect(depIds(handle.__depsForTest(), 'row')).toEqual(['child', 'parent', 'target'])
  })

  it('re-resolves only when sources gain or lose references to the target', async () => {
    await create({id: 'target'})
    await create({id: 'other-target'})
    await create({id: 'unrelated'})
    await create({id: 'src'})
    const handle = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'})
    const fired: BlockData[][] = []
    handle.subscribe((value) => { fired.push(value as BlockData[]) })
    await vi.waitFor(() => expect(fired.map(items => items.length)).toEqual([0]))

    await env.repo.mutate.setContent({id: 'unrelated', content: 'noise'})
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.map(items => items.length)).toEqual([0])

    await env.repo.tx(tx => tx.update('unrelated', {
      references: [{id: 'other-target', alias: 'OT'}],
    }), {scope: ChangeScope.BlockDefault})
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.map(items => items.length)).toEqual([0])

    await env.repo.tx(tx => tx.update('src', {
      references: [{id: 'target', alias: 'T'}],
    }), {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => {
      expect(fired.map(items => items.length)).toEqual([0, 1])
    })
    expect(handle.peek()?.map(block => block.id)).toEqual(['src'])

    await env.repo.tx(tx => tx.update('src', {references: []}), {
      scope: ChangeScope.BlockDefault,
    })
    await vi.waitFor(() => {
      expect(fired.map(items => items.length)).toEqual([0, 1, 0])
    })
  })

  it('re-resolves from sync-applied row events using the plugin invalidation rule', async () => {
    await create({id: 'target'})
    await create({id: 'src'})
    const handle = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'})
    const fired: BlockData[][] = []
    handle.subscribe((value) => { fired.push(value as BlockData[]) })
    await vi.waitFor(() => expect(fired.map(items => items.length)).toEqual([0]))

    await env.h.db.execute(
      `UPDATE blocks SET references_json = ? WHERE id = ?`,
      [JSON.stringify([{id: 'target', alias: 'T'}]), 'src'],
    )
    await env.repo.flushRowEventsTail()

    await vi.waitFor(() => {
      expect(fired.map(items => items.length)).toEqual([0, 1])
    })
    expect(handle.peek()?.map(block => block.id)).toEqual(['src'])
  })

  it('filtered query re-resolves when an ancestor gains a required reference', async () => {
    await create({id: 'target'})
    await create({id: 'tag'})
    await create({id: 'parent'})
    await create({
      id: 'child',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })
    const handle = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {includeIds: ['tag']},
    })
    const fired: BlockData[][] = []
    handle.subscribe((value) => { fired.push(value as BlockData[]) })
    await vi.waitFor(() => expect(fired.map(items => items.length)).toEqual([0]))

    await env.repo.tx(tx => tx.update('parent', {
      references: [{id: 'tag', alias: 'Tag'}],
    }), {scope: ChangeScope.BlockDefault})

    await vi.waitFor(() => {
      expect(fired.map(items => items.length)).toEqual([0, 1])
    })
    expect(handle.peek()?.map(block => block.id)).toEqual(['child'])
  })

  it('works when alias side indexes are also present', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'Target',
        properties: {[aliasesProp.name]: aliasesProp.codec.encode(['Target'])},
      })
      await tx.create({
        id: 'linker',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a1',
        references: [{id: 'target', alias: 'Target'}],
      })
    }, {scope: ChangeScope.BlockDefault})

    const out = asBlocks(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(out.map(row => row.id)).toEqual(['linker'])
  })
})
