// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, MergeIntoDescendantError, type BlockData } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { aliasDataExtension } from '../dataExtension.ts'
import { ALIAS_COLLISION_MERGE_MUTATOR } from '../collisionMerge.ts'

const WS = 'ws-1'

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
    extensions: [aliasDataExtension],
  })
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

/** A second live claimant of a name another block already holds. `repo.tx`
 *  cannot produce this — the uniqueness trigger rejects it — but sync-apply
 *  can, because that trigger's `WHEN` guard skips `tx_context.source IS NULL`.
 *  A raw insert is the same shape and still maintains `block_aliases`. */
const coClaimRaw = async (
  id: string,
  content: string,
  alias: string,
  createdAt: number,
): Promise<void> => {
  await env.h.db.execute(
    `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json,
      references_json, created_at, updated_at, user_updated_at, created_by, updated_by, deleted)
     VALUES (?, ?, NULL, ?, ?, ?, '[]', ?, ?, ?, 'u', 'u', 0)`,
    [id, WS, `k-${id}`, content, JSON.stringify(aliasProperty([alias])), createdAt, createdAt, createdAt],
  )
}

const createBlock = async (
  id: string,
  content: string,
  aliases: readonly string[],
  orderKey: string,
): Promise<void> => {
  await env.repo.tx(
    tx => tx.create({
      id,
      workspaceId: WS,
      parentId: null,
      orderKey,
      content,
      properties: aliasProperty(aliases),
    }),
    {scope: ChangeScope.BlockDefault},
  )
}

