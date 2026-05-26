// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync, type AppExtension } from '@/extensions/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import {
  invalidationRulesFacet,
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  queriesFacet,
  valuePresetsFacet,
} from '@/data/facets.js'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults.js'
import { backlinksForBlockQuery } from '@/plugins/backlinks/query.js'
import { referencesInvalidationRule } from '@/plugins/references/invalidation.js'
import {
  GROUPED_BACKLINKS_FOR_BLOCK_QUERY,
} from '../query.ts'
import { groupedBacklinksPlugin } from '../index.ts'
import { groupedBacklinksDataExtension } from '../dataExtension.ts'
import { groupedBacklinksDefaultsUi } from '../propertyEditorOverride.ts'
import {
  groupedBacklinksDefaultsProp,
  groupedBacklinksOverridesProp,
  INITIAL_GROUPED_BACKLINKS_CONFIG,
  mergeGroupedBacklinksConfig,
} from '../config.ts'

const WS = 'ws-1'

const backlinksQueryInvalidationExtension: AppExtension = [
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  invalidationRulesFacet.of(referencesInvalidationRule, {source: 'references'}),
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

  it('contributes grouped backlinks property schemas', () => {
    const runtime = resolveFacetRuntimeSync(groupedBacklinksDataExtension)
    const schemas = runtime.read(propertySchemasFacet)

    expect(schemas.get(groupedBacklinksDefaultsProp.name)).toBe(groupedBacklinksDefaultsProp)
    expect(schemas.get(groupedBacklinksOverridesProp.name)).toBe(groupedBacklinksOverridesProp)
    expect(groupedBacklinksDefaultsProp.defaultValue).toEqual(INITIAL_GROUPED_BACKLINKS_CONFIG)
  })

  it('contributes a custom property UI for grouped backlinks defaults', () => {
    const runtime = resolveFacetRuntimeSync(groupedBacklinksPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    const uis = runtime.read(propertyEditorOverridesFacet)

    expect(uis.get(groupedBacklinksDefaultsProp.name)).toBe(groupedBacklinksDefaultsUi)
    expect(resolvePropertyDisplay({
      name: groupedBacklinksDefaultsProp.name,
      encodedValue: INITIAL_GROUPED_BACKLINKS_CONFIG,
      schemas,
      uis,
      presets: runtime.read(valuePresetsFacet),
    }).Editor).toBe(groupedBacklinksDefaultsUi.Editor)
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

  it('groups incoming property references by source field even for a singleton source', async () => {
    await create({id: 'target', content: 'Target'})
    await create({
      id: 'src',
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    }).load()

    expect(out.total).toBe(1)
    expect(out.groups).toEqual([{
      groupId: 'field:reviewer',
      label: 'reviewer',
      sourceIds: ['src'],
      fallback: false,
    }])
  })

  it('orders source-field groups by normal priority while keeping singleton groups', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({
      id: 'src-field',
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    })
    await create({
      id: 'src-project-1',
      references: [{id: 'target', alias: 'T'}, {id: 'project', alias: 'Project'}],
    })
    await create({
      id: 'src-project-2',
      references: [{id: 'target', alias: 'T'}, {id: 'project', alias: 'Project'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    }).load()

    expect(out.groups.map(group => group.label)).toEqual(['Project', 'reviewer'])
    expect(out.groups.find(group => group.label === 'reviewer')).toEqual({
      groupId: 'field:reviewer',
      label: 'reviewer',
      sourceIds: ['src-field'],
      fallback: false,
    })
  })

  it('keeps two source fields from the same source to the same target distinct', async () => {
    await create({id: 'target', content: 'Target'})
    await create({
      id: 'src',
      references: [
        {id: 'target', alias: 'target', sourceField: 'reviewer'},
        {id: 'target', alias: 'target', sourceField: 'blocked-by'},
      ],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    }).load()

    expect(out.total).toBe(1)
    expect(out.groups.map(group => group.label)).toEqual(['blocked-by', 'reviewer'])
    expect(out.groups.map(group => group.sourceIds)).toEqual([['src'], ['src']])
  })

  it('does not inherit source-field groups from ancestor property references', async () => {
    await create({id: 'target', content: 'Target'})
    await create({
      id: 'parent',
      content: 'Parent',
      references: [{id: 'target', alias: 'target', sourceField: 'reviewer'}],
    })
    await create({
      id: 'child',
      parentId: 'parent',
      references: [{id: 'target', alias: 'T'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    }).load()

    expect(out.total).toBe(2)
    expect(out.groups).toEqual([
      {
        groupId: 'field:reviewer',
        label: 'reviewer',
        sourceIds: ['parent'],
        fallback: false,
      },
      {
        groupId: '__grouped_backlinks_other__',
        label: 'Other',
        sourceIds: ['child'],
        fallback: true,
      },
    ])
  })

  it('applies include/remove filters before grouping and honors high priority config', async () => {
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
      filter: {
        include: [{scope: 'ancestor', referencedBy: {id: 'project'}}],
        exclude: [{scope: 'ancestor', referencedBy: {id: 'done'}}],
      },
      groupingConfig: {
        highPriorityTags: ['Project'],
        lowPriorityTags: [],
        excludedTags: [],
        excludedPatterns: [],
      },
    }).load()

    expect(out.total).toBe(2)
    expect(out.groups.map(group => group.label)).toEqual(['Project'])
    expect(sorted(out.groups[0].sourceIds)).toEqual(['src-1', 'src-2'])
  })

  it('returns a coherent render snapshot with unfiltered sources and parents for grouped sources', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({id: 'done', content: 'DONE'})
    await create({id: 'page', content: 'Page'})
    await create({id: 'section', parentId: 'page', content: 'Section'})
    await create({
      id: 'visible',
      parentId: 'section',
      references: [{id: 'target', alias: 'T'}, {id: 'project', alias: 'Project'}],
    })
    await create({
      id: 'hidden',
      references: [{id: 'target', alias: 'T'}, {id: 'done', alias: 'DONE'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {
        exclude: [{scope: 'ancestor', referencedBy: {id: 'done'}}],
      },
      groupingConfig: {
        highPriorityTags: ['Project'],
        lowPriorityTags: [],
        excludedTags: [],
        excludedPatterns: [],
      },
    }).load()

    expect(out.total).toBe(1)
    expect(sorted(out.unfilteredSourceIds)).toEqual(['hidden', 'visible'])
    expect(out.groups.map(group => group.sourceIds)).toEqual([['visible']])
    expect(out.sourceParents).toEqual([{
      sourceId: 'visible',
      parentIds: ['page', 'section'],
    }])
  })

  it('surfaces singleton high-priority groups at the top instead of folding them into Other', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({id: 'topic', content: 'Topic'})
    await create({
      id: 'src-solo',
      references: [{id: 'target', alias: 'T'}, {id: 'project', alias: 'Project'}],
    })
    await create({
      id: 'src-topic-1',
      references: [{id: 'target', alias: 'T'}, {id: 'topic', alias: 'Topic'}],
    })
    await create({
      id: 'src-topic-2',
      references: [{id: 'target', alias: 'T'}, {id: 'topic', alias: 'Topic'}],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      groupingConfig: {
        highPriorityTags: ['Project'],
        lowPriorityTags: [],
        excludedTags: [],
        excludedPatterns: [],
      },
    }).load()

    expect(out.total).toBe(3)
    expect(out.groups.map(group => group.label)).toEqual(['Project', 'Topic'])
    expect(out.groups[0].sourceIds).toEqual(['src-solo'])
    expect(sorted(out.groups[1].sourceIds)).toEqual(['src-topic-1', 'src-topic-2'])
  })

  it('does not treat include filters as grouping priority', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({id: 'topic', content: 'Topic'})
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

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {
        include: [{scope: 'ancestor', referencedBy: {id: 'project'}}],
      },
    }).load()

    expect(out.groups.map(group => group.label)).toEqual(['Topic'])
  })

  it('uses grouped backlink config for low priority and exclusions', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({id: 'task', content: 'task'})
    await create({id: 'done', content: 'DONE'})
    await create({
      id: 'src-1',
      references: [
        {id: 'target', alias: 'T'},
        {id: 'project', alias: 'Project'},
        {id: 'task', alias: 'task'},
        {id: 'done', alias: 'DONE'},
      ],
    })
    await create({
      id: 'src-2',
      references: [
        {id: 'target', alias: 'T'},
        {id: 'project', alias: 'Project'},
        {id: 'task', alias: 'task'},
        {id: 'done', alias: 'DONE'},
      ],
    })

    const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      groupingConfig: {
        highPriorityTags: [],
        lowPriorityTags: ['task'],
        excludedTags: ['DONE'],
        excludedPatterns: [],
      },
    }).load()

    expect(out.groups.map(group => group.label)).toEqual(['Project'])
  })

  it('merges local overrides over workspace defaults per field', () => {
    const merged = mergeGroupedBacklinksConfig(
      {
        highPriorityTags: ['Workspace High'],
        lowPriorityTags: ['Workspace Low'],
        excludedTags: ['Workspace Hidden'],
        excludedPatterns: ['^workspace$'],
      },
      {
        highPriorityTags: ['Local High'],
        excludedPatterns: [],
      },
    )

    expect(merged).toEqual({
      highPriorityTags: ['Local High'],
      lowPriorityTags: ['Workspace Low'],
      excludedTags: ['Workspace Hidden'],
      excludedPatterns: [],
    })
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

  it('does not re-resolve when a backlink source content changes without reference changes', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'project', content: 'Project'})
    await create({
      id: 'src-1',
      references: [{id: 'target', alias: 'T'}, {id: 'project', alias: 'Project'}],
    })
    await create({
      id: 'src-2',
      references: [{id: 'target', alias: 'T'}, {id: 'project', alias: 'Project'}],
    })

    const handle = env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    })
    const fired: string[][] = []
    handle.subscribe((value) => {
      fired.push(value.groups.map(group => group.label))
    })
    await vi.waitFor(() => expect(fired).toEqual([['Project']]))

    await env.repo.tx(
      tx => tx.update('src-1', {content: 'source content edited'}),
      {scope: ChangeScope.BlockDefault},
    )
    await new Promise(r => setTimeout(r, 30))
    expect(fired).toEqual([['Project']])
  })

  it('re-resolves when a source moves to a different root grouping context', async () => {
    await create({id: 'target', content: 'Target'})
    await create({id: 'page-a', content: 'Page A'})
    await create({id: 'page-b', content: 'Page B'})
    await create({
      id: 'src-1',
      parentId: 'page-a',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({
      id: 'src-2',
      parentId: 'page-a',
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
    await vi.waitFor(() => expect(fired).toEqual([['Page A']]))

    await env.repo.tx(
      tx => tx.move('src-1', {parentId: 'page-b', orderKey: 'key-src-1-moved'}),
      {scope: ChangeScope.BlockDefault},
    )

    await vi.waitFor(() => {
      expect(fired[fired.length - 1]).toEqual(['Other'])
    })
  })

  it('re-resolves when an intermediate (non-root, non-group) ancestor gains a reference', async () => {
    // Three-level chain: root → mid (intermediate) → src1/src2.
    // mid is neither the root (so not emitted as a 'root' group)
    // nor does it have refs initially (so not a 'ref' group).
    // Two sources share the same chain so 'Tag' is a multi-source
    // group when mid gains the ref — avoids the singleton→Other merge
    // that would obscure the invalidation signal.
    await create({id: 'target', content: 'Target'})
    await create({id: 'tag', content: 'Tag'})
    await create({id: 'root'})
    await create({id: 'mid', parentId: 'root'})
    await create({
      id: 'src1',
      parentId: 'mid',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({
      id: 'src2',
      parentId: 'mid',
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
    await vi.waitFor(() => expect(fired.length).toBeGreaterThan(0))
    const initialGroups = fired[fired.length - 1]
    expect(initialGroups).not.toContain('Tag')

    await env.repo.tx(tx => tx.update('mid', {
      references: [{id: 'tag', alias: 'Tag'}],
    }), {scope: ChangeScope.BlockDefault})

    await vi.waitFor(() => {
      // 'Tag' is now in mid's refs and applies to both sources → appears as a group.
      expect(fired[fired.length - 1]).toContain('Tag')
    })
  })

  it('re-resolves when a new source gains a reference to the target', async () => {
    // Verifies the typed-blocks reference channel dep is registered
    // on THIS handle, not lost in a sub-query call. A fresh block
    // that didn't exist at resolve time must wake the handle when it
    // adds a ref to the target.
    await create({id: 'target', content: 'Target'})
    await create({id: 'tag', content: 'Tag'})
    await create({id: 'orphan', references: [{id: 'tag', alias: 'Tag'}]})

    const handle = env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
    })
    const fired: number[] = []
    handle.subscribe((value) => { fired.push(value.total) })
    await vi.waitFor(() => expect(fired).toEqual([0]))

    await env.repo.tx(tx => tx.update('orphan', {
      references: [
        {id: 'target', alias: 'T'},
        {id: 'tag', alias: 'Tag'},
      ],
    }), {scope: ChangeScope.BlockDefault})

    await vi.waitFor(() => {
      expect(fired[fired.length - 1]).toBe(1)
    })
  })

  // groupWith expansion: when a context block C declares `groupWith:: [[X]]`,
  // any backlink whose context chain includes C also gets X as a group
  // candidate. Mirrors roam-date's `addAttributeGroups`
  // (linked-reference-groups/datalog-groups.ts). The realistic use case is
  // *multiple* declaring blocks pointing to a common umbrella group — the
  // umbrella accumulates more members than any individual declarer and wins
  // the consume-largest pass.
  describe('groupWith expansion', () => {
    const setupUmbrella = async () => {
      // taxes, investments, banking → groupWith finance.
      // Three backlinks each reference a different declaring block, so
      // taxes/investments/banking are each size 1 (below minGroupSize), and
      // Finance accumulates all three into a size-3 group.
      await create({id: 'target', content: 'Target'})
      await create({id: 'finance', content: 'Finance'})
      for (const id of ['taxes', 'investments', 'banking']) {
        const label = id[0].toUpperCase() + id.slice(1)
        await create({
          id,
          content: label,
          references: [{id: 'finance', alias: 'Finance', sourceField: 'groupWith'}],
        })
      }
      await create({
        id: 'src-taxes',
        references: [{id: 'target', alias: 'T'}, {id: 'taxes', alias: 'Taxes'}],
      })
      await create({
        id: 'src-investments',
        references: [{id: 'target', alias: 'T'}, {id: 'investments', alias: 'Investments'}],
      })
      await create({
        id: 'src-banking',
        references: [{id: 'target', alias: 'T'}, {id: 'banking', alias: 'Banking'}],
      })
    }

    it('surfaces an umbrella group when multiple declaring blocks share a groupWith target', async () => {
      await setupUmbrella()

      const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
        workspaceId: WS,
        id: 'target',
      }).load()

      const financeGroup = out.groups.find(group => group.label === 'Finance')
      expect(financeGroup).toBeDefined()
      expect(sorted(financeGroup!.sourceIds))
        .toEqual(['src-banking', 'src-investments', 'src-taxes'])
    })

    it('expands groupWith when the declaring block is reached via an ancestor', async () => {
      await create({id: 'target', content: 'Target'})
      await create({id: 'finance', content: 'Finance'})
      for (const id of ['taxes', 'investments']) {
        const label = id[0].toUpperCase() + id.slice(1)
        await create({
          id,
          content: label,
          references: [{id: 'finance', alias: 'Finance', sourceField: 'groupWith'}],
        })
      }
      await create({id: 'parent-taxes', references: [{id: 'taxes', alias: 'Taxes'}]})
      await create({id: 'parent-investments', references: [{id: 'investments', alias: 'Investments'}]})
      await create({
        id: 'child-taxes',
        parentId: 'parent-taxes',
        references: [{id: 'target', alias: 'T'}],
      })
      await create({
        id: 'child-investments',
        parentId: 'parent-investments',
        references: [{id: 'target', alias: 'T'}],
      })

      const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
        workspaceId: WS,
        id: 'target',
      }).load()

      const financeGroup = out.groups.find(group => group.label === 'Finance')
      expect(financeGroup).toBeDefined()
      expect(sorted(financeGroup!.sourceIds)).toEqual(['child-investments', 'child-taxes'])
    })

    it('does not chain groupWith transitively', async () => {
      // taxes/investments/banking → finance → money. Backlinks reach
      // Finance via the one-hop expansion but should NOT reach Money.
      await create({id: 'target', content: 'Target'})
      await create({id: 'money', content: 'Money'})
      await create({
        id: 'finance',
        content: 'Finance',
        references: [{id: 'money', alias: 'Money', sourceField: 'groupWith'}],
      })
      for (const id of ['taxes', 'investments', 'banking']) {
        const label = id[0].toUpperCase() + id.slice(1)
        await create({
          id,
          content: label,
          references: [{id: 'finance', alias: 'Finance', sourceField: 'groupWith'}],
        })
      }
      await create({
        id: 'src-taxes',
        references: [{id: 'target', alias: 'T'}, {id: 'taxes', alias: 'Taxes'}],
      })
      await create({
        id: 'src-investments',
        references: [{id: 'target', alias: 'T'}, {id: 'investments', alias: 'Investments'}],
      })
      await create({
        id: 'src-banking',
        references: [{id: 'target', alias: 'T'}, {id: 'banking', alias: 'Banking'}],
      })

      const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
        workspaceId: WS,
        id: 'target',
      }).load()

      const labels = out.groups.map(group => group.label)
      expect(labels).toContain('Finance')
      expect(labels).not.toContain('Money')
    })

    it('respects excludedTags when expanding groupWith', async () => {
      await setupUmbrella()

      const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
        workspaceId: WS,
        id: 'target',
        groupingConfig: {
          highPriorityTags: [],
          lowPriorityTags: [],
          excludedTags: ['Finance'],
          excludedPatterns: [],
        },
      }).load()

      expect(out.groups.map(group => group.label)).not.toContain('Finance')
    })

    it('does not emit the target block itself as a groupWith group', async () => {
      // Edge case: taxes declares groupWith:: target. We're viewing target's
      // backlinks, so target must not appear as one of its own groups.
      await create({id: 'target', content: 'Target'})
      await create({
        id: 'taxes',
        content: 'Taxes',
        references: [{id: 'target', alias: 'Target', sourceField: 'groupWith'}],
      })
      await create({
        id: 'src-1',
        references: [{id: 'target', alias: 'T'}, {id: 'taxes', alias: 'Taxes'}],
      })

      const out = await env.repo.query[GROUPED_BACKLINKS_FOR_BLOCK_QUERY]({
        workspaceId: WS,
        id: 'target',
      }).load()

      expect(out.groups.map(group => group.groupId)).not.toContain('target')
    })
  })
})
