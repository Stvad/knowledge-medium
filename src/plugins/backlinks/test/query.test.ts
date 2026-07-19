// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockReference } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import { Repo } from '@/data/repo'
import type { Dependency } from '@/data/internals/handleStore'
import { aliasesProp, typesProp } from '@/data/properties'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet.js'
import {
  invalidationRulesFacet,
  definitionSeedsFacet,
  propertyEditorOverridesFacet,
  queriesFacet,
} from '@/data/facets.js'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults.js'
import {readValuePresets} from '@/data/valuePresetRegistry'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'
import { backlinksPlugin } from '../index.ts'
import { backlinksDataExtension } from '../dataExtension.ts'
import { referencesInvalidationRule } from '@/plugins/references/invalidation.js'
import {
  TYPED_BLOCKS_REFERENCE_CHANNEL,
  TYPED_BLOCKS_STRUCTURE_CHANNEL,
  typedBlocksReferenceKey,
  typedBlocksStructureKey,
} from '@/data/invalidation'
import {
  BACKLINKS_FOR_BLOCK_QUERY,
  backlinksForBlockQuery,
  mergeBacklinksFilters,
  propertyMachinerySourceIds,
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
  // Shared DB opened once per file, reset between tests; fresh Repo per test.
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    startSyncObserver: true,
    extensions: [backlinksQueryInvalidationExtension],
  })
  return {h, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { env.repo.stopSyncObserver() })

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

  it('contributes its backlink filter property seeds', () => {
    const runtime = resolveFacetRuntimeSync(backlinksDataExtension)
    expect(runtime.read(definitionSeedsFacet)).toEqual(expect.arrayContaining([
      backlinksFilterProp,
      dailyNoteBacklinksDefaultsProp,
    ]))
  })

  it('contributes a custom property UI for daily note backlink defaults', () => {
    const runtime = resolveFacetRuntimeSync(backlinksPlugin)
    const schemas = new Map([[dailyNoteBacklinksDefaultsProp.name, dailyNoteBacklinksDefaultsProp]])
    const uis = runtime.read(propertyEditorOverridesFacet)

    expect(uis.get(dailyNoteBacklinksDefaultsProp.seedKey)).toBe(dailyNoteBacklinksDefaultsUi)
    expect(resolvePropertyDisplay({
      name: dailyNoteBacklinksDefaultsProp.name,
      encodedValue: dailyNoteBacklinksDefaultsProp.defaultValue,
      schemas,
      override: uis.get(dailyNoteBacklinksDefaultsProp.seedKey),
      presets: readValuePresets(runtime),
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

  describe('property-machinery source exclusion (#20)', () => {
    const FLIP_WS = 'ws-flip'
    const seedFlipped = async () => {
      await sharedDb.db.execute(
        `INSERT OR REPLACE INTO workspaces
           (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
         VALUES (?, 'flip ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
        [FLIP_WS],
      )
    }
    const createIn = (args: {
      id: string; parentId?: string | null; content?: string
      referenceTargetId?: string | null; references?: BlockReference[]
    }) =>
      env.repo.tx(tx => tx.create({
        id: args.id, workspaceId: FLIP_WS, parentId: args.parentId ?? null,
        orderKey: `k-${args.id}`, content: args.content ?? '',
        referenceTargetId: args.referenceTargetId, references: args.references ?? [],
      }), {scope: ChangeScope.BlockDefault})

    it('excludes a property VALUE source by default; rawSources returns it', async () => {
      await seedFlipped()
      // `D` is a recognized property definition; `F` is a field row stamped at
      // it; `V` is F's value child carrying a `[[Foo]]` reference (the hidden
      // machinery source); `Q` is an ordinary block referencing Foo.
      await createIn({id: 'D', content: 'status'})
      await sharedDb.db.execute(
        `INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES ('D', ?, 'property-schema')`,
        [FLIP_WS],
      )
      await createIn({id: 'Foo'})
      await createIn({id: 'O'})
      await createIn({id: 'F', parentId: 'O', content: '((D))', referenceTargetId: 'D'})
      await createIn({id: 'V', parentId: 'F', references: [{id: 'Foo', alias: 'Foo'}]})
      await createIn({id: 'Q', references: [{id: 'Foo', alias: 'Foo'}]})

      // Sanity: both sources are in the raw index.
      const raw = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY](
        {workspaceId: FLIP_WS, id: 'Foo', rawSources: true}).load())
      expect(raw.sort()).toEqual(['Q', 'V'])

      // Default view drops the hidden value-row source (the owning block's
      // cell reprojection is what carries this backlink, not `V`).
      const filtered = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY](
        {workspaceId: FLIP_WS, id: 'Foo'}).load())
      expect(filtered).toEqual(['Q'])
    })

    it('keeps a field row as a source for its OWN definition (the "used by" edge)', async () => {
      await seedFlipped()
      await createIn({id: 'D', content: 'status'})
      await sharedDb.db.execute(
        `INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES ('D', ?, 'property-schema')`,
        [FLIP_WS],
      )
      await createIn({id: 'O'})
      // The field row references its own definition — post-suppression-removal
      // this is the edge that answers "which blocks use property `status`?".
      await createIn({
        id: 'F', parentId: 'O', content: '((D))', referenceTargetId: 'D',
        references: [{id: 'D', alias: 'D'}],
      })
      // An INTERIOR row that also points at D is still machinery: its backlink
      // would duplicate the owner's reprojected edge and be sourced from a
      // hidden row.
      await createIn({id: 'V', parentId: 'F', references: [{id: 'D', alias: 'D'}]})

      const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY](
        {workspaceId: FLIP_WS, id: 'D'}).load())
      expect(out).toEqual(['F'])
    })

    it('unions machinery across chunk boundaries (SQLite variable-cap safety)', async () => {
      await seedFlipped()
      await createIn({id: 'D', content: 'status'})
      await sharedDb.db.execute(
        `INSERT OR IGNORE INTO block_types (block_id, workspace_id, type) VALUES ('D', ?, 'property-schema')`,
        [FLIP_WS],
      )
      await createIn({id: 'O'})
      await createIn({id: 'F', parentId: 'O', content: '((D))', referenceTargetId: 'D'})
      // Two value children (machinery) and one ordinary block; with chunkSize 1
      // each source is its own query, so a union bug would drop all but the last.
      await createIn({id: 'V1', parentId: 'F'})
      await createIn({id: 'V2', parentId: 'F'})
      await createIn({id: 'Q'})

      const machinery = await propertyMachinerySourceIds(
        env.h.db, ['V1', 'Q', 'V2'], 1,
      )
      expect([...machinery].sort()).toEqual(['V1', 'V2'])
    })

    it('converges (does not hang or error) when a source sits under a cyclic, non-matching ancestor chain (issue #404 item 8b)', async () => {
      await seedFlipped()
      // A 2-cycle (issue #183 shape) with no field row anywhere on it —
      // seeded via raw SQL, not tx.move, since tx.move's cycle-validation
      // would refuse to create this structurally. Such a cycle is exactly
      // what a pair of concurrent sync-applied moves can still produce; the
      // `up` walk under test must stay correct (and bounded) when it does.
      const cyclicPair = `
        INSERT INTO blocks
          (id, workspace_id, parent_id, order_key, content, properties_json,
           references_json, created_at, updated_at, created_by, updated_by, deleted)
        VALUES (?, ?, ?, 'a0', '', '{}', '[]', 0, 0, 'u', 'u', 0)
      `
      await sharedDb.db.execute(cyclicPair, ['cx', FLIP_WS, 'cy'])
      await sharedDb.db.execute(cyclicPair, ['cy', FLIP_WS, 'cx'])
      await createIn({id: 'under-cycle', parentId: 'cx'})

      const machinery = await propertyMachinerySourceIds(env.h.db, ['under-cycle'])
      expect(machinery.size).toBe(0)
    })

    it('does not filter in an un-flipped workspace (no machinery exists)', async () => {
      await create({id: 'Foo2', workspaceId: WS})
      await create({id: 'src', workspaceId: WS, references: [{id: 'Foo2', alias: 'Foo2'}]})
      const out = asIds(await env.repo.query[BACKLINKS_FOR_BLOCK_QUERY](
        {workspaceId: WS, id: 'Foo2'}).load())
      expect(out).toEqual(['src'])
    })
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

  it('treats containing ancestors as context tags for ancestor referencedBy', async () => {
    // Roam-style "page is a tag" semantic applies to the whole parent
    // chain: filtering for context = X should match blocks under X even
    // when X is an intermediate parent and no ancestor sources an
    // outgoing reference to X.
    await create({id: 'target'})
    await create({id: 'readwise-library'})
    await create({
      id: 'roam-memo',
      parentId: 'readwise-library',
    })
    await create({id: 'other-page'})
    await create({
      id: 'nested-hit',
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
    expect(includeOut).toEqual(['nested-hit'])

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
    await env.repo.flushSyncObserver()

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

  it('re-resolves from a sync-applied reference edit using the plugin invalidation rule', async () => {
    await create({id: 'target'})
    await create({id: 'src'})
    // Mark the baseline as fully synced (no pending upload), so the incoming
    // sync edit isn't held off by the local-edit-wins gate — the state of any
    // block old enough to be edited from another client.
    await env.h.db.execute('DELETE FROM ps_crud')

    const handle = env.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: WS, id: 'target'})
    const fired: string[][] = []
    handle.subscribe((value) => { fired.push(value) })
    await vi.waitFor(() => expect(fired.map(items => items.length)).toEqual([0]))

    // A concurrent client adds a reference src → target. It arrives via the
    // Layout B sync path: staged into blocks_synced, materialized by the
    // observer. A newer updated_at wins the LWW gate (real server writes do).
    await env.h.db.execute(BLOCKS_SYNCED_RAW_TABLE.put.sql, blockToSyncedRowParams({
      id: 'src', workspaceId: WS, parentId: null, orderKey: 'key-src',
      content: '', properties: {}, references: [{id: 'target', alias: 'T'}],
      createdAt: 0, updatedAt: 9_000_000_000_000, userUpdatedAt: 9_000_000_000_000, createdBy: 'remote', updatedBy: 'remote', deleted: false,
    }))
    await env.repo.flushSyncObserver()

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