describe('alias.mergeCollision', () => {
  it('drops only the renamed-from alias during collision merge', async () => {
    await createBlock('target', 'Existing', ['Existing'], 'a0')
    await createBlock('source', 'Partial', ['Partial', 'Other'], 'a1')

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'target',
      fromIds: ['source'],
      collisionAlias: 'Existing',
      dropSourceAliases: ['Partial'],
    })

    expect(env.read('source')!.deleted).toBe(true)
    expect(env.read('target')!.content).toBe('Existing')
    expect(env.read('target')!.properties[aliasesProp.name]).toEqual(['Existing', 'Other'])
  })

  it('rejects merging into a descendant with the typed precondition error (#188)', async () => {
    // Reproduces the stuck "Merge into…" flow: renaming an aliased
    // ancestor page onto a descendant page's alias offers a merge with
    // the descendant as target. That direction can never succeed, so the
    // mutator must surface MergeIntoDescendantError (which the toast turns
    // into an actionable message) rather than a raw CycleError.
    await createBlock('ancestor', 'Ancestor', ['Ancestor'], 'a0')
    await env.repo.tx(
      tx => tx.create({
        id: 'descendant',
        workspaceId: WS,
        parentId: 'ancestor',
        orderKey: 'a0',
        content: 'Descendant',
        properties: aliasProperty(['Descendant']),
      }),
      {scope: ChangeScope.BlockDefault},
    )

    await expect(env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'descendant',
      fromIds: ['ancestor'],
      collisionAlias: 'Descendant',
    })).rejects.toBeInstanceOf(MergeIntoDescendantError)

    expect(env.read('ancestor')!.deleted).toBe(false)
    expect(env.read('descendant')!.deleted).toBe(false)
    expect(env.read('descendant')!.parentId).toBe('ancestor')
  })

  it('keeps all source aliases for direct alias collisions when no rename alias is supplied', async () => {
    await createBlock('target', 'Existing', ['Existing'], 'a0')
    await createBlock('source', 'Source', ['Source', 'Other'], 'a1')

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'target',
      fromIds: ['source'],
      collisionAlias: 'Existing',
    })

    expect(env.read('source')!.deleted).toBe(true)
    expect(env.read('target')!.properties[aliasesProp.name]).toEqual([
      'Existing',
      'Source',
      'Other',
    ])
  })

  it('transfers the contested name when the target does not already own it', async () => {
    // The canonical direction: a system page reclaiming its own name from a
    // squatter. The target holds no alias at all, so the collision alias must
    // move across — dropping it (correct when the target already owns it)
    // would destroy the name instead of transferring it.
    await createBlock('canonical', 'Journal', [], 'a0')
    await createBlock('squatter', 'My journal', ['Journal', 'Notes'], 'a1')

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['squatter'],
      collisionAlias: 'Journal',
    })

    expect(env.read('squatter')!.deleted).toBe(true)
    expect(env.read('canonical')!.properties[aliasesProp.name]).toEqual(['Journal', 'Notes'])
  })

  it('completes when the source title is owned by a third page, without claiming it', async () => {
    // The source can hold a title that is not among its own aliases. If some
    // third page owns that name, carrying it over would trip the uniqueness
    // trigger and roll back the whole merge — turning the collision this flow
    // exists to resolve into one it cannot.
    await createBlock('canonical', 'Journal', [], 'a0')
    await createBlock('squatter', 'Daily Log', ['Journal'], 'a1')
    await createBlock('third', 'Something', ['Daily Log'], 'a2')

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['squatter'],
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })

    // Merge went through and the name came back; the third page keeps its own.
    expect((await env.repo.load('canonical'))?.properties[aliasesProp.name])
      .toEqual(aliasesProp.codec.encode(['Journal']))
    expect(await env.repo.load('squatter')).toBeNull()
    expect((await env.repo.load('third'))?.properties[aliasesProp.name])
      .toEqual(aliasesProp.codec.encode(['Daily Log']))
  })

  it('carries a source title the survivor already holds, without duplicating it', async () => {
    // The survivor owns "Daily Log" as an alias; the page being absorbed is
    // TITLED "Daily Log". The name must not be lost, must not appear twice, and
    // must not be read as a third page's claim and skipped.
    await createBlock('canonical', 'Journal', ['Journal', 'Daily Log'], 'a0')
    // Co-claims 'Journal' — which canonical already holds — so it has to arrive
    // raw; a local tx would be rejected at setup by the uniqueness trigger.
    await coClaimRaw('squatter', 'Daily Log', 'Journal', 2_000)

    await expect(env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['squatter'],
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })).resolves.toBeUndefined()

    expect((await env.repo.load('canonical'))?.properties[aliasesProp.name])
      .toEqual(aliasesProp.codec.encode(['Journal', 'Daily Log']))
  })

  it('folds several claimants of one alias in a single transaction', async () => {
    // The state a local tx cannot build: the uniqueness trigger skips
    // sync-apply, so two devices creating the same page offline both keep
    // their claim. Raw inserts are that arrival shape.
    await createBlock('canonical', 'Journal', [], 'a0')
    await coClaimRaw('rival-a', 'First', 'Journal', 1_000)
    await coClaimRaw('rival-b', 'Second', 'Journal', 2_000)

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['rival-a', 'rival-b'],
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })

    // One survivor holding the name, with both absorbed titles preserved.
    expect((await env.repo.load('canonical'))?.properties[aliasesProp.name])
      .toEqual(aliasesProp.codec.encode(['Journal', 'First', 'Second']))
    expect(await env.repo.load('rival-a')).toBeNull()
    expect(await env.repo.load('rival-b')).toBeNull()
  })

  it('keeps each claimant\'s children in order, and after the survivor\'s own', async () => {
    // Each source's children are appended after the last one already there, so
    // the anchor has to advance as the fold goes. Against a stale anchor every
    // source starts from the same place and the two pages' children interleave
    // — silent, and it scrambles a page the user was reading.
    await createBlock('canonical', 'Journal', [], 'a0')
    await coClaimRaw('rival-a', 'First', 'Journal', 1_000)
    await coClaimRaw('rival-b', 'Second', 'Journal', 2_000)
    await env.repo.mutate.createChild({parentId: 'canonical', id: 'own', content: 'own'})
    await env.repo.mutate.createChild({parentId: 'rival-a', id: 'a1', content: 'a1'})
    await env.repo.mutate.createChild({parentId: 'rival-a', id: 'a2', content: 'a2'})
    await env.repo.mutate.createChild({parentId: 'rival-b', id: 'b1', content: 'b1'})
    await env.repo.mutate.createChild({parentId: 'rival-b', id: 'b2', content: 'b2'})

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['rival-a', 'rival-b'],
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })

    const rows = await env.h.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key',
      ['canonical'],
    )
    expect(rows.map(row => row.id)).toEqual(['own', 'a1', 'a2', 'b1', 'b2'])
  })

  it('leaves every claimant alone when one of them is refused', async () => {
    // Partial folds are the failure mode worth pinning: absorbing one rival and
    // then rejecting on the next would tombstone a page for a merge that never
    // completed. One transaction means all or nothing.
    await createBlock('canonical', 'Journal', [], 'a0')
    await coClaimRaw('rival-a', 'First', 'Journal', 1_000)
    await createBlock('unrelated', 'Elsewhere', ['Something else'], 'a3')

    await expect(env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['rival-a', 'unrelated'],
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })).rejects.toThrow(/no longer claims/)

    expect((await env.repo.load('rival-a'))?.deleted).toBe(false)
    expect((await env.repo.load('unrelated'))?.deleted).toBe(false)
  })

  it('refuses when the target was renamed away from the contested name', async () => {
    // The other half of the same race: the banner offered "reclaim Journal for
    // this page", then this page was renamed. Absorbing the alias owner into it
    // now would fold that page into something the user was never looking at.
    await createBlock('canonical', 'Journal', [], 'a0')
    await createBlock('squatter', 'Mine', ['Journal'], 'a1')
    await env.repo.tx(tx => tx.update('canonical', {content: 'Something else'}),
      {scope: ChangeScope.BlockDefault})

    await expect(env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['squatter'],
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })).rejects.toThrow(/no longer named/)

    expect((await env.repo.load('squatter'))?.deleted).toBe(false)
  })

  it('refuses when the source no longer claims the alias, in the reclaim direction', async () => {
    // A banner can sit on screen while the world moves, and the mutator is
    // exported so an extension can call it with anything. Folding a page that
    // does not hold the name would tombstone it and re-home its children for
    // nothing. Only checked in the reclaim direction — in the rejection
    // direction the source never holds the alias, by construction.
    await createBlock('canonical', 'Journal', [], 'a0')
    await createBlock('other', 'Unrelated', ['Something else'], 'a1')

    await expect(env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'canonical',
      fromIds: ['other'],
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })).rejects.toThrow(/no longer claims/)

    expect((await env.repo.load('other'))?.deleted).toBe(false)
  })
})
