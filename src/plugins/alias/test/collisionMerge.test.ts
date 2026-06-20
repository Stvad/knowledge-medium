// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, MergeIntoDescendantError, type BlockData } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
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
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    aliasDataExtension,
  ]))
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
// Dispose the per-test Repo's sync observer so its db.onChange subscription
// doesn't leak onto the shared DB (closed once in afterAll).
afterEach(() => { env.repo.stopSyncObserver() })

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
})
