// @vitest-environment node
/**
 * Same-tx inlining of a deleted block's content into the blocks that
 * referenced it — exercised end-to-end through the `core.delete` mutator.
 * Deleting a block rewrites every `((id))` / `!((id))` / `[label](((id)))`
 * mark in other blocks to the text it displayed and drops the now-stale
 * block-ref entry from their `references`, atomically with the delete.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, normalizeReferences, type BlockData } from '@/data/api'
import { Repo } from '@/data/repo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { aliasesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { referencesDataExtension } from '../dataExtension.ts'

const WS = 'ws-1'

// `((id))` only parses as a block-ref when `id` is UUID-shaped, so the
// deleted blocks use real UUIDs; referrers/parents can use short ids.
const D = '11111111-1111-4111-8111-111111111111'
const C = '22222222-2222-4222-8222-222222222222'
const OTHER = '33333333-3333-4333-8333-333333333333'

interface Harness {
  h: TestDb
  repo: Repo
  read(id: string): BlockData | undefined
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo, cache } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [referencesDataExtension, aliasDataExtension],
  })
  // Undo/redo are scoped to the active workspace (issue #186).
  repo.setActiveWorkspaceId(WS)
  return {
    h,
    repo,
    read: id => cache.getSnapshot(id),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const aliasProperty = (aliases: readonly string[]) => ({
  [aliasesProp.name]: aliasesProp.codec.encode([...aliases]),
})

describe('references.inlineDeletedBlockReferences', () => {
  it('inlines a deleted block\'s content into a referrer and drops the block-ref', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'deleted body'})
      await tx.create({
        id: 's', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `before ((${D})) after`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read(D)!.deleted).toBe(true)
    expect(env.read('s')!.content).toBe('before deleted body after')
    expect(env.read('s')!.references).toEqual([])
  })

  // Regression (PR #386 review): `core.deriveReferenceTarget` runs earlier
  // in the same-tx processor pass and stamps `referenceTargetId` from the
  // PRE-inline content. Without recomputing it here, a whole-block
  // `((deletedId))` row would keep `referenceTargetId: deletedId` even
  // though its content is now plain inlined text.
  it('recomputes referenceTargetId when inlining rewrites a whole-block reference', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'deleted body'})
      await tx.create({
        id: 's', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `((${D}))`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    expect(env.read('s')!.referenceTargetId).toBe(D)

    await env.repo.mutate.delete({id: D})

    expect(env.read('s')!.content).toBe('deleted body')
    expect(env.read('s')!.referenceTargetId).toBeNull()
  })

  it('inlines plain and embed marks as content but keeps an aliased mark\'s label', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'BODY'})
      await tx.create({
        id: 's', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `ref ((${D})) embed !((${D})) alias [label](((${D})))`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read('s')!.content).toBe('ref BODY embed BODY alias label')
    expect(env.read('s')!.references).toEqual([])
  })

  it('only rewrites refs to the deleted block — wikilink and other block refs survive', async () => {
    await env.repo.tx(async tx => {
      // D carries the alias `Page`, so parse resolves `[[Page]]` to D
      // (a wikilink ref, alias !== id) alongside the `((D))` block ref.
      await tx.create({
        id: D, workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'DBODY', properties: aliasProperty(['Page']),
      })
      await tx.create({id: OTHER, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'other'})
      await tx.create({
        id: 's', workspaceId: WS, parentId: null, orderKey: 'a2',
        content: `[[Page]] ((${D})) and ((${OTHER}))`,
        references: [
          {id: D, alias: 'Page'},
          {id: D, alias: D},
          {id: OTHER, alias: OTHER},
        ],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    // `((D))` inlined; `[[Page]]` (wikilink to D) and `((OTHER))` untouched.
    expect(env.read('s')!.content).toBe(`[[Page]] DBODY and ((${OTHER}))`)
    expect(env.read('s')!.references).toEqual(normalizeReferences([
      {id: D, alias: 'Page'},
      {id: OTHER, alias: OTHER},
    ]))
  })

  it('inlines an embed of a block-with-children as the root content only, not the subtree', async () => {
    // Decision: `!((id))` renders the whole subtree, but on delete we inline
    // only the deleted block's own content line — the subtree is deleted too,
    // and dumping its flat text into the referrer is not what we want.
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'ROOT'})
      await tx.create({id: C, workspaceId: WS, parentId: D, orderKey: 'a0', content: 'CHILD'})
      await tx.create({
        id: 'x', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `embed !((${D}))`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read('x')!.content).toBe('embed ROOT')
    expect(env.read('x')!.references).toEqual([])
  })

  it('inlines refs to every block in a deleted subtree (parent and child)', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'PARENT'})
      await tx.create({id: C, workspaceId: WS, parentId: D, orderKey: 'a0', content: 'CHILD'})
      await tx.create({
        id: 'x', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `((${D})) | ((${C}))`,
        references: [{id: D, alias: D}, {id: C, alias: C}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read(D)!.deleted).toBe(true)
    expect(env.read(C)!.deleted).toBe(true)
    expect(env.read('x')!.content).toBe('PARENT | CHILD')
    expect(env.read('x')!.references).toEqual([])
  })

  it('does not inline into a referrer that is itself being deleted in the subtree', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'PARENT'})
      await tx.create({
        id: 'c', workspaceId: WS, parentId: D, orderKey: 'a0',
        content: `child sees ((${D}))`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    // The dying child is left as-is: inlining into a tombstone is pointless,
    // and the staged-state guard skips it.
    expect(env.read('c')!.deleted).toBe(true)
    expect(env.read('c')!.content).toBe(`child sees ((${D}))`)
    expect(env.read('c')!.references).toEqual([{id: D, alias: D}])
  })

  it('resolves nested refs between deleted blocks — no fresh dangling ref is created', async () => {
    // P's own content references C; both are deleted together (subtree).
    // The external referrer x must end up with C's content inlined too, NOT
    // a literal `((C))` mark that post-commit parse would turn into a new
    // dangling reference.
    await env.repo.tx(async tx => {
      await tx.create({
        id: D, workspaceId: WS, parentId: null, orderKey: 'a0',
        content: `parent refs ((${C}))`,
      })
      await tx.create({id: C, workspaceId: WS, parentId: D, orderKey: 'a0', content: 'child body'})
      await tx.create({
        id: 'x', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `see ((${D}))`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read('x')!.content).toBe('see parent refs child body')
    expect(env.read('x')!.references).toEqual([])
  })

  it('inlines an empty deleted block to empty text (the ref resolves to nothing)', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
      await tx.create({
        id: 's', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `before ((${D})) after`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read('s')!.content).toBe('before  after')
    expect(env.read('s')!.references).toEqual([])
  })

  it('inline rides on the delete\'s undo step — undo restores referrer and target together', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'BODY'})
      await tx.create({
        id: 's', workspaceId: WS, parentId: null, orderKey: 'a1',
        content: `pre ((${D})) post`,
        references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})
    expect(env.read('s')!.content).toBe('pre BODY post')
    expect(env.read('s')!.references).toEqual([])

    await env.repo.undo(ChangeScope.BlockDefault)
    expect(env.read(D)!.deleted).toBe(false)
    expect(env.read('s')!.content).toBe(`pre ((${D})) post`)
    expect(env.read('s')!.references).toEqual([{id: D, alias: D}])
  })
})

/**
 * #404 item 4 / PR #288 §9: a ref-typed property VALUE is `((targetId))`.
 * Inlining it would rewrite the value into prose, clear its derived column,
 * and silently drop the property key at the next projection — irreversibly,
 * since the id is gone. Cell-era semantics were the opposite: a deleted
 * target left a dangling reference with the property RETAINED. Soft-delete
 * makes dangling recoverable (restore the target and the property snaps
 * back), so the value keeps identity and inlining skips it.
 */
