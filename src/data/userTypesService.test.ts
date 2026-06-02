// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
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
const SUBSCRIPTION_TIMEOUT_MS = 3_000

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
    startSyncObserver: false,
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

const waitForTypeRegistration = async (
  repo: Repo,
  typeId: string,
  label: string,
): Promise<void> => {
  await vi.waitFor(() => {
    expect(repo.types.get(typeId)?.label).toBe(label)
  }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
}

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
  if (args.label) await waitForTypeRegistration(repo, id, args.label)
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
    await vi.waitFor(() => {
      expect(env.repo.types.get(id)?.properties).toEqual([schema])
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})

    expect(env.repo.types.get(id)?.properties).toEqual([schema])
  })

  it('disposes cleanly: dispose clears the bucket and later block edits do not republish', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Person'})
    expect(env.repo.types.get(id)).toBeDefined()
    env.service.dispose()
    // Dispose now clears the user-data bucket — the type is gone, not
    // simply frozen at its pre-dispose value (see workspace-switch race
    // fix below).
    expect(env.repo.types.get(id)).toBeUndefined()
    // A subsequent block edit MUST NOT trigger a republish from this
    // disposed instance (no leaking subscription).
    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeLabelProp, 'Renamed')
    }, {scope: ChangeScope.BlockDefault})
    expect(env.repo.types.get(id)).toBeUndefined()
  })

  it('double-start throws to surface lifecycle bugs', async () => {
    env = await setup()
    expect(() => env.service.start()).toThrow(/already started/)
  })

  it('does not feedback-loop with the propertySchemas rebuild step', async () => {
    // Regression: the propertySchemas rebuild step in Repo fires BOTH
    // propertySchemasListeners (which UserTypesService subscribes to)
    // AND typesListeners. Before the fix, an unconditional republish
    // from inside the schemas listener triggered the step again and
    // re-fired the listener, exceeding the call stack. The fix
    // short-circuits when the new contribution list is field-equal to
    // the previous one.
    env = await setup()
    await createBlockTypeBlock(env.repo, {label: 'Person'})

    // Adding an unrelated schema fires onPropertySchemasChange. Before
    // the fix, this triggered an infinite recursion through
    // UserTypesService → setRuntimeContributions(typesFacet, ...) →
    // step → propertySchemasListeners → UserTypesService → ...
    // (RangeError: Maximum call stack size exceeded).
    await expect(env.repo.userSchemas.addSchema({name: 'mood', presetId: 'string'}))
      .resolves.toBeDefined()
  })
})

describe('UserTypesService workspace switch', () => {
  // Regression for reviewer feedback: AppRuntimeProvider starts
  // userSchemas before userTypes; on workspace switch the new
  // userSchemas service can publish before the new userTypes
  // subscription has loaded, firing onPropertySchemasChange. Before
  // the fix, UserTypesService would rebuild against the PREVIOUS
  // workspace's latestBlocks, briefly republishing its types into
  // typesFacet (cross-workspace leak). dispose() now drops
  // latestBlocks AND clears the user-data bucket, and the schemas-
  // listener rebuild is gated on the workspace-pinned subscription's
  // first tick.

  it('does not leak previous-workspace types after dispose+restart on a new workspace', async () => {
    env = await setup()
    // Create a type block in workspace W1.
    const w1TypeBlockId = await createBlockTypeBlock(env.repo, {label: 'Person'})
    expect(env.repo.types.get(w1TypeBlockId)?.label).toBe('Person')

    // Workspace switch: dispose the service, set a new active workspace,
    // bootstrap its pages, and start again. The user-data type bucket
    // should be clear AFTER dispose — no leakage into W2.
    env.service.dispose()
    expect(env.repo.types.get(w1TypeBlockId)).toBeUndefined()

    const W2 = 'ws-user-types-2'
    env.repo.setActiveWorkspaceId(W2)
    await getOrCreatePropertiesPage(env.repo, W2)
    await getOrCreateTypesPage(env.repo, W2)
    env.service.start()

    // Mimics the React-effect remount sequence on workspace switch:
    // the new workspace's userSchemas publishes first, firing
    // onPropertySchemasChange. Pre-fix, that listener would rebuild
    // against the previous workspace's latestBlocks and republish
    // 'Person' into typesFacet under the new workspace. Post-fix it's
    // a no-op (subscriptionPrimed=false + latestBlocks=[] after dispose).
    await env.repo.userSchemas.addSchema({name: 'mood', presetId: 'string'})

    expect(env.repo.types.get(w1TypeBlockId)).toBeUndefined()
  })

  it('clears the user-data type bucket on dispose()', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Person'})
    expect(env.repo.types.has(id)).toBe(true)
    env.service.dispose()
    expect(env.repo.types.has(id)).toBe(false)
  })
})
