// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import type { Dependency } from '@/data/internals/handleStore'
import { aliasesProp, typesProp } from '@/data/properties'
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
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'
import { backlinksPlugin } from '../index.ts'
import { backlinksDataExtension } from '../dataExtension.ts'
import { referencesInvalidationRule } from '@/plugins/references/invalidation.js'
import {
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksReferenceKey,
  typedBlocksStructureKey,
} from '@/data/internals/kernelInvalidation.js'
import {
  BACKLINKS_FOR_BLOCK_QUERY,
  backlinksForBlockQuery,
  mergeBacklinksFilters,
} from '../query.ts'
import { backlinksFilterProp } from '../filterProperty.ts'
import {
  dailyNoteBacklinksDefaultsProp,
  effectiveBacklinksFilterForBlock,
} from '../dailyNoteDefaults.ts'
import { dailyNoteBacklinksDefaultsUi } from '../propertyEditorOverride.ts'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

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

const asIds = (v: string[] | undefined): string[] => v ?? []

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

  it('contributes its backlink filter property schema', () => {
    const runtime = resolveFacetRuntimeSync(backlinksDataExtension)
    expect(runtime.read(propertySchemasFacet).get(backlinksFilterProp.name)).toBe(backlinksFilterProp)
    expect(runtime.read(propertySchemasFacet).get(dailyNoteBacklinksDefaultsProp.name))
      .toBe(dailyNoteBacklinksDefaultsProp)
  })

  it('contributes a custom property UI for daily note backlink defaults', () => {
    const runtime = resolveFacetRuntimeSync(backlinksPlugin)
    const schemas = runtime.read(propertySchemasFacet)
    const uis = runtime.read(propertyEditorOverridesFacet)

    expect(uis.get(dailyNoteBacklinksDefaultsProp.name)).toBe(dailyNoteBacklinksDefaultsUi)
    expect(resolvePropertyDisplay({
      name: dailyNoteBacklinksDefaultsProp.name,
      encodedValue: dailyNoteBacklinksDefaultsProp.defaultValue,
      schemas,
      uis,
      presets: runtime.read(valuePresetsFacet),
    }).Editor).toBe(dailyNoteBacklinksDefaultsUi.Editor)
  })

  it('merges default filters with page-local conflict overrides', () => {
    const projectRef = {scope: 'ancestor' as const, referencedBy: {id: 'project'}}
    const inboxRef = {scope: 'ancestor' as const, referencedBy: {id: 'inbox'}}
    const doneRef = {scope: 'ancestor' as const, referencedBy: {id: 'done'}}
    const somedayRef = {scope: 'ancestor' as const, referencedBy: {id: 'someday'}}
    const localRef = {scope: 'ancestor' as const, referencedBy: {id: 'local'}}

    expect(mergeBacklinksFilters(
      {include: [projectRef, inboxRef], exclude: [doneRef, somedayRef]},
      {include: [doneRef, localRef], exclude: [inboxRef]},
    )).toEqual({
      include: [doneRef, localRef, projectRef],
      exclude: [inboxRef, somedayRef],
    })
  })

  it('applies daily note defaults only to daily-note block data', () => {
    const dailyNoteData = {
      properties: {[typesProp.name]: typesProp.codec.encode([DAILY_NOTE_TYPE])},
    }
    const regularData = {properties: {}}
    const doneRef = {scope: 'ancestor' as const, referencedBy: {id: 'done'}}
    const projectRef = {scope: 'ancestor' as const, referencedBy: {id: 'project'}}
    const defaults = {exclude: [doneRef]}
    const local = {include: [projectRef]}

    expect(effectiveBacklinksFilterForBlock(dailyNoteData, local, defaults)).toEqual({
      include: [projectRef],
      exclude: [doneRef],
    })
    expect(effectiveBacklinksFilterForBlock(regularData, local, defaults)).toEqual({
      include: [projectRef],
      exclude: [],
    })
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
    const out = asIds(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(out.sort()).toEqual(['src1', 'src2'])
  })

  it('orders linked references by newest-created source first', async () => {
    await create({id: 'target'})
    await create({id: 'src-old', references: [{id: 'target', alias: 't'}]})
    await create({id: 'src-new', references: [{id: 'target', alias: 't'}]})
    await env.repo.tx(tx => tx.update('src-old', {content: 'edited later'}), {
      scope: ChangeScope.BlockDefault,
    })

    const out = asIds(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(out).toEqual(['src-new', 'src-old'])
  })

  it('excludes self-reference', async () => {
    await create({id: 'self', references: [{id: 'self', alias: 'self'}]})
    const out = asIds(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'self'}).load(),
    )
    expect(out).toEqual([])
  })

  it('excludes soft-deleted source rows', async () => {
    await create({id: 'target'})
    await create({id: 'src', references: [{id: 'target', alias: 't'}]})
    await env.repo.tx(tx => tx.delete('src'), {scope: ChangeScope.BlockDefault})
    const out = asIds(
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
    const wsOut = asIds(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(wsOut).toEqual([])

    const otherWs = asIds(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
        workspaceId: OTHER_WS,
        id: 'target',
      }).load(),
    )
    expect(otherWs).toEqual(['src-other'])
  })

  it('filters backlinks by direct references on the source block', async () => {
    await create({id: 'target'})
    await create({id: 'tag'})
    await create({
      id: 'src1',
      references: [{id: 'target', alias: 'T'}, {id: 'tag', alias: 'Tag'}],
    })
    await create({id: 'src2', references: [{id: 'target', alias: 'T'}]})

    const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {include: [{scope: 'self', referencedBy: {id: 'tag'}}]},
    }).load())

    expect(out).toEqual(['src1'])
  })

  it('keeps newest-created ordering when backlinks are filtered', async () => {
    await create({id: 'target'})
    await create({id: 'tag'})
    await create({
      id: 'src-old',
      references: [{id: 'target', alias: 'T'}, {id: 'tag', alias: 'Tag'}],
    })
    await create({
      id: 'src-new',
      references: [{id: 'target', alias: 'T'}, {id: 'tag', alias: 'Tag'}],
    })
    await env.repo.tx(tx => tx.update('src-old', {content: 'edited later'}), {
      scope: ChangeScope.BlockDefault,
    })

    const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {include: [{scope: 'ancestor', referencedBy: {id: 'tag'}}]},
    }).load())

    expect(out).toEqual(['src-new', 'src-old'])
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

    const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {include: [{scope: 'ancestor', referencedBy: {id: 'tag'}}]},
    }).load())

    expect(out).toEqual(['child'])
  })

  it('filters backlinks by their containing root page (ancestor id predicate)', async () => {
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

    const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {include: [{scope: 'ancestor', id: 'page-a'}]},
    }).load())

    expect(out).toEqual(['child-a'])
  })

  it('treats the containing page as a context tag for ancestor referencedBy', async () => {
    // Roam-style "page is a tag" semantic: filtering for context = X
    // should match blocks on the X page even when no ancestor sources
    // an outgoing reference to X. Pre-unification SQL UNIONed the root
    // ancestor's id into the context set; this exercises that behaviour
    // through the typed-query predicate compiler.
    await create({id: 'target'})
    await create({id: 'roam-memo'})
    await create({id: 'other-page'})
    await create({
      id: 'on-roam-memo',
      parentId: 'roam-memo',
      references: [{id: 'target', alias: 'T'}],
    })
    await create({
      id: 'elsewhere',
      parentId: 'other-page',
      references: [{id: 'target', alias: 'T'}],
    })

    const includeOut = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {include: [{scope: 'ancestor', referencedBy: {id: 'roam-memo'}}]},
    }).load())
    expect(includeOut).toEqual(['on-roam-memo'])

    const excludeOut = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {exclude: [{scope: 'ancestor', referencedBy: {id: 'roam-memo'}}]},
    }).load())
    expect(excludeOut).toEqual(['elsewhere'])
  })

  it('filters out backlinks that match remove references in source context', async () => {
    await create({id: 'target'})
    await create({id: 'done'})
    await create({id: 'keep', references: [{id: 'target', alias: 'T'}]})
    await create({
      id: 'skip',
      references: [{id: 'target', alias: 'T'}, {id: 'done', alias: 'DONE'}],
    })

    const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {exclude: [{scope: 'ancestor', referencedBy: {id: 'done'}}]},
    }).load())

    expect(out).toEqual(['keep'])
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

    const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({
      workspaceId: WS,
      id: 'target',
      filter: {
        include: [
          {scope: 'ancestor', referencedBy: {id: 'tag-a'}},
          {scope: 'ancestor', referencedBy: {id: 'tag-b'}},
        ],
      },
    }).load())

    expect(out).toEqual(['full'])
  })

  it('returns [] on empty workspaceId or id', async () => {
    await expect(
      env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: '', id: 'x'}).load(),
    ).resolves.toEqual([])
    await expect(
      env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: ''}).load(),
    ).resolves.toEqual([])
  })

  it('declares target row and typed-blocks reference channel without source row deps', async () => {
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

  it('filtered query declares structure deps for source context', async () => {
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
      filter: {include: [{scope: 'ancestor', referencedBy: {id: 'tag'}}]},
    })
    await handle.load()

    expect(handle.peek()).toEqual([])
    expect(depIds(handle.__depsForTest(), 'row')).toEqual([])
    expect(depIds(handle.__depsForTest(), 'plugin')).toEqual(expect.arrayContaining([
      `${TYPED_BLOCKS_STRUCTURE_CHANNEL}:${typedBlocksStructureKey(WS, 'target')}`,
      `${TYPED_BLOCKS_STRUCTURE_CHANNEL}:${typedBlocksStructureKey(WS, 'child')}`,
      `${TYPED_BLOCKS_STRUCTURE_CHANNEL}:${typedBlocksStructureKey(WS, 'parent')}`,
    ]))
  })

  it('re-resolves only when sources gain or lose references to the target', async () => {
    await create({id: 'target'})
    await create({id: 'other-target'})
    await create({id: 'unrelated'})
    await create({id: 'src'})
    const handle = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'})
    const fired: string[][] = []
    handle.subscribe((value) => { fired.push(value) })
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
    expect(handle.peek()).toEqual(['src'])

    await env.repo.tx(tx => tx.update('src', {content: 'edited, refs unchanged'}), {
      scope: ChangeScope.BlockDefault,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(fired.map(items => items.length)).toEqual([0, 1])

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
    const fired: string[][] = []
    handle.subscribe((value) => { fired.push(value) })
    await vi.waitFor(() => expect(fired.map(items => items.length)).toEqual([0]))

    // Bump updated_at so the sync snapshot wins the LWW gate at the
    // cache layer — real server-applied writes always carry a newer
    // updated_at than what the cache already has, and the rowEventsTail
    // only emits invalidations for sync rows the cache accepts.
    await env.h.db.execute(
      `UPDATE blocks SET references_json = ?, updated_at = updated_at + 1 WHERE id = ?`,
      [JSON.stringify([{id: 'target', alias: 'T'}]), 'src'],
    )
    await env.repo.flushRowEventsTail()

    await vi.waitFor(() => {
      expect(fired.map(items => items.length)).toEqual([0, 1])
    })
    expect(handle.peek()).toEqual(['src'])
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
      filter: {include: [{scope: 'ancestor', referencedBy: {id: 'tag'}}]},
    })
    const fired: string[][] = []
    handle.subscribe((value) => { fired.push(value) })
    await vi.waitFor(() => expect(fired.map(items => items.length)).toEqual([0]))

    await env.repo.tx(tx => tx.update('parent', {
      references: [{id: 'tag', alias: 'Tag'}],
    }), {scope: ChangeScope.BlockDefault})

    await vi.waitFor(() => {
      expect(fired.map(items => items.length)).toEqual([0, 1])
    })
    expect(handle.peek()).toEqual(['child'])
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

    const out = asIds(
      await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'}).load(),
    )
    expect(out).toEqual(['linker'])
  })
})
