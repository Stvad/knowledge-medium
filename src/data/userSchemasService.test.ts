// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement, type JSX } from 'react'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ChangeScope, codecs, definePreset, defineProperty, type AnyValuePreset } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { propertySchemasFacet, valuePresetsFacet } from '@/data/facets'
import { propertyNameProp } from '@/data/properties'
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

const setup = async (extraPresets: readonly AnyValuePreset[] = []): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll); each test calls setup()
  // inline, so reset here gives the per-test clean slate.
  await resetTestDb(sharedDb.db)
  const { repo } = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
      ...extraPresets.map(p => valuePresetsFacet.of(p, {source: 'test'})),
    ],
  })
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
  const service = repo.userSchemas
  const dispose = service.start()
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

    // Mimic the production workspace switch that the React provider runs while
    // the tx is in flight: dispose the projector (tears down the W1
    // subscription + clears the bucket), activate W2, restart on W2.
    env.service.dispose()
    const W2 = 'ws-user-schemas-2'
    env.repo.setActiveWorkspaceId(W2)
    await getOrCreatePropertiesPage(env.repo, W2)
    env.service.start()

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

describe('UserSchemasService workspace switch', () => {
  // Regression: the Repo is a per-user singleton reused across workspace
  // switches, and setFacetRuntime carries the durable user-data bucket
  // forward (adoptDurableContributionsFrom). Before the fix, dispose() left
  // the bucket in place, so the previous workspace's user-defined property
  // schemas leaked into the next workspace until its subscription's first
  // rebuild. Mirrors the hardening UserTypesService already had.
  it('clears the user-data bucket on dispose so schemas do not leak into the next workspace', async () => {
    env = await setup()
    await env.service.addSchema({name: 'homepage', presetId: 'url'})
    expect(env.repo.propertySchemas.get('homepage')?.codec.type).toBe('url')

    // Workspace switch: dispose W1's service, switch the active workspace,
    // bootstrap its properties page, restart. W1's schema must be gone.
    env.service.dispose()
    expect(env.repo.propertySchemas.get('homepage')).toBeUndefined()

    const W2 = 'ws-user-schemas-2'
    env.repo.setActiveWorkspaceId(W2)
    await getOrCreatePropertiesPage(env.repo, W2)
    env.service.start()
    expect(env.repo.propertySchemas.get('homepage')).toBeUndefined()
  })
})
