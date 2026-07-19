// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, type BlockData } from '@/data/api'
import { Repo } from '@/data/repo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
  FIND_REPLACE_SEARCH_CONTENT_QUERY,
  findReplaceDataExtension,
} from '../dataExtension.ts'
import type {
  ApplyContentReplaceResult,
  ContentSearchResult,
} from '../types.ts'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [findReplaceDataExtension],
  })
  // Property-definition registry snapshots are built for the ACTIVE
  // workspace (repo.ts's FacetBridge wiring) — the codec-guard tests below
  // register a definition for WS via `setRuntimeContributions` and need it
  // actually resolvable through `tx.setProperty` / `resolvePropertyFieldSchema`.
  repo.setActiveWorkspaceId(WS)
  return {h: sharedDb, repo}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
// No afterEach observer teardown needed: createTestRepo leaves the Layout B
// sync observer off (this suite drives only local writes), so there is no
// db.onChange subscription to leak onto the shared DB.

const create = async (args: {
  id: string
  content?: string
  workspaceId?: string
}) => {
  await env.repo.tx(async tx => {
    await tx.create({
      id: args.id,
      workspaceId: args.workspaceId ?? WS,
      parentId: null,
      orderKey: `key-${args.id}`,
      content: args.content ?? '',
    })
  }, {scope: ChangeScope.BlockDefault})
}

const load = (id: string): Promise<BlockData | null> =>
  env.repo.load(id)

const search = (args: {
  query: string
  workspaceId?: string
  matchCase?: boolean
  wholeWord?: boolean
  maxBlocks?: number
}): Promise<ContentSearchResult> =>
  env.repo.runQuery(FIND_REPLACE_SEARCH_CONTENT_QUERY, {
    workspaceId: args.workspaceId ?? WS,
    query: args.query,
    options: {
      matchCase: args.matchCase ?? false,
      wholeWord: args.wholeWord ?? false,
    },
    maxBlocks: args.maxBlocks,
  })

