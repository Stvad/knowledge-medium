// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync, type AppExtension } from '@/extensions/facet.ts'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import {
  invalidationRulesFacet,
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  queriesFacet,
  valuePresetsFacet,
} from '@/data/facets.ts'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults.tsx'
import { backlinksForBlockQuery } from '@/plugins/backlinks/query.ts'
import { referencesInvalidationRule } from '@/plugins/references/invalidation.ts'
import { getUserPrefsBlock } from '@/data/globalState.ts'
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
import { initializeGroupedBacklinksPreferences } from '../preferences.ts'

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

  it('initializes grouped backlinks defaults on the user prefs block', async () => {
    await initializeGroupedBacklinksPreferences(env.repo, WS)
    const prefsBlock = await getUserPrefsBlock(env.repo, WS, env.repo.user)

    expect(prefsBlock.peekProperty(groupedBacklinksDefaultsProp)).toEqual(
      INITIAL_GROUPED_BACKLINKS_CONFIG,
    )
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
})
