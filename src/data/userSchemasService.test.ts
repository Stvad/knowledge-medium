// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ChangeScope, codecs, definePresetCore, defineProperty, type AnyValuePresetCore } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import {propertyDefinitionBlockId} from '@/data/definitionSeeds'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import {
  projectedPropertyDefinitionsFacet,
  propertySchemasFacet,
  valuePresetCoresFacet,
} from '@/data/facets'
import {
  propertyChangeScopeProp,
  propertyDefaultProp,
  propertyHiddenProp,
  propertyNameProp,
  seedKeyProp,
} from '@/data/properties'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import type { UserSchemasService } from './userSchemasService'
import { Repo } from './repo'

const WS = 'ws-user-schemas'
const SUBSCRIPTION_TIMEOUT_MS = 3_000

interface Harness {
  h: TestDb
  repo: Repo
  service: UserSchemasService
  dispose: () => void
}

const setup = async (extraPresets: readonly AnyValuePresetCore[] = []): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll); each test calls setup()
  // inline, so reset here gives the per-test clean slate.
  await resetTestDb(sharedDb.db)
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      ...extraPresets.map(p => valuePresetCoresFacet.of(p, {source: 'test'})),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
  const service = repo.userSchemas
  const dispose = (): void => repo.setActiveWorkspaceId(null)
  const h: TestDb = {db: sharedDb.db, cleanup: async () => {}}
  return {h, repo, service, dispose}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  env.dispose()
  await env.h.cleanup()
})

const waitForPropertySchemasChange = async <T,>(action: () => Promise<T>): Promise<T> => {
  let dispose = (): void => {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let settled = false
  const settle = (cb: () => void) => {
    if (settled) return
    settled = true
    if (timer !== null) clearTimeout(timer)
    dispose()
    cb()
  }
  const changed = new Promise<void>((resolve, reject) => {
    dispose = env.repo.onPropertySchemasChange(() => settle(resolve))
    timer = setTimeout(
      () => settle(() => reject(new Error('timed out waiting for property schema rebuild'))),
      SUBSCRIPTION_TIMEOUT_MS,
    )
  })
  try {
    const result = await action()
    await changed
    return result
  } catch (error) {
    settle(() => {})
    throw error
  }
}

const createExternalSchemaBlock = async (
  name: string,
  presetId = 'string',
  config: unknown = {},
  extraProperties: Record<string, unknown> = {},
): Promise<string> => {
  const propertiesPageId = env.repo.propertiesPageId!
  const id = await env.repo.mutate.createChild({parentId: propertiesPageId})
  await waitForPropertySchemasChange(async () => {
    await env.repo.tx(async tx => {
      await tx.update(id, {
        properties: {
          types: ['property-schema'],
          'property-schema:name': name,
          'property-schema:preset': presetId,
          'property-schema:config': config,
          ...extraProperties,
        },
      })
    }, {scope: ChangeScope.BlockDefault})
  })
  return id
}

describe('UserSchemasService.addSchema', () => {
  it('persists a property-schema block AND registers the schema synchronously', async () => {
    env = await setup()
    const schema = await env.service.addSchema({name: 'homepage', presetId: 'url'})
    expect(schema.name).toBe('homepage')
    expect(schema.codec.type).toBe('url')
    // Synchronous: visible in repo.propertySchemas before any subscription tick.
    expect(env.repo.propertySchemas.get('homepage')).toBe(schema)
    expect(env.repo.propertySchemaResolverFor(WS).resolve('homepage')).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({
        fieldId: env.service.getSchemaBlockId('homepage'),
        workspaceId: WS,
      }),
    })
  })

  it('retains same-name definitions by field id during an immediate append', async () => {
    env = await setup()
    await env.service.addSchema({name: 'status', presetId: 'string'})
    const firstId = env.service.getSchemaBlockId('status')!
    await env.service.addSchema({name: 'status', presetId: 'string'})

    const definitions = env.repo.propertyDefinitions?.definitionsByName.get('status') ?? []
    expect(definitions.map(definition => definition.fieldId)).toContain(firstId)
    expect(definitions).toHaveLength(2)
    expect(env.service.getSchemaBlockId('status')).toBe(definitions[0]?.fieldId)
    expect(env.repo.propertySchemaResolverFor(WS).resolve('status')).toEqual({
      status: 'resolved',
      schema: expect.objectContaining({fieldId: definitions[0]?.fieldId}),
    })
  })

  it('rejects unknown preset ids', async () => {
    env = await setup()
    await expect(env.service.addSchema({name: 'x', presetId: 'nope'}))
      .rejects.toThrow(/no preset registered for id/)
  })

  it('runs config through preset.configCodec.decode and rejects malformed', async () => {
    env = await setup()
    await expect(env.service.addSchema({
      name: 'assignee',
      presetId: 'ref',
      config: {targetTypes: 'oops-not-an-array'},
    })).rejects.toThrow(/invalid config/)
  })

  it('builds ref preset config via configCodec round-trip', async () => {
    env = await setup()
    const schema = await env.service.addSchema({
      name: 'assignee',
      presetId: 'ref',
      config: {targetTypes: ['person']},
    })
    expect(schema.codec.type).toBe('ref')
    const codec = schema.codec as ReturnType<typeof codecs.ref>
    expect(codec.targetTypes).toEqual(['person'])
  })

  it('uses the enum preset default config when config is omitted', async () => {
    env = await setup()
    const schema = await env.service.addSchema({name: 'status', presetId: 'enum'})
    expect(schema.codec.type).toBe('enum')
    expect(schema.codec.decode(schema.codec.encode(schema.defaultValue))).toBe(schema.defaultValue)
    expect(() => schema.codec.encode('open')).toThrow()
  })

  it('builds enum options from persisted config', async () => {
    env = await setup()
    const schema = await env.service.addSchema({
      name: 'status',
      presetId: 'enum',
      config: {options: [{value: 'open', label: 'Open'}]},
    })
    expect(schema.codec.encode('open')).toBe('open')
    expect(() => schema.codec.encode('closed')).toThrow()
  })
})