describe('property value children keep a dangling ref instead of inlining (#404)', () => {
  const DEF = '44444444-4444-4444-8444-444444444444'

  const relatedSchema = defineProperty('related', {
    codec: codecs.ref(),
    defaultValue: null,
    changeScope: ChangeScope.BlockDefault,
  })

  /** Recognition has two halves: the tx-layer registry (`resolveField`) and
   *  the SQL `block_types` probe. Seed both — the definition block carries
   *  the type, the runtime contribution makes the fieldId resolvable. */
  const registerDefinition = (): void => {
    env.repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-related-definition',
      [{
        metadata: {
          fieldId: DEF,
          workspaceId: WS,
          createdAt: 1,
          name: relatedSchema.name,
          changeScope: relatedSchema.changeScope,
          hidden: false,
          origin: 'user' as const,
        },
        schema: relatedSchema,
      }],
      {workspaceId: WS},
    )
  }

  const seedFlippedWorkspaceWithRefValue = async (): Promise<void> => {
    await env.h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
      [WS],
    )
    registerDefinition()
    await env.repo.tx(async tx => {
      // Definition block — `block_types` (written by typeify) is what the
      // recognition predicate binds definition-ness to.
      await tx.create({
        id: DEF, workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'related', properties: {types: ['property-schema']},
      })
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'target body'})
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'owner'})
      await tx.create({
        id: 'field', workspaceId: WS, parentId: 'p', orderKey: 'a1',
        content: `::((${DEF}))`,
      })
      await tx.create({
        id: 'value', workspaceId: WS, parentId: 'field', orderKey: 'a1',
        content: `((${D}))`, references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()
  }

  it('leaves the value row pointing at the tombstone, column intact', async () => {
    await seedFlippedWorkspaceWithRefValue()
    expect(env.read('value')!.referenceTargetId).toBe(D)

    await env.repo.mutate.delete({id: D})

    expect(env.read(D)!.deleted).toBe(true)
    expect(env.read('value')!.content).toBe(`((${D}))`)
    expect(env.read('value')!.referenceTargetId).toBe(D)
    expect(env.read('value')!.references).toEqual([{id: D, alias: D}])
  })


  // Deleting the DEFINITION block, not the ref target: every field row keyed
  // to it is an ordinary reference source, so without an exemption they get
  // inlined — content replaced by the definition's text, stamp cleared — and
  // each owner loses its property identity irreversibly. Same argument as the
  // value case: a dangling `::((fieldId))` is restorable (restore the definition
  // and the property comes back), inlined prose is not. §9 already has a home
  // for the interim state: a field row whose definition doesn't resolve
  // degrades to a visible "unknown field" row.
  it('leaves field rows dangling when their definition block is deleted', async () => {
    await seedFlippedWorkspaceWithRefValue()

    await env.repo.mutate.delete({id: DEF})

    expect(env.read(DEF)!.deleted).toBe(true)
    expect(env.read('field')!.content).toBe(`::((${DEF}))`)
    expect(env.read('field')!.referenceTargetId).toBe(DEF)
  })

  // The exemption is for VALUES, not for everything under a property: a
  // comment beneath a value row is ordinary prose and still inlines, exactly
  // as it would anywhere else in the outline.
  it('still inlines ordinary content nested under a value row', async () => {
    await seedFlippedWorkspaceWithRefValue()
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'comment', workspaceId: WS, parentId: 'value', orderKey: 'a1',
        content: `see ((${D})) for why`, references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read('comment')!.content).toBe('see target body for why')
    expect(env.read('comment')!.references).toEqual([])
  })

  // Dormancy: the exemption is flip-gated like every other §9 recognition —
  // an un-flipped workspace has no property machinery to recognize, so the
  // same shape inlines as ordinary content.
  it('is dormant in an un-flipped workspace', async () => {
    await env.h.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'cell')`,
      [WS],
    )
    registerDefinition()
    await env.repo.tx(async tx => {
      await tx.create({
        id: DEF, workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'related', properties: {types: ['property-schema']},
      })
      await tx.create({id: D, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'target body'})
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'owner'})
      await tx.create({id: 'field', workspaceId: WS, parentId: 'p', orderKey: 'a1', content: `((${DEF}))`})
      await tx.create({
        id: 'value', workspaceId: WS, parentId: 'field', orderKey: 'a1',
        content: `((${D}))`, references: [{id: D, alias: D}],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.delete({id: D})

    expect(env.read('value')!.content).toBe('target body')
    expect(env.read('value')!.referenceTargetId).toBeNull()
  })
})
