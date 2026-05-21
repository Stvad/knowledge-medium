// @vitest-environment node

import { afterEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import {
  blockTypeLabelProp,
  blockTypePropertiesProp,
  getBlockTypes,
  typesProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import { ROAM_ISA_PROP } from '../properties'
import {
  PromotionRegistrationTimeout,
  promoteToType,
} from '../typePromotion'

const WS = 'ws-promote-to-type'

interface Harness {
  h: TestDb
  repo: Repo
  dispose: () => void
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
    // Kernel processors enabled: queryBlocks({referencedBy}) reads
    // block_references which is populated from BlockData.references.
    // The promotion test writes references[] directly via tx.update,
    // so we don't need parseReferences itself, but the kernel
    // invalidation/processor wiring runs cleanly with defaults.
    startRowEventsTail: false,
  })
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    kernelPropertyUiExtension,
    kernelValuePresetsExtension,
  ]))
  await getOrCreatePropertiesPage(repo, WS)
  await getOrCreateTypesPage(repo, WS)
  const disposeUserSchemas = repo.userSchemas.start()
  const disposeUserTypes = repo.userTypes.start()
  const dispose = (): void => {
    disposeUserTypes()
    disposeUserSchemas()
  }
  return {h, repo, dispose}
}

const createPersonPage = async (env: Harness): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    await tx.update(id, {content: 'Person'})
  }, {scope: ChangeScope.BlockDefault})
  return id
}

const tagBlockWithIsa = async (
  env: Harness,
  targetId: string,
  content: string,
): Promise<string> => {
  const id = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
  await env.repo.tx(async tx => {
    const block = await tx.get(id)
    if (!block) throw new Error(`createChild returned id but tx.get missed it: ${id}`)
    await tx.update(id, {
      content,
      properties: {
        ...block.properties,
        [ROAM_ISA_PROP]: [targetId],
      },
      references: [{id: targetId, alias: 'Person', sourceField: ROAM_ISA_PROP}],
    })
  }, {scope: ChangeScope.BlockDefault})
  return id
}

let env: Harness
afterEach(async () => {
  env.dispose()
  await env.h.cleanup()
})

describe('promoteToType — Phase A', () => {
  it('turns the target into a block-type page with label + properties', async () => {
    env = await setup()
    const personId = await createPersonPage(env)

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
    })

    const target = await env.repo.load(personId)
    expect(target).not.toBeNull()
    const types = getBlockTypes(target!)
    expect(types).toContain(BLOCK_TYPE_TYPE)
    expect(types).toContain(PAGE_TYPE)
    expect(target!.properties[blockTypeLabelProp.name]).toBe('Person')
    expect(target!.properties[blockTypePropertiesProp.name]).toEqual([])
    expect(env.repo.types.has(personId)).toBe(true)
  })

  it('attaches the picked property-schema refs to block-type:properties', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    const schema = await env.repo.userSchemas.addSchema({
      name: 'roam:twitter',
      presetId: 'string',
    })
    const schemaBlockId = env.repo.userSchemas.getSchemaBlockId(schema.name)!

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [schemaBlockId],
    })

    const target = await env.repo.load(personId)
    expect(target!.properties[blockTypePropertiesProp.name]).toEqual([schemaBlockId])
    const registered = env.repo.types.get(personId)
    expect(registered).toBeDefined()
    expect(registered!.label).toBe('Person')
    expect(registered!.properties?.map(p => p.name)).toEqual(['roam:twitter'])
  })
})

describe('promoteToType — Phase B', () => {
  it('retags every block that points at the target via roam:isa', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    const aliceId = await tagBlockWithIsa(env, personId, 'Alice')
    const bobId = await tagBlockWithIsa(env, personId, 'Bob')

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
    })

    const alice = await env.repo.load(aliceId)
    expect(getBlockTypes(alice!)).toContain(personId)
    const bob = await env.repo.load(bobId)
    expect(getBlockTypes(bob!)).toContain(personId)
  })

  it('does not touch blocks that do not reference the target via roam:isa', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    const otherTargetId = await createPersonPage(env)
    const unrelatedId = await tagBlockWithIsa(env, otherTargetId, 'Unrelated')

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
    })

    const unrelated = await env.repo.load(unrelatedId)
    expect(getBlockTypes(unrelated!)).not.toContain(personId)
  })

  it('with rewriteIsaReferences=true, strips the promoted alias from roam:isa', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    const aliceId = await tagBlockWithIsa(env, personId, 'Alice')

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
      rewriteIsaReferences: true,
    })

    const alice = await env.repo.load(aliceId)
    expect(alice!.properties[ROAM_ISA_PROP]).toEqual([])
  })

  it('with rewriteIsaReferences=false (default), leaves roam:isa intact', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    const aliceId = await tagBlockWithIsa(env, personId, 'Alice')

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
    })

    const alice = await env.repo.load(aliceId)
    expect(alice!.properties[ROAM_ISA_PROP]).toEqual([personId])
  })
})

