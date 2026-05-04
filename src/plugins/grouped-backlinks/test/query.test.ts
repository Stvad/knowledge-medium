// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync, type AppExtension } from '@/extensions/facet.ts'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { invalidationRulesFacet, queriesFacet } from '@/data/facets.ts'
import { backlinksForBlockQuery } from '@/plugins/backlinks/query.ts'
import { backlinksInvalidationRule } from '@/plugins/backlinks/invalidation.ts'
import {
  GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
} from '../query.ts'
import { groupedBacklinksDataExtension } from '../dataExtension.ts'

const WS = 'ws-1'

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
    groupedBacklinksDataExtension,
  ]))
  return {h, repo}
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

const create = async (args: {
  id: string
  content?: string
  parentId?: string | null
  orderKey?: string
  references?: BlockReference[]
}) => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: WS,
      parentId: args.parentId ?? null,
      orderKey: args.orderKey ?? `key-${args.id}`,
      content: args.content ?? args.id,
      references: args.references ?? [],
    })
  }, {scope: ChangeScope.BlockDefault})
}

const sorted = (ids: readonly string[]) => [...ids].sort()

describe('groupedBacklinksDataExtension query', () => {
  it('contributes groupedBacklinks.forBlock through queriesFacet', () => {
    const runtime = resolveFacetRuntimeSync(groupedBacklinksDataExtension)
    const queries = runtime.read(queriesFacet)

    expect(queries.get(GROUPED_BACKLINKS_FOR_BLOCK_QUERY)).toBeDefined()
  })

  it('groups backlinks by common direct references and merges singletons into Other', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'topic-a', content: 'Topic A'})
    await create({id: 'topic-b', content: 'Topic B'})
    await create({
      id: 'src-a1',
      references: [{id: 'target', alias: 'T'}, {id: 'topic-a', alias: 'A'}],
    })
    await create({
      id: 'src-a2',
      references: [{id: 'target', alias: 'T'}, {id: 'topic-a', alias: 'A'}],
    })
    await create({
      id: 'src-b',
      references: [{id: 'target', alias: 'T'}, {id: 'topic-b', alias: 'B'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    }).load()

    expect(out.total).toBe(3)
    expect(out.groups.map(group => group.label)).toEqual(['Topic A', 'Other'])
    expect(sorted(out.groups[0].sourceIds)).toEqual(['src-a1', 'src-a2'])
    expect(out.groups[1]).toMatchObject({fallback: true})
    expect(out.groups[1].sourceIds).toEqual(['src-b'])
  })

  it('groups backlinks by references on ancestor blocks', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({id: 'parent', references: [{id: 'project', alias: 'Project'}]})
    await create({
      id: 'child-1',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({
      id: 'child-2',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    }).load()

    expect(out.groups.map(group => group.label)).toEqual(['Project'])
    expect(sorted(out.groups[0].sourceIds)).toEqual(['child-1', 'child-2'])
  })

  it('uses the containing root page as grouping context', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'page', content: 'Page'})
    await create({
      id: 'child-1',
      parentId: 'page',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({
      id: 'child-2',
      parentId: 'page',
      references: [{id: 'target', alias: 'T'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    }).load()

    expect(out.groups.map(group => group.label)).toEqual(['Page'])
    expect(sorted(out.groups[0].sourceIds)).toEqual(['child-1', 'child-2'])
  })

  it('applies include/remove filters before grouping', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({id: 'topic', content: 'Topic'})
    await create({id: 'done', content: 'DONE'})
    await create({
      id: 'src-1',
      references: [
        {id: 'target', alias: 'T'},
        {id: 'project', alias: 'Project'},
        {id: 'topic', alias: 'Topic'},
      ],
    })
    await create({
      id: 'src-2',
      references: [
        {id: 'target', alias: 'T'},
        {id: 'project', alias: 'Project'},
        {id: 'topic', alias: 'Topic'},
      ],
    })
    await create({
      id: 'src-done',
      references: [
        {id: 'target', alias: 'T'},
        {id: 'project', alias: 'Project'},
        {id: 'topic', alias: 'Topic'},
        {id: 'done', alias: 'DONE'},
      ],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {includeIds: ['project'], removeIds: ['done']},
    }).load()

    expect(out.total).toBe(2)
    expect(out.groups.map(group => group.label)).toEqual(['Project'])
    expect(sorted(out.groups[0].sourceIds)).toEqual(['src-1', 'src-2'])
  })

  it('re-resolves when an ancestor gains a grouping reference', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({id: 'parent'})
    await create({
      id: 'child-1',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({
      id: 'child-2',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })
    const handle = env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    })
    const fired: string[][] = []
    handle.subscribe((value) => {
      fired.push(value.groups.map(group => group.label))
    })
    await vi.waitFor(() => expect(fired).toEqual([['parent']]))

    await env.repo.tx(tx => tx.update('parent', {
      references: [{id: 'project', alias: 'Project'}],
    }), {scope: ChangeScope.BlockDefault})

    await vi.waitFor(() => {
      expect(fired).toEqual([['parent'], ['Project']])
    })
  })
})
