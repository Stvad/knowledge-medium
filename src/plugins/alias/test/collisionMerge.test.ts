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
      fromId: 'source',
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
      fromId: 'ancestor',
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
      fromId: 'source',
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
      fromId: 'squatter',
      collisionAlias: 'Journal',
    })

    expect(env.read('squatter')!.deleted).toBe(true)
    expect(env.read('canonical')!.properties[aliasesProp.name]).toEqual(['Journal', 'Notes'])
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
      fromId: 'other',
      collisionAlias: 'Journal',
      sourceIsAliasOwner: true,
    })).rejects.toThrow(/no longer claims/)

    expect((await env.repo.load('other'))?.deleted).toBe(false)
  })
})
