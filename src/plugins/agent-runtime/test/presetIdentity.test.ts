// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ChangeScope,
  CodecError,
  codecs,
  definePresetCore,
  type AnyValuePresetCore,
  type Codec,
} from '@/data/api'
import { valuePresetCoresFacet } from '@/data/facets'
import { kernelPropertyUiExtension } from '@/components/propertyEditors/typesPropertyUi'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { seedProperty } from '@/data/propertySeeds'
import { materializePropertySeeds, propertyDefinitionBlockId } from '@/data/definitionSeeds'
import { definitionSeedsFacet } from '@/data/facets'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { findPresetIdentityConflicts, presetIdentityRefusal } from '../presetIdentity'

const WS = 'ws-preset-identity'
const PRESET = 'demo:rating'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [kernelPropertyUiExtension, kernelValuePresetsExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
  await getOrCreatePropertiesPage(repo, WS)
})

/** Register `core` the way a running extension's contribution would be
 *  registered: through the facet runtime, which is what `repo.valuePresetCores`
 *  is rebuilt from. */
const register = (...cores: AnyValuePresetCore[]): void => {
  repo.setRuntimeContributions(valuePresetCoresFacet, 'test-preset-plugin', cores)
}

const numberRating = definePresetCore<number>({
  id: PRESET, build: () => codecs.number, defaultValue: 0,
})
const stringRating = definePresetCore<string>({
  id: PRESET, build: () => codecs.string, defaultValue: '',
})

/** Add a definition using `presetId` and put a cell under its name on `cells`
 *  ordinary blocks, so the conflict report has something to count. */