describe('findReplaceDataExtension', () => {
  it('searches live block content in one workspace', async () => {
    await create({id: 'a', content: 'Alpha beta alpha'})
    await create({id: 'b', content: 'alpha in other workspace', workspaceId: OTHER_WS})
    await create({id: 'c', content: 'nothing'})
    await env.repo.tx(tx => tx.delete('c'), {scope: ChangeScope.BlockDefault})

    const out = await search({query: 'alpha'})

    expect(out.matches.map(match => ({
      id: match.blockId,
      count: match.matchCount,
      content: match.originalContent,
    }))).toEqual([
      {id: 'a', count: 2, content: 'Alpha beta alpha'},
    ])
  })

  it('honors case and whole-word options', async () => {
    await create({id: 'a', content: 'Alpha alpha ALPHA'})
    await create({id: 'b', content: 'Alpha ALPHA betabet'})

    expect((await search({query: 'alpha', matchCase: true})).matches)
      .toMatchObject([{blockId: 'a', matchCount: 1}])
    const wholeWord = await search({query: 'alpha', wholeWord: true})
    expect(wholeWord.matches.map(match => ({id: match.blockId, count: match.matchCount})))
      .toEqual([
        {id: 'b', count: 2},
        {id: 'a', count: 3},
      ])
  })

  it('reports when search results are capped', async () => {
    await create({id: 'a', content: 'alpha'})
    await create({id: 'b', content: 'alpha'})

    const out = await search({query: 'alpha', maxBlocks: 1})

    expect(out.matches).toHaveLength(1)
    expect(out.truncated).toBe(true)
  })

  it('applies replacements from preview snapshots', async () => {
    await create({id: 'a', content: 'Alpha alpha'})
    await create({id: 'b', content: 'alpha'})
    const preview = await search({query: 'alpha'})

    const result = await env.repo.run<ApplyContentReplaceResult>(
      FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
      {
        workspaceId: WS,
        find: 'alpha',
        replace: 'omega',
        options: {matchCase: false, wholeWord: false},
        items: preview.matches.map(match => ({
          blockId: match.blockId,
          originalContent: match.originalContent,
        })),
      },
    )

    expect(result).toEqual({
      updatedBlocks: 2,
      replacements: 3,
      skippedChangedBlocks: 0,
      skippedUnavailableBlocks: 0,
      skippedUnparseableProperty: 0,
      unparseableProperties: [],
      retryableSkips: [],
    })
    expect((await load('a'))?.content).toBe('omega omega')
    expect((await load('b'))?.content).toBe('omega')
  })

  it('skips rows that changed after preview', async () => {
    await create({id: 'a', content: 'alpha'})
    const preview = await search({query: 'alpha'})
    await env.repo.tx(tx => tx.update('a', {content: 'alpha user edit'}), {
      scope: ChangeScope.BlockDefault,
    })

    const result = await env.repo.run<ApplyContentReplaceResult>(
      FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
      {
        workspaceId: WS,
        find: 'alpha',
        replace: 'omega',
        options: {matchCase: false, wholeWord: false},
        items: preview.matches.map(match => ({
          blockId: match.blockId,
          originalContent: match.originalContent,
        })),
      },
    )

    expect(result).toEqual({
      updatedBlocks: 0,
      replacements: 0,
      skippedChangedBlocks: 1,
      skippedUnavailableBlocks: 0,
      skippedUnparseableProperty: 0,
      unparseableProperties: [],
      retryableSkips: [],
    })
    expect((await load('a'))?.content).toBe('alpha user edit')
  })

  // #404 item 5: `applyContentReplaceMutator` wrote straight to `content`
  // with no codec awareness. Under properties-as-blocks (PR #288 §9), a
  // property VALUE child's content IS its typed value — a replacement that
  // leaves it unparseable used to get written anyway, and PROJECT's
  // `firstProjectedFieldValue` would silently drop the property from the
  // owner's cell with no error surfaced to the user who ran the replace.
  describe('property-value codec guard', () => {
    const DEF = '55555555-5555-4555-8555-555555555555'
    const countSchema = defineProperty<number>('count', {
      codec: codecs.number,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })

    const registerDefinition = (): void => {
      env.repo.setRuntimeContributions(
        projectedPropertyDefinitionsFacet,
        'test-count-definition',
        [{
          metadata: {
            fieldId: DEF,
            workspaceId: WS,
            createdAt: 1,
            name: countSchema.name,
            changeScope: countSchema.changeScope,
            hidden: false,
            origin: 'user' as const,
          },
          schema: countSchema,
        }],
        {workspaceId: WS},
      )
    }

    /** Real dual-write machinery (`tx.setProperty`), not hand-built field/value
     *  rows — the flipped-workspace seeding pattern from
     *  `inlineDeletedBlockRefsProcessor.test.ts` / `propertyChildren.test.ts`. */
    const seedFlippedWorkspaceWithCountProperty = async (): Promise<{valueId: string}> => {
      await env.h.db.execute(
        `INSERT INTO workspaces
           (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
         VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
        [WS],
      )
      registerDefinition()
      await env.repo.tx(async tx => {
        await tx.create({
          id: DEF, workspaceId: WS, parentId: null, orderKey: 'a0',
          content: 'count', properties: {types: ['property-schema']},
        })
        await tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'owner'})
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.tx(tx => tx.setProperty('owner', countSchema, 42),
        {scope: ChangeScope.BlockDefault})

      const [field] = await env.h.db.getAll<{id: string}>(
        `SELECT id FROM blocks WHERE parent_id = 'owner' AND reference_target_id = ? AND deleted = 0`,
        [DEF],
      )
      const [value] = await env.h.db.getAll<{id: string}>(
        `SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0`,
        [field!.id],
      )
      return {valueId: value!.id}
    }

    // The skip is reported in the RESULT, not through the error channel: the
    // dialog that ran the replace consumes this object directly and renders
    // it, so there is nothing to route around. Throwing would also roll back
    // any valid replacements sharing the batch.
    it('skips the write and names the property when the only value would break its codec', async () => {
      const {valueId} = await seedFlippedWorkspaceWithCountProperty()

      const result = await env.repo.run<ApplyContentReplaceResult>(
        FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
        {
          workspaceId: WS,
          find: '42',
          replace: 'abc',
          options: {matchCase: false, wholeWord: false},
          items: [{blockId: valueId, originalContent: '42'}],
        },
      )

      expect(result).toEqual({
        updatedBlocks: 0,
        replacements: 0,
        skippedChangedBlocks: 0,
        skippedUnavailableBlocks: 0,
        skippedUnparseableProperty: 1,
        unparseableProperties: [countSchema.name],
        retryableSkips: [{blockId: valueId, originalContent: '42', property: countSchema.name}],
      })
      // Original valid content preserved — never overwritten with 'abc'.
      expect((await load(valueId))?.content).toBe('42')
      // The owning cell keeps the original, still-decodable value.
      const owner = await load('owner')
      expect(owner?.properties[countSchema.name]).toBe(42)
    })

    // `force: true` is the "replace anyway" re-run: the user accepted that the
    // property reads unset until the text is fixed. The write goes through, the
    // broken text lands, and the cell drops the now-undecodable key.
    it('writes the broken value on a forced re-run and drops the cell key', async () => {
      const {valueId} = await seedFlippedWorkspaceWithCountProperty()

      const result = await env.repo.run<ApplyContentReplaceResult>(
        FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
        {
          workspaceId: WS,
          find: '42',
          replace: 'abc',
          options: {matchCase: false, wholeWord: false},
          items: [{blockId: valueId, originalContent: '42'}],
          force: true,
        },
      )

      expect(result.updatedBlocks).toBe(1)
      expect(result.replacements).toBe(1)
      expect(result.skippedUnparseableProperty).toBe(0)
      expect(result.retryableSkips).toEqual([])
      // The broken text is written and visible in the value row...
      expect((await load(valueId))?.content).toBe('abc')
      // ...and the owner's cell no longer carries the (now-undecodable) key.
      expect((await load('owner'))?.properties[countSchema.name]).toBeUndefined()
    })

    // The valid replacement elsewhere in the same call must survive the skip.
    it('skips only the codec-breaking row in a mixed batch, keeping the valid replacement', async () => {
      const {valueId} = await seedFlippedWorkspaceWithCountProperty()
      await env.repo.tx(async tx => {
        await tx.create({id: 'plain', workspaceId: WS, parentId: null, orderKey: 'z0', content: '42 units'})
      }, {scope: ChangeScope.BlockDefault})

      const result = await env.repo.run<ApplyContentReplaceResult>(
        FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
        {
          workspaceId: WS,
          find: '42',
          replace: 'abc',
          options: {matchCase: false, wholeWord: false},
          items: [
            {blockId: 'plain', originalContent: '42 units'},
            {blockId: valueId, originalContent: '42'},
          ],
        },
      )
      expect(result).toEqual({
        updatedBlocks: 1,
        replacements: 1,
        skippedChangedBlocks: 0,
        skippedUnavailableBlocks: 0,
        skippedUnparseableProperty: 1,
        unparseableProperties: [countSchema.name],
        retryableSkips: [{blockId: valueId, originalContent: '42', property: countSchema.name}],
      })
      expect((await load('plain'))?.content).toBe('abc units')
      expect((await load(valueId))?.content).toBe('42')
      const owner = await load('owner')
      expect(owner?.properties[countSchema.name]).toBe(42)
    })

    // A field row is a NORMAL block — find-replace edits its content like any
    // other, NOT special-cased. Rewriting `((fieldId))` re-roles the property
    // deterministically (same as a direct edit or a move), so nothing is
    // skipped and nothing is held back for a forced re-run.
    it('edits a field row like a normal block, re-roling the property', async () => {
      await seedFlippedWorkspaceWithCountProperty()
      const [field] = await env.h.db.getAll<{id: string; content: string}>(
        `SELECT id, content FROM blocks WHERE parent_id = 'owner' AND reference_target_id = ? AND deleted = 0`,
        [DEF],
      )

      const result = await env.repo.run<ApplyContentReplaceResult>(
        FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
        {
          workspaceId: WS,
          find: DEF,
          replace: 'clobbered',
          options: {matchCase: false, wholeWord: false},
          items: [{blockId: field!.id, originalContent: field!.content}],
        },
      )

      // Written, not skipped — no special case, no retry offer.
      expect(result.updatedBlocks).toBe(1)
      expect(result.replacements).toBe(1)
      expect(result.skippedUnparseableProperty).toBe(0)
      expect(result.retryableSkips).toEqual([])
      // The field row's content changed like any block's would...
      expect((await load(field!.id))?.content).toBe('((clobbered))')
      // ...and the stamp follows the text (a `((id))` ref derives purely
      // textually, no existence check), so it now points at `clobbered` —
      // which is not a definition. The row is therefore no longer a
      // recognized field row, and the owner's cell re-roles: the count key
      // is gone. Same outcome as editing the row directly.
      expect((await load(field!.id))?.referenceTargetId).toBe('clobbered')
      expect((await load('owner'))?.properties[countSchema.name]).toBeUndefined()
    })

    // Dormancy: recognition is flip-gated like every other §9 primitive —
    // an un-flipped workspace has no property machinery to recognize, so a
    // value-shaped row is ordinary content and the replacement proceeds.
    it('is dormant in an un-flipped workspace', async () => {
      // `setProperty`'s dual-write is itself flip-gated and wouldn't create
      // field/value rows un-flipped, so build the shape by hand.
      await env.repo.tx(async tx => {
        await tx.create({id: 'owner2', workspaceId: WS, parentId: null, orderKey: 'b0', content: 'owner2'})
        await tx.create({id: 'field2', workspaceId: WS, parentId: 'owner2', orderKey: 'a0', content: `((${DEF}))`})
        await tx.create({id: 'value2', workspaceId: WS, parentId: 'field2', orderKey: 'a0', content: '42'})
      }, {scope: ChangeScope.BlockDefault})

      const result = await env.repo.run<ApplyContentReplaceResult>(
        FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR,
        {
          workspaceId: WS,
          find: '42',
          replace: 'abc',
          options: {matchCase: false, wholeWord: false},
          items: [{blockId: 'value2', originalContent: '42'}],
        },
      )

      expect(result).toEqual({
        updatedBlocks: 1,
        replacements: 1,
        skippedChangedBlocks: 0,
        skippedUnavailableBlocks: 0,
        skippedUnparseableProperty: 0,
        unparseableProperties: [],
        retryableSkips: [],
      })
      expect((await load('value2'))?.content).toBe('abc')
    })
  })
})