describe('UserSchemasService subscription', () => {
  it('rebuilds the contribution list when a schema block is created externally', async () => {
    env = await setup()
    // Add the schema block directly through a tx (simulates a sync arrival).
    await createExternalSchemaBlock('tags')
    await vi.waitFor(() => {
      expect(env.repo.propertySchemas.get('tags')?.codec.type).toBe('string')
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('skips schemas with unknown preset ids and re-resolves when the preset shows up later', async () => {
    env = await setup()
    await createExternalSchemaBlock('priority', 'priority-preset')
    expect(env.repo.propertySchemas.get('priority')).toBeUndefined()

    // Plugin loads and contributes the missing preset core → schema resolves on
    // the valuePresets-change tick.
    const priorityPreset = definePresetCore<string>({
      id: 'priority-preset',
      build: () => codecs.string,
      defaultValue: 'low',
    })
    env.repo.setRuntimeContributions(valuePresetCoresFacet, 'plugin', [priorityPreset])
    // The preset arrival re-resolves the previously-skipped schema on the
    // valuePresets-change tick. Unlike the subscription-path assertions, this
    // read isn't preceded by an awaited change event, and the
    // valuePresets-change -> rebuild chain does NOT settle synchronously
    // within setRuntimeContributions (it flakes under full-suite load), so
    // poll for the resolved schema.
    await vi.waitFor(() => {
      expect(env.repo.propertySchemas.get('priority')?.codec.type).toBe('string')
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('publishes codec-less metadata even while an unknown preset blocks behavior', async () => {
    env = await setup()
    const id = await createExternalSchemaBlock(
      'plugin:config',
      'plugin:not-installed',
      {},
      {
        [propertyChangeScopeProp.name]: ChangeScope.Automation,
        [propertyHiddenProp.name]: true,
      },
    )

    await vi.waitFor(() => {
      expect(env.repo.propertyDefinitions?.definitionsByFieldId.get(id)).toMatchObject({
        fieldId: id,
        workspaceId: WS,
        name: 'plugin:config',
        changeScope: ChangeScope.Automation,
        hidden: true,
        origin: 'user',
      })
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
    expect(env.repo.propertySchemas.get('plugin:config')).toBeUndefined()
  })

  it('keeps metadata when preset/default/build behavior decoding throws', async () => {
    const throwingPreset = definePreset<string>({
      id: 'test-throwing-build',
      label: 'Throwing',
      build: () => { throw new Error('build failed') },
      defaultValue: '',
      Editor: (): JSX.Element => createElement('span', null, null),
    })
    env = await setup([throwingPreset])
    const malformedPresetId = await createExternalSchemaBlock(
      'bad:preset',
      'string',
      {},
      {'property-schema:preset': 42},
    )
    const malformedDefaultId = await createExternalSchemaBlock(
      'bad:default',
      'string',
      {},
      {[propertyDefaultProp.name]: {not: 'a string'}},
    )
    const throwingBuildId = await createExternalSchemaBlock('bad:build', throwingPreset.id)

    for (const [id, name] of [
      [malformedPresetId, 'bad:preset'],
      [malformedDefaultId, 'bad:default'],
      [throwingBuildId, 'bad:build'],
    ] as const) {
      await vi.waitFor(() => {
        expect(env.repo.propertyDefinitions?.definitionsByFieldId.get(id)?.name).toBe(name)
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
      expect(env.repo.propertySchemas.has(name)).toBe(false)
    }
  })

  it('builds fallback behavior from the persisted scope and explicit default', async () => {
    env = await setup()
    await createExternalSchemaBlock('scoped:title', 'string', {}, {
      [propertyChangeScopeProp.name]: ChangeScope.UserPrefs,
      [propertyDefaultProp.name]: 'from-definition',
    })

    await vi.waitFor(() => {
      expect(env.repo.propertySchemas.get('scoped:title')).toMatchObject({
        changeScope: ChangeScope.UserPrefs,
        defaultValue: 'from-definition',
      })
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('resolves an identity-checked seeded row as fallback without a local declaration', async () => {
    env = await setup()
    const seedKey = 'system:missing-plugin/property/fallback-title'
    const id = propertyDefinitionBlockId(WS, seedKey)
    await waitForPropertySchemasChange(async () => {
      await env.repo.tx(async tx => {
        await tx.create({
          id,
          workspaceId: WS,
          parentId: env.repo.propertiesPageId,
          orderKey: 'a0',
          content: 'fallback:title',
          properties: {
            types: ['property-schema'],
            'property-schema:name': 'fallback:title',
            'property-schema:preset': 'string',
            'property-schema:config': {},
            [seedKeyProp.name]: seedKey,
          },
        })
      }, {scope: ChangeScope.BlockDefault})
    })

    await vi.waitFor(() => {
      expect(env.repo.propertySchemaResolverFor(WS).resolve('fallback:title')).toEqual({
        status: 'resolved',
        schema: expect.objectContaining({
          fieldId: id,
          workspaceId: WS,
          name: 'fallback:title',
          origin: 'plugin:system:missing-plugin',
        }),
      })
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('addSchema-followed-by-immediate-write does not race the subscription tick', async () => {
    env = await setup()
    const schema = await env.service.addSchema({
      name: 'site',
      presetId: 'url',
    })
    // Synchronously, the schema is registered. A write through the
    // schema before the subscription tick should encode correctly.
    expect(env.repo.propertySchemas.get('site')).toBe(schema)
    // Encoding through the registered schema works (the preset's codec
    // is the URL codec — passes string through).
    expect(schema.codec.encode('https://example.com')).toBe('https://example.com')
  })

  it('rejects ref config that breaks configCodec.decode contract (null targetTypes element)', async () => {
    env = await setup()
    await expect(env.service.addSchema({
      name: 'related',
      presetId: 'refList',
      config: {targetTypes: ['ok', 42]},
    })).rejects.toThrow(/invalid config/)
  })
})

describe('UserSchemasService.getSchemaForBlockId', () => {
  // Required by UserTypesService (Phase 1 of user-defined-types): the
  // block-type:properties refList resolves through this lookup instead
  // of peeking the referenced schema block directly, to avoid
  // BlockCache hydration races and re-deriving the workspace/type/name
  // invariants that the publish path already validated.

  it('returns the registered schema after addSchema (synchronous appendUserSchema path)', async () => {
    env = await setup()
    const schema = await env.service.addSchema({name: 'homepage', presetId: 'url'})
    const blockId = env.service.getSchemaBlockId(schema.name)!
    expect(blockId).toBeDefined()
    expect(env.service.getSchemaForBlockId(blockId)).toBe(schema)
  })

  it('returns the registered schema after an external schema-block creation (subscription rebuild)', async () => {
    env = await setup()
    const id = await createExternalSchemaBlock('tags')

    // The block subscription settles over one or more rebuild ticks;
    // waitForPropertySchemasChange resolves on the first change event, which
    // under full-suite load can precede the rebuild that registers this
    // schema. Poll the reverse-map rather than reading it synchronously.
    await vi.waitFor(() => {
      const resolved = env.service.getSchemaForBlockId(id)
      expect(resolved?.name).toBe('tags')
      expect(resolved?.codec.type).toBe('string')
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('returns undefined for unknown block ids', async () => {
    env = await setup()
    expect(env.service.getSchemaForBlockId('not-a-real-block-id')).toBeUndefined()
  })

  it('drops the reverse-map entry when a block stops resolving to a schema', async () => {
    env = await setup()
    const id = await createExternalSchemaBlock('tags')
    await vi.waitFor(() => {
      expect(env.service.getSchemaForBlockId(id)?.name).toBe('tags')
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})

    // Blank the name — tryBuildSchema will now drop the block on the
    // next rebuild tick.
    await waitForPropertySchemasChange(async () => {
      await env.repo.tx(async tx => {
        await tx.setProperty(id, propertyNameProp, '')
      }, {scope: ChangeScope.BlockDefault})
    })

    await vi.waitFor(() => {
      expect(env.service.getSchemaForBlockId(id)).toBeUndefined()
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })
})

describe('UserSchemasService workspace switch', () => {
  it('synchronously filters the old workspace bucket when the active workspace changes', async () => {
    env = await setup()
    await env.service.addSchema({name: 'workspace-only', presetId: 'url'})
    expect(env.repo.propertySchemas.get('workspace-only')?.codec.type).toBe('url')

    env.repo.setActiveWorkspaceId('ws-user-schemas-2')
    expect(env.repo.propertySchemas.get('workspace-only')).toBeUndefined()

    env.repo.setActiveWorkspaceId(WS)
    await vi.waitFor(() => {
      expect(env.repo.propertySchemas.get('workspace-only')?.codec.type).toBe('url')
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  // Regression for the in-flight-write cross-workspace leak surfaced in the
  // #90 adversarial review: addSchema pins the active workspace before its
  // first await, so a schema whose create/tx is still in flight when the user
  // switches workspaces (dispose → restart the projector on the new
  // workspace) is NOT published into the new workspace's 'user-data' bucket.
  // The projector's `disposed` flag alone can't catch this — the per-projector
  // container is reused and re-armed across the switch.
  it('does not leak an in-flight addSchema into a newly-switched workspace', async () => {
    env = await setup()
    // Kick off addSchema; its synchronous prologue pins the W1 workspace
    // before the first await (createChild).
    const pending = env.service.addSchema({name: 'leaky', presetId: 'url'})

    // The Repo pin synchronously tears down W1 and starts W2 projectors.
    const W2 = 'ws-user-schemas-2'
    env.repo.setActiveWorkspaceId(W2)
    await getOrCreatePropertiesPage(env.repo, W2)

    await pending
    // The W1 schema must not surface in W2's runtime view.
    expect(env.repo.propertySchemas.get('leaky')).toBeUndefined()
    expect(env.service.getSchemaBlockId('leaky')).toBeUndefined()
  })
})

describe('Repo.setFacetRuntime — runtime contribution survival', () => {
  it('user-data schema bucket survives a runtime swap', async () => {
    env = await setup()
    await env.service.addSchema({name: 'homepage', presetId: 'url'})
    expect(env.repo.propertySchemas.get('homepage')?.codec.type).toBe('url')

    // Swap to a fresh runtime that does NOT include the user-data
    // bucket explicitly. The bucket is persisted on Repo and replayed
    // onto the fresh runtime, so the schema must still be visible.
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
    ]))
    expect(env.repo.facetRuntime?.read(projectedPropertyDefinitionsFacet).size).toBe(1)
    expect(env.repo.propertyDefinitions?.definitionsByName.get('homepage')).toHaveLength(1)
    expect(env.repo.propertySchemas.get('homepage')?.codec.type).toBe('url')
  })

  it('drops removed-preset behavior during the runtime swap while retaining metadata', async () => {
    const pluginPreset = definePreset<string>({
      id: 'test-runtime-only-preset',
      label: 'Runtime only',
      build: () => codecs.string,
      defaultValue: '',
      Editor: (): JSX.Element => createElement('span', null, null),
    })
    env = await setup([pluginPreset])
    const id = await createExternalSchemaBlock('plugin:runtime-only', pluginPreset.id)
    expect(env.repo.propertySchemas.get('plugin:runtime-only')?.codec.type).toBe('string')

    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
    ]))

    expect(env.repo.propertyDefinitions?.definitionsByFieldId.get(id)?.name)
      .toBe('plugin:runtime-only')
    expect(env.repo.propertySchemas.has('plugin:runtime-only')).toBe(false)
  })

  it('direct setRuntimeContributions bucket survives a runtime swap', async () => {
    env = await setup()
    const pluginSchema = defineProperty<string | undefined>('plugin:custom', {
      codec: codecs.optionalString,
      defaultValue: undefined,
      changeScope: ChangeScope.BlockDefault,
    })
    env.repo.setRuntimeContributions(propertySchemasFacet, 'plugin', [pluginSchema])
    expect(env.repo.propertySchemas.get('plugin:custom')).toBe(pluginSchema)

    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
    ]))
    expect(env.repo.propertySchemas.get('plugin:custom')).toBe(pluginSchema)
  })

  it('addSchema concurrent with a runtime swap lands on the new runtime', async () => {
    env = await setup()
    // Kick off an addSchema; while the persisting tx is in flight,
    // race a setFacetRuntime swap. The persisted bucket should be
    // replayed onto the new runtime so the schema remains visible
    // regardless of which runtime won the race.
    const addPromise = env.service.addSchema({name: 'siteUrl', presetId: 'url'})
    env.repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
    ]))
    const schema = await addPromise
    expect(env.repo.propertySchemas.get('siteUrl')).toBe(schema)
  })
})

describe('UserSchemasService workspace switch', () => {
  it('clears the outgoing user-data bucket at the Repo workspace pin', async () => {
    env = await setup()
    await env.service.addSchema({name: 'homepage', presetId: 'url'})
    expect(env.repo.propertySchemas.get('homepage')?.codec.type).toBe('url')

    const W2 = 'ws-user-schemas-2'
    env.repo.setActiveWorkspaceId(W2)
    await getOrCreatePropertiesPage(env.repo, W2)
    expect(env.repo.propertySchemas.get('homepage')).toBeUndefined()
  })
})