const addDefinitionWithCells = async (
  name: string,
  presetId: string,
  cells: number,
  config: unknown = undefined,
): Promise<string> => {
  const schema = await repo.userSchemas.addSchema({name, presetId, ...(config === undefined ? {} : {config})})
  await repo.tx(async tx => {
    for (let i = 0; i < cells; i += 1) {
      await tx.create({
        workspaceId: WS,
        parentId: null,
        orderKey: `a${i}`,
        content: `consumer ${i}`,
        properties: {[name]: 1},
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed consumers'})
  return schema.name
}

/** A definition row written directly, for the names `addSchema` refuses to
 *  mint twice. Written through `repo.tx` so the projector still sees it. */
const createDefinitionBlock = async (
  name: string, presetId: string, config: unknown = {},
): Promise<string> => {
  const id = await repo.mutate.createChild({parentId: repo.propertiesPageId!})
  await repo.tx(async tx => {
    await tx.update(id, {
      properties: {
        types: ['property-schema'],
        'property-schema:name': name,
        'property-schema:preset': presetId,
        'property-schema:config': config,
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed competing definition'})
  return id
}

describe('findPresetIdentityConflicts', () => {
  it('reports nothing for a preset id nothing is registered under', async () => {
    expect(await findPresetIdentityConflicts(repo, WS, [numberRating])).toEqual([])
  })

  it('reports nothing when the extension re-contributes the very same core', async () => {
    register(numberRating)
    expect(await findPresetIdentityConflicts(repo, WS, [numberRating])).toEqual([])
  })

  it('reports nothing when a rebuilt core publishes the same codec', async () => {
    register(numberRating)
    const rebuilt = definePresetCore<number>({
      id: PRESET,
      build: () => codecs.number,
      // A changed default is an ordinary edit: nothing stored is keyed or
      // encoded by it.
      defaultValue: 3,
    })
    expect(await findPresetIdentityConflicts(repo, WS, [rebuilt])).toEqual([])
  })

  it('reports a changed codec type with the definitions and cells at stake', async () => {
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 3)
    await addDefinitionWithCells('demo-score', PRESET, 1)
    // A definition on a different preset must not be counted.
    await addDefinitionWithCells('unrelated', 'string', 5)

    const [conflict, ...rest] = await findPresetIdentityConflicts(repo, WS, [stringRating])
    expect(rest).toEqual([])
    expect(conflict!.presetId).toBe(PRESET)
    expect(conflict!.differences).toEqual([
      'codec type "number" -> codec type "string" (at the preset default config)',
    ])
    expect(conflict!.definitions.map(d => [d.name, d.cells])).toEqual([
      ['demo-rating', 3],
      ['demo-score', 1],
    ])
    expect(conflict!.cells).toBe(4)
    expect(conflict!.replacesKernelCore).toBe(false)
  })

  it('reports a config codec whose type moved even when the value codec did not', async () => {
    const configCodec = <T extends string>(type: T): Codec<{n: number}> => ({
      type,
      encode: value => ({n: value.n}),
      decode: json => ({n: Number((json as {n?: unknown}).n ?? 0)}),
    })
    const before = definePresetCore<string, {n: number}>({
      id: PRESET,
      build: () => codecs.string,
      defaultValue: '',
      defaultConfig: {n: 1},
      configCodec: configCodec('demo:rating-config'),
    })
    const after = definePresetCore<string, {n: number}>({
      id: PRESET,
      build: () => codecs.string,
      defaultValue: '',
      defaultConfig: {n: 1},
      configCodec: configCodec('demo:rating-config-v2'),
    })
    register(before)

    const [conflict] = await findPresetIdentityConflicts(repo, WS, [after])
    expect(conflict!.differences).toEqual([
      'config codec demo:rating-config -> demo:rating-config-v2',
    ])
  })

  it('reports a core that can no longer read a config already stored', async () => {
    const lenient = definePresetCore<string, {mode: string}>({
      id: PRESET,
      build: () => codecs.string,
      defaultValue: '',
      defaultConfig: {mode: 'wide'},
      configCodec: {
        type: 'demo:rating-config',
        encode: value => ({mode: value.mode}),
        decode: json => ({mode: String((json as {mode?: unknown}).mode ?? 'wide')}),
      },
    })
    const strict = definePresetCore<string, {mode: string}>({
      id: PRESET,
      build: () => codecs.string,
      defaultValue: '',
      defaultConfig: {mode: 'wide'},
      configCodec: {
        type: 'demo:rating-config',
        encode: value => ({mode: value.mode}),
        decode: json => {
          const mode = (json as {mode?: unknown}).mode
          if (mode !== 'wide') throw new CodecError('mode "wide"', mode)
          return {mode: 'wide'}
        },
      },
    })
    register(lenient)
    await addDefinitionWithCells('demo-rating', PRESET, 2, {mode: 'narrow'})

    const [conflict] = await findPresetIdentityConflicts(repo, WS, [strict])
    // The default-config probe agrees; only the config a definition actually
    // stores separates the two, which is why the probe set includes it.
    expect(conflict!.differences).toHaveLength(1)
    expect(conflict!.differences[0]).toContain('at stored config {"mode":"narrow"}')
    expect(conflict!.differences[0]).toContain('config rejected')
    expect(conflict!.cells).toBe(2)
  })

  it('reports a build that throws rather than failing the install with it', async () => {
    register(numberRating)
    const broken = definePresetCore<string>({
      id: PRESET,
      build: () => { throw new Error('preset not configured') },
      defaultValue: '',
    })
    const [conflict] = await findPresetIdentityConflicts(repo, WS, [broken])
    expect(conflict!.differences).toEqual([
      'codec type "number" -> build threw (preset not configured) (at the preset default config)',
    ])
  })

  it('counts cells once for two definitions competing for one name', async () => {
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 3)
    // A second definition claiming the same name — the shape a shadowed
    // definition has. Its cells are the SAME cells, so the total must not
    // double them.
    await createDefinitionBlock('demo-rating', PRESET)

    const [conflict] = await findPresetIdentityConflicts(repo, WS, [stringRating])
    expect(conflict!.definitions).toHaveLength(2)
    expect(conflict!.definitions.map(d => d.cells)).toEqual([3, 3])
    expect(conflict!.cells).toBe(3)
  })

  it('probes a SCALAR config a definition stores', async () => {
    // A config is an arbitrary JSON value, not necessarily an object, and the
    // scan has to hand `build` the same value the projector would. These two
    // cores agree at the default config and part only at the stored one, so a
    // config read back as absent hides the whole conflict.
    const modeCodec: Codec<string> = {
      type: 'demo:mode',
      encode: value => value,
      decode: json => {
        if (typeof json !== 'string') throw new CodecError('mode string', json)
        return json
      },
    }
    const core = (narrowBuilds: Codec<unknown>) => definePresetCore<unknown, string>({
      id: PRESET,
      build: mode => mode === 'narrow' ? narrowBuilds : codecs.string,
      defaultValue: '',
      defaultConfig: 'wide',
      configCodec: modeCodec,
    })
    register(core(codecs.string))
    await createDefinitionBlock('demo-rating', PRESET, 'narrow')

    const [conflict] = await findPresetIdentityConflicts(repo, WS, [core(codecs.number)])
    expect(conflict?.differences).toEqual([
      'codec type "string" -> codec type "number" (at stored config "narrow")',
    ])
  })

  it('flags replacing a kernel core, which re-types definitions the extension never made', async () => {
    const shadowString = definePresetCore<number>({
      id: 'string', build: () => codecs.number, defaultValue: 0,
    })
    const [conflict] = await findPresetIdentityConflicts(repo, WS, [shadowString])
    expect(conflict!.presetId).toBe('string')
    expect(conflict!.replacesKernelCore).toBe(true)
    expect(presetIdentityRefusal([conflict!], '"demo"', WS)).toContain('KERNEL preset')
  })

  it("counts cells under a seeded definition's DECLARED name, not a drifted stored one", async () => {
    // The drift a seed RENAME leaves until the next materialization pass (and
    // that an older client's synced row carries indefinitely): the row stores
    // the old name, while the registry pins it to the declared one — which is
    // the name cells are keyed under. Built on its own Repo because the row can
    // only be written by the seed materializer, and the materializer run by a
    // Repo that DECLARES the new name would write the new name too.
    const seedKey = 'system:demo/property/drifted'
    const declare = (name: string) => seedProperty<number, void>({
      seedKey, revision: 1, name, preset: numberRating,
      defaultValue: 0, changeScope: ChangeScope.BlockDefault,
    })
    repo.setActiveWorkspaceId(null)
    let minted = 0
    const drifted = createTestRepo({
      db: sharedDb.db,
      user: {id: 'user-1'},
      newId: () => `drift-${++minted}`,
      extensions: [
        kernelPropertyUiExtension,
        kernelValuePresetsExtension,
        valuePresetCoresFacet.of(numberRating, {source: 'test-preset-plugin'}),
        definitionSeedsFacet.of(declare('demo:declared-rating'), {source: 'test-drift-seed'}),
      ],
    }).repo
    drifted.setActiveWorkspaceId(WS)
    await drifted.ensureSystemPages(WS)
    // Materialized from the OLD declaration, passed explicitly so the pass
    // writes that name rather than the one the runtime declares.
    await materializePropertySeeds(drifted, WS, [declare('demo:drifted-rating')])
    const fieldId = propertyDefinitionBlockId(WS, seedKey)
    await vi.waitFor(() => {
      expect(drifted.propertyDefinitions?.definitionsByFieldId.get(fieldId)?.name)
        .toBe('demo:declared-rating')
    }, {timeout: 2_000})

    await drifted.tx(async tx => {
      await tx.create({
        workspaceId: WS,
        parentId: null,
        orderKey: 'z1',
        content: 'consumer',
        properties: {'demo:declared-rating': 1},
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed drifted consumer'})

    const [conflict] = await findPresetIdentityConflicts(drifted, WS, [stringRating])
    expect(conflict!.definitions).toEqual([
      {fieldId, name: 'demo:declared-rating', cells: 1},
    ])
  })

  it('names seeds declaring the preset, whose rows may not exist yet', async () => {
    register(numberRating)
    const seed = seedProperty<number, void>({
      seedKey: 'system:demo/property/rating',
      revision: 1,
      name: 'demo:seeded-rating',
      preset: numberRating,
      defaultValue: 0,
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-preset-seed', [seed])

    const [conflict] = await findPresetIdentityConflicts(repo, WS, [stringRating])
    expect(conflict!.seedNames).toEqual(['demo:seeded-rating'])
  })
})

describe('presetIdentityRefusal', () => {
  it('states what moved, what it counts, and the ways out', async () => {
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 2)
    const conflicts = await findPresetIdentityConflicts(repo, WS, [stringRating])

    const message = presetIdentityRefusal(conflicts, '"Ratings"', WS)
    expect(message).toContain('refusing to install "Ratings"')
    expect(message).toContain('codec type "number" -> codec type "string"')
    expect(message).toContain('demo-rating (2 cells)')
    expect(message).toContain(WS)
    expect(message).toContain('--allow-preset-change')
  })
})
