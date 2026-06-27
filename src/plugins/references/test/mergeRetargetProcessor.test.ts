// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, normalizeReferences, type BlockData } from '@/data/api'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { ALIAS_COLLISION_MERGE_MUTATOR } from '@/plugins/alias/collisionMerge.ts'
import { referencesDataExtension } from '../dataExtension.ts'

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
    extensions: [referencesDataExtension, aliasDataExtension],
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

describe('references.retargetMergedBlockReferences', () => {
  it('retargets stored backlinks and blockref syntax from source to target atomically with core.merge', async () => {
    const intoId = '11111111-1111-4111-8111-111111111111'
    const fromId = '22222222-2222-4222-8222-222222222222'
    const refId = '33333333-3333-4333-8333-333333333333'

    await env.repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({
        id: intoId,
        workspaceId: WS,
        parentId: 'p',
        orderKey: 'a0',
        content: 'Target page',
        properties: aliasProperty(['Target page']),
      })
      await tx.create({
        id: fromId,
        workspaceId: WS,
        parentId: 'p',
        orderKey: 'a1',
        content: 'Source page',
        properties: aliasProperty(['Source page']),
      })
      await tx.create({
        id: refId,
        workspaceId: WS,
        parentId: 'p',
        orderKey: 'a2',
        content: `Links [[Source page]] ((${fromId})) [source block](((${fromId}))) !((${fromId}))`,
        references: [
          {id: fromId, alias: 'Source page'},
          {id: fromId, alias: fromId},
        ],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.merge({intoId, fromId, contentStrategy: 'keepTarget'})

    expect(env.read(fromId)!.deleted).toBe(true)
    expect(env.read(intoId)!.properties[aliasesProp.name]).toEqual(['Target page', 'Source page'])
    expect(env.read(refId)!.content).toBe(
      `Links [[Source page]] ((${intoId})) [source block](((${intoId}))) !((${intoId}))`,
    )
    expect(env.read(refId)!.references).toEqual(normalizeReferences([
      {id: intoId, alias: 'Source page'},
      {id: intoId, alias: intoId},
    ]))
  })

  it('uses alias rewrite metadata from alias-collision merges', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'Existing',
        properties: aliasProperty(['Existing']),
      })
      await tx.create({
        id: 'source',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a1',
        content: 'Partial',
        properties: aliasProperty(['Partial', 'Other']),
      })
      await tx.create({
        id: 'ref',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a2',
        content: 'see [[Partial]] and [[Other]]',
        references: [
          {id: 'source', alias: 'Partial'},
          {id: 'source', alias: 'Other'},
        ],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'target',
      fromId: 'source',
      collisionAlias: 'Existing',
      dropSourceAliases: ['Partial'],
    })

    expect(env.read('source')!.deleted).toBe(true)
    expect(env.read('target')!.content).toBe('Existing')
    expect(env.read('target')!.properties[aliasesProp.name]).toEqual(['Existing', 'Other'])
    expect(env.read('ref')!.content).toBe('see [[Existing]] and [[Other]]')
    expect(env.read('ref')!.references).toEqual(normalizeReferences([
      {id: 'target', alias: 'Existing'},
      {id: 'target', alias: 'Other'},
    ]))
  })
})
