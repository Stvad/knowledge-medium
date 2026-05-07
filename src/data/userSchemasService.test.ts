// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope, codecs, definePreset, type AnyValuePreset, type RefCodecOptions } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { valuePresetsFacet } from '@/data/facets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { UserSchemasService } from './userSchemasService'
import { Repo } from './repo'

const WS = 'ws-user-schemas'

interface Harness {
  h: TestDb
  repo: Repo
  service: UserSchemasService
  dispose: () => void
}

const setup = async (extraPresets: readonly AnyValuePreset[] = []): Promise<Harness> => {
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
    ...extraPresets.map(p => valuePresetsFacet.of(p, {source: 'test'})),
  ]))
  await getOrCreatePropertiesPage(repo, WS)
  const service = new UserSchemasService(repo)
  const dispose = service.start()
  return {h, repo, service, dispose}
}

let env: Harness
afterEach(async () => {
  env.dispose()
  await env.h.cleanup()
})

describe('UserSchemasService.addSchema', () => {
  it('persists a property-schema block AND registers the schema synchronously', async () => {
    env = await setup()
    const schema = await env.service.addSchema({name: 'homepage', presetId: 'url'})
    expect(schema.name).toBe('homepage')
    expect(schema.codec.type).toBe('url')
    // Synchronous: visible in repo.propertySchemas before any subscription tick.
    expect(env.repo.propertySchemas.get('homepage')).toBe(schema)
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
})

describe('UserSchemasService subscription', () => {
  it('rebuilds the contribution list when a schema block is created externally', async () => {
    env = await setup()
    // Add the schema block directly through a tx (simulates a sync arrival).
    const propertiesPageId = env.repo.propertiesPageId!
    const id = await env.repo.mutate.createChild({parentId: propertiesPageId})
    await env.repo.tx(async tx => {
      await tx.update(id, {
        properties: {
          types: ['property-schema'],
          'property-schema:name': 'tags',
          'property-schema:preset': 'string',
          'property-schema:config': {},
        },
      })
    }, {scope: ChangeScope.BlockDefault})

    // Subscription is async — wait briefly for it to fire.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(env.repo.propertySchemas.get('tags')?.codec.type).toBe('string')
  })

  it('skips schemas with unknown preset ids and re-resolves when the preset shows up later', async () => {
    env = await setup()
    const propertiesPageId = env.repo.propertiesPageId!
    const id = await env.repo.mutate.createChild({parentId: propertiesPageId})
    await env.repo.tx(async tx => {
      await tx.update(id, {
        properties: {
          types: ['property-schema'],
          'property-schema:name': 'priority',
          'property-schema:preset': 'priority-preset',
          'property-schema:config': {},
        },
      })
    }, {scope: ChangeScope.BlockDefault})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(env.repo.propertySchemas.get('priority')).toBeUndefined()

    // Plugin loads and contributes the missing preset → schema resolves on the
    // valuePresets-change tick.
    const priorityPreset = definePreset<string>({
      id: 'priority-preset',
      label: 'Priority',
      build: () => codecs.string,
      defaultValue: 'low',
      Editor: () => null as unknown as JSX.Element,
    })
    env.repo.setRuntimeContributions(valuePresetsFacet, 'plugin', [priorityPreset])
    expect(env.repo.propertySchemas.get('priority')?.codec.type).toBe('string')
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
    env = await setup<RefCodecOptions>()
    await expect(env.service.addSchema({
      name: 'related',
      presetId: 'refList',
      config: {targetTypes: ['ok', 42]},
    })).rejects.toThrow(/invalid config/)
  })
})