describe('promoteToType — pre-tx validation', () => {
  it('throws when label is blank', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    await expect(promoteToType(env.repo, {
      targetBlockId: personId,
      label: '   ',
      propertySchemaIds: [],
    })).rejects.toThrow(/label must be a non-empty string/)
    // Phase A did not run — target is still untyped.
    const target = await env.repo.load(personId)
    expect(getBlockTypes(target!)).not.toContain(BLOCK_TYPE_TYPE)
  })

  it('throws when the target block is missing', async () => {
    env = await setup()
    await expect(promoteToType(env.repo, {
      targetBlockId: 'nonexistent',
      label: 'Person',
      propertySchemaIds: [],
    })).rejects.toThrow(/target nonexistent not found or tombstoned/)
  })

  it('throws when a propertySchemaId does not resolve to a live block', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    await expect(promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: ['no-such-block'],
    })).rejects.toThrow(/doesn't resolve to a live block/)
  })

  it('honors an aborted signal pre-flight without committing Phase A', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    const controller = new AbortController()
    controller.abort()
    await expect(promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
      signal: controller.signal,
    })).rejects.toBeDefined()
    const target = await env.repo.load(personId)
    expect(getBlockTypes(target!)).not.toContain(BLOCK_TYPE_TYPE)
  })
})

describe('promoteToType — idempotence', () => {
  it('re-running promoteToType is a no-op for the membership write and a fresh stamp for label/properties', async () => {
    env = await setup()
    const personId = await createPersonPage(env)

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
    })
    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person (renamed)',
      propertySchemaIds: [],
    })

    const target = await env.repo.load(personId)
    // BLOCK_TYPE_TYPE appears exactly once — addTypeInTx no-ops on retry.
    const types = getBlockTypes(target!)
    expect(types.filter(t => t === BLOCK_TYPE_TYPE)).toHaveLength(1)
    // Label is the freshly-stamped one — setProperty overwrites
    // unconditionally so retries can repair the type.
    expect(target!.properties[blockTypeLabelProp.name]).toBe('Person (renamed)')
  })
})

describe('promoteToType — registration timeout', () => {
  it('PromotionRegistrationTimeout has the expected shape', () => {
    const err = new PromotionRegistrationTimeout('target-id', 'Person', 1000)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('PromotionRegistrationTimeout')
    expect(err.targetBlockId).toBe('target-id')
    expect(err.typeLabel).toBe('Person')
    expect(err.timeoutMs).toBe(1000)
    expect(err.message).toContain('did not appear in the runtime registry within 1000ms')
  })
})

describe('promoteToType — typesProp shape', () => {
  it('preserves existing types on the target page (membership is additive)', async () => {
    env = await setup()
    const personId = await createPersonPage(env)
    // Pre-tag with some other type id (synthetic, not a real registered
    // type — addTypeInTx validates against the registry, but typesProp
    // directly is just a string list).
    await env.repo.tx(async tx => {
      const row = await tx.get(personId)
      if (!row) throw new Error('missing person row')
      await tx.update(personId, {
        properties: {
          ...row.properties,
          [typesProp.name]: ['some-other-type'],
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    await promoteToType(env.repo, {
      targetBlockId: personId,
      label: 'Person',
      propertySchemaIds: [],
    })

    const target = await env.repo.load(personId)
    const types = getBlockTypes(target!)
    expect(types).toContain('some-other-type')
    expect(types).toContain(BLOCK_TYPE_TYPE)
    expect(types).toContain(PAGE_TYPE)
  })
})
