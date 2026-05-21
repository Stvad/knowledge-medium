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
  blockTypeDescriptionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import { UserTypesService } from '@/data/userTypesService'

const WS = 'ws-user-types'

interface Harness {
  h: TestDb
  repo: Repo
  service: UserTypesService
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
    registerKernelProcessors: false,
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
  const userSchemas = repo.userSchemas
  const disposeUserSchemas = userSchemas.start()
  const service = repo.userTypes
  const disposeService = service.start()
  const dispose = (): void => {
    disposeService()
    disposeUserSchemas()
  }
  return {h, repo, service, dispose}
}

let env: Harness
afterEach(async () => {
  env.dispose()
  await env.h.cleanup()
})

const createBlockTypeBlock = async (
  repo: Repo,
  args: {label: string; description?: string; properties?: readonly string[]},
): Promise<string> => {
  const id = await repo.mutate.createChild({parentId: repo.typesPageId!})
  await repo.tx(async tx => {
    await repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {})
    await tx.setProperty(id, blockTypeLabelProp, args.label)
    if (args.description !== undefined) {
      await tx.setProperty(id, blockTypeDescriptionProp, args.description)
    }
    if (args.properties !== undefined) {
      await tx.setProperty(id, blockTypePropertiesProp, args.properties)
    }
  }, {scope: ChangeScope.BlockDefault})
  // Allow the subscription to fire.
  await new Promise(resolve => setTimeout(resolve, 50))
  return id
}

describe('UserTypesService subscription', () => {
  it('publishes a TypeContribution when a block-type block is created', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Person'})
    const contribution = env.repo.types.get(id)
    expect(contribution).toBeDefined()
    expect(contribution!.label).toBe('Person')
    expect(contribution!.id).toBe(id)
    expect(env.service.getTypeBlockId(id)).toBe(id)
  })

  it('skips a block with an empty label', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: ''})
    expect(env.repo.types.get(id)).toBeUndefined()
    expect(env.service.getTypeBlockId(id)).toBeUndefined()
  })

  it('resolves block-type:properties refs through UserSchemasService.getSchemaForBlockId', async () => {
    env = await setup()
    const schema = await env.repo.userSchemas.addSchema({name: 'dob', presetId: 'string'})
    const schemaBlockId = env.repo.userSchemas.getSchemaBlockId(schema.name)!
    const id = await createBlockTypeBlock(env.repo, {
      label: 'Person',
      properties: [schemaBlockId],
    })
    const contribution = env.repo.types.get(id)
    expect(contribution).toBeDefined()
    expect(contribution!.properties).toEqual([schema])
  })

  it('drops unresolved property refs at publish time and fills them in when the schema lands', async () => {
    env = await setup()
    // Create the type with a ref to a not-yet-existent schema.
    const ghostSchemaId = 'no-such-schema-block'
    const id = await createBlockTypeBlock(env.repo, {
      label: 'Person',
      properties: [ghostSchemaId],
    })
    expect(env.repo.types.get(id)?.properties ?? []).toEqual([])

    // Now add a real schema and re-point the type's properties ref to it.
    const schema = await env.repo.userSchemas.addSchema({name: 'email', presetId: 'string'})
    const schemaBlockId = env.repo.userSchemas.getSchemaBlockId(schema.name)!
    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypePropertiesProp, [schemaBlockId])
    }, {scope: ChangeScope.BlockDefault})
    await new Promise(resolve => setTimeout(resolve, 50))

    expect(env.repo.types.get(id)?.properties).toEqual([schema])
  })

  it('disposes cleanly: post-dispose changes do not republish', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Person'})
    expect(env.repo.types.get(id)).toBeDefined()
    env.service.dispose()
    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeLabelProp, 'Renamed')
    }, {scope: ChangeScope.BlockDefault})
    await new Promise(resolve => setTimeout(resolve, 50))
    // The contribution still reflects the pre-dispose state.
    expect(env.repo.types.get(id)?.label).toBe('Person')
  })

  it('double-start throws to surface lifecycle bugs', async () => {
    env = await setup()
    expect(() => env.service.start()).toThrow(/already started/)
  })
})
