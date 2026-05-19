// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { createElement, type JSX } from 'react'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { ChangeScope, codecs, definePreset, defineProperty, type AnyPropertySchema, type AnyValuePreset } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { propertySchemasFacet, valuePresetsFacet } from '@/data/facets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import type { UserSchemasService } from './userSchemasService'
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
  const service = repo.userSchemas
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
      Editor: (): JSX.Element => createElement('span', null, null),
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
    env = await setup()
    await expect(env.service.addSchema({
      name: 'related',
      presetId: 'refList',
      config: {targetTypes: ['ok', 42]},
    })).rejects.toThrow(/invalid config/)
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
    expect(env.repo.propertySchemas.get('homepage')?.codec.type).toBe('url')
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

describe('UserSchemasService.withProvisionalSchema', () => {
  const buildSchema = (name: string, defaultValue: string): AnyPropertySchema =>
    defineProperty<string | undefined>(name, {
      codec: codecs.optionalString,
      defaultValue,
      changeScope: ChangeScope.BlockDefault,
    })

  // The subscription started in `setup()` queues an initial microtask
  // that rebuilds contributions from `[]` blocks. Wait for it to fire
  // before the test seeds any provisional registrations, otherwise the
  // late tick wipes them and the assertion is checking a stale state.
  const drainInitialSubscriptionTick = async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  it('no prior registration + body succeeds → schema registered after; body result returned', async () => {
    env = await setup()
    await drainInitialSubscriptionTick()
    const schema = buildSchema('topic', 'first')
    const result = await env.service.withProvisionalSchema(schema, 'block-1', async () => 'ok')
    expect(result).toBe('ok')
    expect(env.repo.propertySchemas.get('topic')).toBe(schema)
    expect(env.service.getSchemaBlockId('topic')).toBe('block-1')
  })

  it('no prior registration + body throws → schema NOT registered after; error rethrown', async () => {
    env = await setup()
    await drainInitialSubscriptionTick()
    const schema = buildSchema('topic', 'first')
    const boom = new Error('tx failed')
    await expect(env.service.withProvisionalSchema(schema, 'block-1', async () => {
      throw boom
    })).rejects.toBe(boom)
    expect(env.repo.propertySchemas.get('topic')).toBeUndefined()
    expect(env.service.getSchemaBlockId('topic')).toBeUndefined()
  })

  it('prior registration exists + body succeeds → new schema is the live one after', async () => {
    env = await setup()
    await drainInitialSubscriptionTick()
    const prior = buildSchema('topic', 'prior')
    env.service.appendUserSchema(prior, 'block-prior')
    expect(env.repo.propertySchemas.get('topic')).toBe(prior)

    const next = buildSchema('topic', 'next')
    const result = await env.service.withProvisionalSchema(next, 'block-next', async () => 42)
    expect(result).toBe(42)
    expect(env.repo.propertySchemas.get('topic')).toBe(next)
    expect(env.service.getSchemaBlockId('topic')).toBe('block-next')
  })

  it('prior registration exists + body throws → prior schema is restored, not removed', async () => {
    env = await setup()
    await drainInitialSubscriptionTick()
    const prior = buildSchema('topic', 'prior')
    env.service.appendUserSchema(prior, 'block-prior')
    expect(env.repo.propertySchemas.get('topic')).toBe(prior)

    const next = buildSchema('topic', 'next')
    const boom = new Error('tx failed')
    await expect(env.service.withProvisionalSchema(next, 'block-next', async () => {
      throw boom
    })).rejects.toBe(boom)
    // Key invariant: rollback restores the prior contribution rather
    // than calling removeUserSchema unconditionally.
    expect(env.repo.propertySchemas.get('topic')).toBe(prior)
    expect(env.service.getSchemaBlockId('topic')).toBe('block-prior')
  })

  it('duplicate-name contributions + body throws → restores LIVE (last) schema, not the first', async () => {
    // rebuildFromBlocks can produce duplicate-name entries (one per
    // matching `property-schema` block); `propertySchemasFacet.combine`
    // is last-wins on duplicates and `nameToBlockId` is last-wins on
    // the block id. `peekContribution` must snapshot the LAST match so
    // a rollback can't pair an older schema with a newer block id.
    env = await setup()
    await drainInitialSubscriptionTick()

    const older = buildSchema('topic', 'older')
    const newer = buildSchema('topic', 'newer')
    // Simulate the duplicate-name state the subscription rebuild can
    // produce: two contributions with the same name in registration
    // order, `nameToBlockId` pinned to the latter block.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(env.service as any).contributions = [older, newer]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(env.service as any).nameToBlockId = new Map([['topic', 'block-newer']])
    env.repo.setRuntimeContributions(
      propertySchemasFacet, 'user-data', [older, newer],
    )
    expect(env.repo.propertySchemas.get('topic')).toBe(newer)
    expect(env.service.getSchemaBlockId('topic')).toBe('block-newer')

    const provisional = buildSchema('topic', 'provisional')
    const boom = new Error('tx failed')
    await expect(env.service.withProvisionalSchema(provisional, 'block-provisional', async () => {
      throw boom
    })).rejects.toBe(boom)
    // After rollback the live schema must be `newer` (paired with
    // `block-newer`) — restoring `older` paired with `block-newer`
    // would be the bug.
    expect(env.repo.propertySchemas.get('topic')).toBe(newer)
    expect(env.service.getSchemaBlockId('topic')).toBe('block-newer')
  })

  it('concurrent overlap (different blockId): A fails after B succeeds → A does NOT clobber B', async () => {
    // Two concurrent withProvisionalSchema calls for the same name:
    //   - A peeks prior=undefined, appends A.
    //   - B (simulated as a synchronous append from another caller)
    //     overwrites the live entry with schemaB / block-B.
    //   - A's tx body then throws.
    // Without the CAS guard, A's catch arm would call
    // `removeUserSchema('topic')` and wipe B's legitimately-live entry.
    //
    // Simulated synchronously (not via two concurrent repo.tx calls)
    // because PowerSync serializes writes — a real second tx inside A's
    // body would deadlock waiting on the outer's writer slot.
    env = await setup()
    await drainInitialSubscriptionTick()

    const schemaA = buildSchema('topic', 'A')
    const schemaB = buildSchema('topic', 'B')
    const boom = new Error('A tx failed')

    const aResult = await env.service.withProvisionalSchema(schemaA, 'block-A', async () => {
      env.service.appendUserSchema(schemaB, 'block-B')
      expect(env.repo.propertySchemas.get('topic')).toBe(schemaB)
      expect(env.service.getSchemaBlockId('topic')).toBe('block-B')
      throw boom
    }).catch(err => err)

    expect(aResult).toBe(boom)
    expect(env.repo.propertySchemas.get('topic')).toBe(schemaB)
    expect(env.service.getSchemaBlockId('topic')).toBe('block-B')
  })

  it('concurrent overlap (SAME blockId, different schema): A fails after B succeeds → A does NOT clobber B', async () => {
    // The blockId-only guard would falsely pass here because B reuses
    // A's blockId (retries / duplicate submits / re-registration of the
    // same property-schema block with a different codec). The token-
    // based CAS distinguishes A's appendUserSchema from B's even when
    // (name, blockId) coincide.
    env = await setup()
    await drainInitialSubscriptionTick()

    const sharedBlockId = 'block-shared'
    const schemaA = buildSchema('topic', 'A')
    const schemaB = buildSchema('topic', 'B')
    const boom = new Error('A tx failed')

    const aResult = await env.service.withProvisionalSchema(schemaA, sharedBlockId, async () => {
      env.service.appendUserSchema(schemaB, sharedBlockId)
      expect(env.repo.propertySchemas.get('topic')).toBe(schemaB)
      throw boom
    }).catch(err => err)

    expect(aResult).toBe(boom)
    // Key invariant: even though A and B share blockId, A's catch arm
    // must not roll back over B's registration. The token-based CAS
    // distinguishes them; a blockId-only check would falsely pass and
    // wipe B.
    expect(env.repo.propertySchemas.get('topic')).toBe(schemaB)
    expect(env.service.getSchemaBlockId('topic')).toBe(sharedBlockId)
  })
})
