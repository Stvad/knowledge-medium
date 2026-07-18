// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, definePresetCore, seedProperty } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import {
  addBlockTypeToProperties,
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeHideFromCompletionProp,
  blockTypeLabelProp,
  blockTypePropertiesProp,
  blockTypeTypeIdProp,
  aliasesProp,
  propertyNameProp,
  seedKeyProp,
} from '@/data/properties'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { materializePropertySeeds, propertyDefinitionBlockId, typeDefinitionBlockId } from '@/data/definitionSeeds'
import { definitionSeedsFacet } from '@/data/facets'
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
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [
      kernelPropertyUiExtension,
      kernelValuePresetsExtension,
    ],
  })
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
  await getOrCreateTypesPage(repo, WS)
  const service = repo.userTypes
  const dispose = (): void => repo.setActiveWorkspaceId(null)
  return {h, repo, service, dispose}
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => {
  // Dispose the per-test service; the shared DB closes once in afterAll.
  env.dispose()
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
  args: {
    label: string
    description?: string
    properties?: readonly string[]
    hideFromBlockDisplay?: boolean
    hideFromCompletion?: boolean
    color?: string
  },
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
    if (args.hideFromBlockDisplay !== undefined) {
      await tx.setProperty(id, blockTypeHideFromBlockDisplayProp, args.hideFromBlockDisplay)
    }
    if (args.hideFromCompletion !== undefined) {
      await tx.setProperty(id, blockTypeHideFromCompletionProp, args.hideFromCompletion)
    }
    if (args.color !== undefined) {
      await tx.setProperty(id, blockTypeColorProp, args.color)
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

  it('does not let a seed-valid /type/ row hijack a type id via a colliding claim', async () => {
    env = await setup()
    // Simulate a synced/imported block-type row that is a VALID seeded
    // definition: it sits at the deterministic id for a /type/ seed key and
    // claims an existing id ('page'). parseTypeDefinitionMetadata honors that
    // claim (it passes the id equation) and the projector publishes the full
    // metadata, but its `/type/` key is a FORGED foreign owner — NOT a current
    // code declaration (the real kernel `page` seed is
    // `system:kernel-data/type/page`, a different key) — so
    // `buildTypeDefinitionRegistry` demotes the row to its own block id rather
    // than binding the 'page' membership, closing the hijack the last-wins
    // typesFacet would otherwise allow. Created at Automation scope so the
    // seed-write backstop (BlockDefault-only) doesn't reject the mint.
    const seedKey = 'plugin:imposter/type/page'
    const blockId = typeDefinitionBlockId(WS, seedKey)
    // Mint the whole bag through tx.create (like the property materializer):
    // per-prop setProperty would reject a BlockDefault prop under an Automation
    // tx, and a BlockDefault tx would trip the seed-write backstop. Pre-populate
    // the row so it's already a completed type (block-type + PAGE_TYPE
    // membership, label, matching alias) — that keeps the same-tx typeify
    // processor a no-op (it would otherwise write alias at BlockDefault scope
    // and clash with this Automation tx), matching how a synced row arrives
    // already-completed.
    const properties = addBlockTypeToProperties(
      addBlockTypeToProperties({
        [seedKeyProp.name]: seedKeyProp.codec.encode(seedKey),
        [blockTypeLabelProp.name]: blockTypeLabelProp.codec.encode('Imported Page'),
        [blockTypeTypeIdProp.name]: blockTypeTypeIdProp.codec.encode('page'),
        [aliasesProp.name]: aliasesProp.codec.encode(['Imported Page']),
      }, BLOCK_TYPE_TYPE),
      PAGE_TYPE,
    )
    await env.repo.tx(async tx => {
      await tx.create({
        id: blockId,
        workspaceId: WS,
        parentId: env.repo.typesPageId!,
        orderKey: 'a0',
        content: 'Imported Page',
        properties,
      }, {systemMint: true})
    }, {scope: ChangeScope.Automation, description: 'simulate synced seed-valid type row'})

    // The contribution publishes under its own block id (an honored 'page'
    // claim would key it under 'page' instead and time this out).
    await waitForTypeRegistration(env.repo, blockId, 'Imported Page')
    expect(env.repo.types.get(blockId)!.id).toBe(blockId)
    // 'page' is not hijacked: the built-in kernel type is untouched, and the
    // registry never binds the 'page' membership id to this block.
    expect(env.repo.types.get('page')?.label).toBe('Page')
    expect(env.service.getTypeBlockId('page')).not.toBe(blockId)
  })

  it('lifts hide-from-completion onto the contribution and republishes on change', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Auto', hideFromCompletion: true})
    expect(env.repo.types.get(id)).toMatchObject({hideFromCompletion: true})
    // Flipping the flag must clear it on the contribution — pins the
    // hideFromCompletion arm of the projectedDefinitionsEqual dedup (else the republish
    // would be suppressed and the type would stay hidden from completion).
    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeHideFromCompletionProp, false)
    }, {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => {
      expect(env.repo.types.get(id)?.hideFromCompletion).toBeUndefined()
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('lifts hide-from-block-display and color onto the contribution, and republishes on change', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {
      label: 'Recipe',
      hideFromBlockDisplay: true,
      color: '#e11d48',
    })
    const contribution = env.repo.types.get(id)
    expect(contribution).toMatchObject({hideFromBlockDisplay: true, color: '#e11d48'})

    // Display config is live-editable, ONE FIELD AT A TIME — each step
    // pins its own field in the projectedDefinitionsEqual dedup (a combined
    // write would let either comparison vanish behind the other).
    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeColorProp, 'tomato')
    }, {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => {
      expect(env.repo.types.get(id)?.color).toBe('tomato')
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})

    await env.repo.tx(async tx => {
      await tx.setProperty(id, blockTypeHideFromBlockDisplayProp, false)
    }, {scope: ChangeScope.BlockDefault})
    await vi.waitFor(() => {
      const updated = env.repo.types.get(id)
      expect(updated?.color).toBe('tomato')
      expect(updated?.hideFromBlockDisplay).toBeUndefined()
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('a malformed display-config value degrades to defaults without unregistering the type', async () => {
    env = await setup()
    const bad = await createBlockTypeBlock(env.repo, {label: 'Bad', hideFromBlockDisplay: true})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // Simulate a bridge/import writing a string into the boolean prop
      // (bypassing the typed setter, as raw writers can). Display-only
      // props must not gate registration.
      await env.repo.tx(async tx => {
        const row = await tx.get(bad)
        await tx.update(bad, {
          properties: {...row!.properties, [blockTypeHideFromBlockDisplayProp.name]: 'true'},
        })
      }, {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => {
        const contribution = env.repo.types.get(bad)
        expect(contribution?.label).toBe('Bad')
        expect(contribution?.hideFromBlockDisplay).toBeUndefined()
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
    } finally {
      warn.mockRestore()
    }
  })

  it('a row whose projection throws (malformed label) is skipped without freezing the registry', async () => {
    env = await setup()
    const good = await createBlockTypeBlock(env.repo, {label: 'Good'})
    const bad = await createBlockTypeBlock(env.repo, {label: 'Bad'})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await env.repo.tx(async tx => {
        const row = await tx.get(bad)
        await tx.update(bad, {
          properties: {...row!.properties, [blockTypeLabelProp.name]: 42},
        })
      }, {scope: ChangeScope.BlockDefault})
      // The bad row degrades to skipped; the good one must still update.
      await env.repo.tx(async tx => {
        await tx.setProperty(good, blockTypeLabelProp, 'Good v2')
      }, {scope: ChangeScope.BlockDefault})
      await vi.waitFor(() => {
        expect(env.repo.types.get(good)?.label).toBe('Good v2')
        expect(env.repo.types.get(bad)).toBeUndefined()
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
    } finally {
      warn.mockRestore()
    }
  })

  it('omits hide-from-block-display and color when unset (defaults stay off the contribution)', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Plain'})
    const contribution = env.repo.types.get(id)!
    expect(contribution.hideFromBlockDisplay).toBeUndefined()
    expect(contribution.color).toBeUndefined()
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
    expect(contribution!.properties).toEqual([
      expect.objectContaining({
        fieldId: schemaBlockId,
        workspaceId: WS,
        name: schema.name,
        codec: schema.codec,
        defaultValue: schema.defaultValue,
        changeScope: schema.changeScope,
      }),
    ])
  })

  it('fills in a metadata-only seeded property when its declaration arrives later', async () => {
    env = await setup()
    const unregisteredPreset = definePresetCore<string>({
      id: 'test-late-metadata-only-seed',
      build: () => codecs.string,
      defaultValue: '',
    })
    const seed = seedProperty({
      seedKey: 'system:test/property/late-metadata-only',
      revision: 1,
      name: 'late-metadata-only',
      preset: unregisteredPreset,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const fieldId = propertyDefinitionBlockId(WS, seed.seedKey)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await materializePropertySeeds(env.repo, WS, [seed])
      await vi.waitFor(() => {
        const definitions = env.repo.propertyDefinitions
        expect(definitions?.definitionsByFieldId.get(fieldId)?.seedKey).toBe(seed.seedKey)
        expect(definitions?.schemasByFieldId.has(fieldId)).toBe(false)
        expect(definitions?.seedsByKey.has(seed.seedKey)).toBe(false)
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})

      const typeId = await createBlockTypeBlock(env.repo, {
        label: 'Late seeded type',
        properties: [fieldId],
      })
      expect(env.repo.types.get(typeId)?.properties).toEqual([])

      env.repo.setRuntimeContributions(definitionSeedsFacet, 'test-late-metadata-only-seed', [seed])
      await vi.waitFor(() => {
        expect(env.repo.types.get(typeId)?.properties).toEqual([
          expect.objectContaining({
            fieldId,
            workspaceId: WS,
            name: seed.name,
            codec: seed.codec,
            defaultValue: seed.defaultValue,
            changeScope: seed.changeScope,
          }),
        ])
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a seed the name winner over an earlier same-name user definition (no shadowing)', async () => {
    env = await setup()
    const userSchema = await env.repo.userSchemas.addSchema({
      name: 'shadowed-metadata-only',
      presetId: 'string',
    })
    const userFieldId = env.repo.userSchemas.getSchemaBlockId(userSchema.name)!
    const unregisteredPreset = definePresetCore<string>({
      id: 'test-shadowed-metadata-only-seed',
      build: () => codecs.string,
      defaultValue: '',
    })
    const seed = seedProperty({
      seedKey: 'system:test/property/shadowed-metadata-only',
      revision: 1,
      name: userSchema.name,
      preset: unregisteredPreset,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const seedFieldId = propertyDefinitionBlockId(WS, seed.seedKey)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      env.repo.setRuntimeContributions(
        definitionSeedsFacet,
        'test-shadowed-metadata-only-seed',
        [seed],
      )
      await materializePropertySeeds(env.repo, WS, [seed])
      await vi.waitFor(() => {
        const definitions = env.repo.propertyDefinitions
        // v1 no-shadowing: the seed wins its name; the earlier same-name user
        // schema is excluded from name selection.
        const winnerFieldId = definitions?.definitionsByName.get(seed.name)?.[0]?.fieldId
        expect(winnerFieldId).toBe(seedFieldId)
        expect(winnerFieldId).not.toBe(userFieldId)
        expect(definitions?.definitionsByFieldId.get(seedFieldId)?.seedKey).toBe(seed.seedKey)
        expect(definitions?.schemasByFieldId.has(seedFieldId)).toBe(false)
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})

      const typeId = await createBlockTypeBlock(env.repo, {
        label: 'Seeded type over a same-name user schema',
        properties: [seedFieldId],
      })
      // The seed wins its name, so the type's ref to the seed's field resolves
      // through the seed declaration's behavior and the property is included.
      const typeProps = env.repo.types.get(typeId)?.properties
      expect(typeProps).toHaveLength(1)
      expect(typeProps?.[0]?.name).toBe(seed.name)
    } finally {
      warn.mockRestore()
    }
  })

  it('pins a renamed metadata-only seed definition to its declared name', async () => {
    env = await setup()
    const unregisteredPreset = definePresetCore<string>({
      id: 'test-renamed-metadata-only-seed',
      build: () => codecs.string,
      defaultValue: '',
    })
    const seed = seedProperty({
      seedKey: 'system:test/property/renamed-metadata-only',
      revision: 1,
      name: 'metadata-only-before-rename',
      preset: unregisteredPreset,
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    const fieldId = propertyDefinitionBlockId(WS, seed.seedKey)
    // A raw name write to the seed's own row, as an older client or a sync from
    // one could persist. Seeds are non-renamable (rename deferred to #288), so
    // resolution must ignore the divergence and keep the declared name.
    const storedDivergence = 'metadata-only-after-rename'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      env.repo.setRuntimeContributions(definitionSeedsFacet, 'test-renamed-metadata-only-seed', [seed])
      await materializePropertySeeds(env.repo, WS, [seed])
      // The divergence originates from an older client / a sync, not a user edit
      // (the tx guard blocks user-scope seed-bag writes). Model that with an
      // Automation-scope whole-bag update — the same shape a synced row lands as
      // — which also avoids setProperty's per-property BlockDefault scope check.
      const current = await env.repo.db.get<{properties_json: string}>(
        'SELECT properties_json FROM blocks WHERE id = ?', [fieldId],
      )
      await env.repo.tx(async tx => {
        await tx.update(fieldId, {
          properties: {
            ...JSON.parse(current.properties_json),
            [propertyNameProp.name]: propertyNameProp.codec.encode(storedDivergence),
          },
        })
      }, {scope: ChangeScope.Automation})
      await vi.waitFor(() => {
        const definitions = env.repo.propertyDefinitions
        expect(definitions?.definitionsByFieldId.get(fieldId)?.name).toBe(seed.name)
        expect(definitions?.schemasByFieldId.has(fieldId)).toBe(false)
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})

      const typeId = await createBlockTypeBlock(env.repo, {
        label: 'Renamed seeded type',
        properties: [fieldId],
      })
      await vi.waitFor(() => {
        expect(env.repo.types.get(typeId)?.properties).toEqual([
          expect.objectContaining({
            fieldId,
            workspaceId: WS,
            name: seed.name,
            codec: seed.codec,
            defaultValue: seed.defaultValue,
            changeScope: seed.changeScope,
          }),
        ])
      }, {timeout: SUBSCRIPTION_TIMEOUT_MS})

      const targetId = await env.repo.mutate.createChild({parentId: env.repo.typesPageId!})
      await env.repo.addType(targetId, typeId, {[seed.name]: 'canonical value'})
      const properties = env.repo.block(targetId).peek()!.properties
      expect(properties[seed.name]).toBe('canonical value')
      expect(properties[storedDivergence]).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
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
      expect(env.repo.types.get(id)?.properties).toEqual([
        expect.objectContaining({
          fieldId: schemaBlockId,
          workspaceId: WS,
          name: schema.name,
          codec: schema.codec,
          defaultValue: schema.defaultValue,
          changeScope: schema.changeScope,
        }),
      ])
    }, {timeout: SUBSCRIPTION_TIMEOUT_MS})
  })

  it('stops cleanly at a null Repo pin: clears the bucket and later edits do not republish', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Person'})
    expect(env.repo.types.get(id)).toBeDefined()
    env.repo.setActiveWorkspaceId(null)
    // Dispose now clears the user-data bucket — the type is gone, not
    // simply frozen at its pre-dispose value (see workspace-switch race
    // fix below).
    expect(env.repo.types.get(id)).toBeUndefined()
    // A subsequent block edit MUST NOT trigger a republish from this
    // disposed instance (no leaking subscription).
    await env.repo.tx(async tx => {
      const row = await tx.get(id)
      if (!row) throw new Error('expected type row')
      await tx.update(id, {
        properties: {...row.properties, [blockTypeLabelProp.name]: 'Renamed'},
      })
    }, {scope: ChangeScope.BlockDefault})
    expect(env.repo.types.get(id)).toBeUndefined()
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

  it('terminates the feedback loop for a type WITH a resolved ref-typed property', async () => {
    // The zero-property case above never reaches projectedDefinitionsEqual's
    // property-array arm. A refList property is the churn case: its preset's
    // build() mints a fresh codec (and a fresh [] default) on EVERY schema-
    // projector rebuild, and that projector has no dedup, so an unrelated
    // property edit re-resolves the type's property to a reference-fresh-but-
    // equal schema. The field-wise dedup must still let the cascade settle
    // (a bounded extra rebuild), not recurse into a stack overflow.
    env = await setup()
    const tags = await env.repo.userSchemas.addSchema({name: 'tags', presetId: 'refList'})
    const tagsBlockId = env.repo.userSchemas.getSchemaBlockId(tags.name)!
    const typeId = await createBlockTypeBlock(env.repo, {
      label: 'Task',
      properties: [tagsBlockId],
    })
    expect(env.repo.types.get(typeId)?.properties).toHaveLength(1)

    // Editing an UNRELATED property-schema block fires onPropertySchemasChange
    // and republishes ALL schemas with fresh codecs.
    await expect(env.repo.userSchemas.addSchema({name: 'mood', presetId: 'string'}))
      .resolves.toBeDefined()
    // The type survives with its property intact.
    expect(env.repo.types.get(typeId)?.properties).toHaveLength(1)
  })
})

describe('UserTypesService workspace switch', () => {
  // Regression for reviewer feedback: Repo pinning starts userSchemas before
  // userTypes; on workspace switch the new
  // userSchemas service can publish before the new userTypes
  // subscription has loaded, firing onPropertySchemasChange. Before
  // the fix, UserTypesService would rebuild against the PREVIOUS
  // workspace's latestBlocks, briefly republishing its types into
  // typesFacet (cross-workspace leak). dispose() now drops
  // latestBlocks AND clears the user-data bucket, and the schemas-
  // listener rebuild is gated on the workspace-pinned subscription's
  // first tick.

  it('does not leak previous-workspace types after a Repo-pin switch', async () => {
    env = await setup()
    // Create a type block in workspace W1.
    const w1TypeBlockId = await createBlockTypeBlock(env.repo, {label: 'Person'})
    expect(env.repo.types.get(w1TypeBlockId)?.label).toBe('Person')

    const W2 = 'ws-user-types-2'
    env.repo.setActiveWorkspaceId(W2)
    await getOrCreatePropertiesPage(env.repo, W2)
    await getOrCreateTypesPage(env.repo, W2)

    // Mimics the React-effect remount sequence on workspace switch:
    // the new workspace's userSchemas publishes first, firing
    // onPropertySchemasChange. Pre-fix, that listener would rebuild
    // against the previous workspace's latestBlocks and republish
    // 'Person' into typesFacet under the new workspace. Post-fix it's
    // a no-op (subscriptionPrimed=false + latestBlocks=[] after dispose).
    await env.repo.userSchemas.addSchema({name: 'mood', presetId: 'string'})

    expect(env.repo.types.get(w1TypeBlockId)).toBeUndefined()
  })

  it('clears the user-data type bucket on a null Repo pin', async () => {
    env = await setup()
    const id = await createBlockTypeBlock(env.repo, {label: 'Person'})
    expect(env.repo.types.has(id)).toBe(true)
    env.repo.setActiveWorkspaceId(null)
    expect(env.repo.types.has(id)).toBe(false)
  })
})
