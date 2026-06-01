// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, normalizeReferences, type BlockData } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/internals/coreProperties'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { aliasDataExtension } from '../dataExtension.ts'
import { ALIAS_COLLISION_MERGE_MUTATOR } from '../collisionMerge.ts'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
  read(id: string): BlockData | undefined
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
    aliasDataExtension,
  ]))
  return {
    h,
    repo,
    read: id => cache.getSnapshot(id),
  }
}

let env: Harness
beforeEach(async () => { env = await setup() })
afterEach(async () => { await env.h.cleanup() })

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
  it('drops only the renamed-from alias and rewrites those backlinks to the collision alias', async () => {
    await createBlock('target', 'Existing', ['Existing'], 'a0')
    await createBlock('source', 'Partial', ['Partial', 'Other'], 'a1')
    await env.repo.tx(
      tx => tx.create({
        id: 'ref',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a2',
        content: 'see [[Partial]] and [[Other]]',
        references: [
          {id: 'source', alias: 'Partial'},
          {id: 'source', alias: 'Other'},
        ],
      }),
      {scope: ChangeScope.BlockDefault},
    )

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

  it('keeps all source aliases for direct alias collisions when no rename alias is supplied', async () => {
    await createBlock('target', 'Existing', ['Existing'], 'a0')
    await createBlock('source', 'Source', ['Source', 'Other'], 'a1')
    await env.repo.tx(
      tx => tx.create({
        id: 'ref',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a2',
        content: 'see [[Source]] and [[Other]]',
        references: [
          {id: 'source', alias: 'Source'},
          {id: 'source', alias: 'Other'},
        ],
      }),
      {scope: ChangeScope.BlockDefault},
    )

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
    expect(env.read('ref')!.content).toBe('see [[Source]] and [[Other]]')
    expect(env.read('ref')!.references).toEqual(normalizeReferences([
      {id: 'target', alias: 'Source'},
      {id: 'target', alias: 'Other'},
    ]))
  })
})
