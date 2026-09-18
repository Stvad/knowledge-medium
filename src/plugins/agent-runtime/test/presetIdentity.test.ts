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
import { kernelValuePresetCoresById } from '@/data/kernelValuePresetCores'
import {
  findPresetIdentityConflicts,
  presetIdentityRefusal,
  type PresetRegistryAfter,
} from '../presetIdentity'

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
  name: string, presetId: string, config: unknown = {}, omitConfig = false,
): Promise<string> => {
  const id = await repo.mutate.createChild({parentId: repo.propertiesPageId!})
  await repo.tx(async tx => {
    await tx.update(id, {
      properties: {
        types: ['property-schema'],
        'property-schema:name': name,
        'property-schema:preset': presetId,
        ...(omitConfig ? {} : {'property-schema:config': config}),
      },
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed competing definition'})
  return id
}

/** The effective-registry map the install path builds, for the ordinary case
 *  where the candidate simply re-registers these ids. */
const registryAfter = (...cores: AnyValuePresetCore[]): PresetRegistryAfter =>
  new Map(cores.map(core => [core.id, {core, seedConfigs: new Map()}]))

/** The same, for an id the candidate stops registering entirely. */
const registryDrops = (presetId: string, core?: AnyValuePresetCore): PresetRegistryAfter =>
  new Map([[presetId, {core, seedConfigs: new Map()}]])

/** Live `property-schema` rows in the workspace — the probe set's OTHER
 *  source, asserted at zero so a seed test cannot pass through a row. */
const readDefinitionCount = async (): Promise<number> => {
  const row = await repo.db.get<{n: number}>(
    `SELECT COUNT(*) AS n FROM blocks b
       JOIN block_types t ON t.block_id = b.id AND t.workspace_id = b.workspace_id
      WHERE t.type = 'property-schema' AND b.workspace_id = ? AND b.deleted = 0`,
    [WS],
  )
  return row?.n ?? 0
}

/** A config codec and a core whose BUILT codec depends on that config — the
 *  only shape in which a config probe can tell two cores apart, or one core
 *  apart from itself on a different config. */
const modeCodec: Codec<{mode: string}> = {
  type: 'demo:mode',
  encode: value => ({mode: value.mode}),
  decode: json => ({mode: String((json as {mode?: unknown}).mode ?? 'wide')}),
}
const modalCore = (whenNarrow: Codec<unknown>) => definePresetCore<unknown, {mode: string}>({
  id: PRESET,
  build: config => (config.mode === 'narrow' ? whenNarrow : codecs.string),
  defaultValue: '',
  defaultConfig: {mode: 'wide'},
  configCodec: modeCodec,
})

describe('findPresetIdentityConflicts', () => {
  it('reports nothing for a preset id nothing is registered under', async () => {
    expect((await findPresetIdentityConflicts(repo, WS, registryAfter(numberRating))).conflicts).toEqual([])
  })

  it('reports nothing when the extension re-contributes the very same core', async () => {
    register(numberRating)
    expect((await findPresetIdentityConflicts(repo, WS, registryAfter(numberRating))).conflicts).toEqual([])
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
    expect((await findPresetIdentityConflicts(repo, WS, registryAfter(rebuilt))).conflicts).toEqual([])
  })

  it('reports a changed codec type with the definitions and cells at stake', async () => {
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 3)
    await addDefinitionWithCells('demo-score', PRESET, 1)
    // A definition on a different preset must not be counted.
    await addDefinitionWithCells('unrelated', 'string', 5)

    const {conflicts: [conflict, ...rest]} = await findPresetIdentityConflicts(repo, WS, registryAfter(stringRating))
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
    const beforeCore = definePresetCore<string, {n: number}>({
      id: PRESET,
      build: () => codecs.string,
      defaultValue: '',
      defaultConfig: {n: 1},
      configCodec: configCodec('demo:rating-config'),
    })
    const afterCore = definePresetCore<string, {n: number}>({
      id: PRESET,
      build: () => codecs.string,
      defaultValue: '',
      defaultConfig: {n: 1},
      configCodec: configCodec('demo:rating-config-v2'),
    })
    register(beforeCore)

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, registryAfter(afterCore))
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

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, registryAfter(strict))
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
    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, registryAfter(broken))
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

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, registryAfter(stringRating))
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
    const scalarCore = (narrowBuilds: Codec<unknown>) => definePresetCore<unknown, string>({
      id: PRESET,
      build: mode => mode === 'narrow' ? narrowBuilds : codecs.string,
      defaultValue: '',
      defaultConfig: 'wide',
      configCodec: modeCodec,
    })
    register(scalarCore(codecs.string))
    await createDefinitionBlock('demo-rating', PRESET, 'narrow')

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(
      repo, WS, registryAfter(scalarCore(codecs.number)))
    expect(conflict?.differences).toEqual([
      'codec type "string" -> codec type "number" (at stored config "narrow")',
    ])
  })

  it('probes an ABSENT config and a stored null separately', async () => {
    // `rawPresetConfig` passes a stored `null` to the config codec and falls
    // back to the preset default only for an absent cell, so the two are
    // different inputs. Collapsing them let one definition's probe suppress the
    // other's, with no ordering guarantee over which.
    const modeCodec: Codec<string | null> = {
      type: 'demo:mode',
      encode: value => value,
      decode: json => (json === null ? null : String(json)),
    }
    const nullableCore = (whenNull: Codec<unknown>) => definePresetCore<unknown, string | null>({
      id: PRESET,
      build: mode => (mode === null ? whenNull : codecs.string),
      defaultValue: '',
      defaultConfig: 'wide',
      configCodec: modeCodec,
    })
    register(nullableCore(codecs.string))
    // Absent first, so a collapsed key would be claimed by it and the `null`
    // row — the one that actually separates the cores — never probed.
    await createDefinitionBlock('demo-absent', PRESET, undefined, true)
    await createDefinitionBlock('demo-null', PRESET, null)

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(
      repo, WS, registryAfter(nullableCore(codecs.number)))
    expect(conflict?.differences).toEqual([
      'codec type "string" -> codec type "number" (at stored config null)',
    ])
  })

  it('ignores changed error TEXT when both cores reject the same config', async () => {
    // Both leave `tryBuildSchema` returning null, so the definition stays
    // metadata-only and no stored value changes interpretation. Comparing the
    // message would refuse an update that only reworded a validation error.
    const rejecting = (message: string) => definePresetCore<string, {mode: string}>({
      id: PRESET,
      build: () => codecs.string,
      defaultValue: '',
      defaultConfig: {mode: 'wide'},
      configCodec: {
        type: 'demo:rating-config',
        encode: value => ({mode: value.mode}),
        decode: () => { throw new CodecError(message, null) },
      },
    })
    register(rejecting('mode must be wide'))
    await createDefinitionBlock('demo-rating', PRESET, {mode: 'narrow'})

    const {conflicts} = await findPresetIdentityConflicts(
      repo, WS, registryAfter(rejecting('mode has to be "wide"')))
    expect(conflicts).toEqual([])
  })

  it('still reports a core that BECOMES unavailable', async () => {
    // The other side of the same comparison: going from a published codec to
    // none is a real change, so only the message is discarded, not the kind.
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 1)
    const broken = definePresetCore<string>({
      id: PRESET,
      build: () => { throw new Error('not configured') },
      defaultValue: '',
    })
    const {conflicts: [conflict]} = await findPresetIdentityConflicts(
      repo, WS, registryAfter(broken))
    expect(conflict?.differences).toEqual([
      'codec type "number" -> build threw (not configured) (at the preset default config)',
    ])
  })

  it("probes a SEED's declared config, materialized row or not", async () => {
    // A seed already supplies the schema its cells are written under before its
    // definition row exists, so a candidate that preserves the codec at the
    // default and changes it at the seed's config must not pass.
    // `seedProperty` requires an encoded config to be a JSON object, so this
    // one is shaped the way a real seed's would be.
    const registered = modalCore(codecs.string)
    register(registered)
    const seed = seedProperty<unknown, {mode: string}>({
      seedKey: 'system:demo/property/narrow-rating',
      revision: 1,
      name: 'demo:narrow-rating',
      preset: registered,
      config: {mode: 'narrow'},
      defaultValue: '',
      changeScope: ChangeScope.BlockDefault,
    })
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-narrow-seed', [seed])
    // No definition row and no cells — the seed declaration alone is the reason
    // this config is in use.
    expect(await readDefinitionCount()).toBe(0)

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, new Map([
      [PRESET, {core: modalCore(codecs.number), seedConfigs:
        new Map([['system:demo/property/narrow-rating', {mode: 'narrow'}]])}],
    ]))
    expect(conflict?.differences).toEqual([
      'codec type "string" -> codec type "number" '
      + '(at the config seed "system:demo/property/narrow-rating" declares)',
    ])
  })

  it("probes a config the CANDIDATE's seed introduces", async () => {
    // The mirror of the previous case. The registry carries what the seeds
    // declare TODAY; an update that moves a seed onto a new config publishes it
    // from the declaration, so that config is in use the moment it loads and
    // nothing compared the core against it.
    const registered = modalCore(codecs.string)
    register(registered)
    // The seed live TODAY sits on `wide`, where both cores agree.
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-wide-seed', [
      seedProperty<unknown, {mode: string}>({
        seedKey: 'system:demo/property/wide-rating',
        revision: 1,
        name: 'demo:wide-rating',
        preset: registered,
        config: {mode: 'wide'},
        defaultValue: '',
        changeScope: ChangeScope.BlockDefault,
      }),
    ])

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, new Map([
      [PRESET, {core: modalCore(codecs.number), seedConfigs:
        new Map([['system:demo/property/wide-rating', {mode: 'narrow'}]])}],
    ]))
    expect(conflict?.differences).toEqual([
      'codec type "string" -> codec type "number" '
      + '(at the config seed "system:demo/property/wide-rating" declares)',
    ])
  })

  it("compares a seed's config against its OWN previous one, not the other core's", async () => {
    // The core does not move at all — the update re-contributes the very same
    // object — and the SEED moves onto a config where that one core builds a
    // different codec. Probing a flat set of configs against the two cores
    // cannot see this: at every config the two agree, because they are one
    // core. The pair that matters is the seed's own before and after.
    const modeCodec: Codec<{mode: string}> = {
      type: 'demo:mode',
      encode: value => ({mode: value.mode}),
      decode: json => ({mode: String((json as {mode?: unknown}).mode ?? 'wide')}),
    }
    const registered = definePresetCore<unknown, {mode: string}>({
      id: PRESET,
      build: config => (config.mode === 'narrow' ? codecs.number : codecs.string),
      defaultValue: '',
      defaultConfig: {mode: 'wide'},
      configCodec: modeCodec,
    })
    register(registered)
    repo.setRuntimeContributions(definitionSeedsFacet, 'test-moving-seed', [
      seedProperty<unknown, {mode: string}>({
        seedKey: 'system:demo/property/moving-rating',
        revision: 1,
        name: 'demo:moving-rating',
        preset: registered,
        config: {mode: 'wide'},
        defaultValue: '',
        changeScope: ChangeScope.BlockDefault,
      }),
    ])

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, new Map([
      // The SAME core object, which is also what makes the `current === next`
      // fast path unable to short-circuit here.
      [PRESET, {core: registered, seedConfigs:
        new Map([['system:demo/property/moving-rating', {mode: 'narrow'}]])}],
    ]))
    expect(conflict?.differences).toEqual([
      'codec type "string" -> codec type "number" '
      + '(at the config seed "system:demo/property/moving-rating" declares)',
    ])
  })

  it('says so in the refusal when this device\'s view of the workspace is short', async () => {
    // The counts come from LOCAL rows, so a durable sync gap makes them an
    // undercount. Reporting that basis is what makes the residual acceptable
    // rather than a silent one — the refusal has to carry it.
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 2)
    vi.spyOn(repo, 'workspaceViewGap').mockResolvedValue({
      reason: '3 synced row(s) have not reached blocks on this device',
      transient: false,
    })

    const scan = await findPresetIdentityConflicts(repo, WS, registryAfter(stringRating))
    expect(scan.syncGap).toBe('3 synced row(s) have not reached blocks on this device')
    expect(presetIdentityRefusal(scan, '"Ratings"', WS))
      .toContain('This device\'s view is incomplete')
  })

  it('does not count cells on a TOMBSTONED consumer block', async () => {
    // The refusal prints these counts and says outright that tombstones are
    // not among them. The cell scan reads `blocks` directly, with no join to
    // exclude a deleted one.
    register(numberRating)
    const name = await addDefinitionWithCells('demo-rating', PRESET, 3)
    const [doomed] = await repo.db.getAll<{id: string}>(
      `SELECT b.id FROM blocks b, json_each(b.properties_json) j
        WHERE b.workspace_id = ? AND b.deleted = 0 AND j.key = ? LIMIT 1`,
      [WS, name],
    )
    await repo.mutate.delete({id: doomed!.id})

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(
      repo, WS, registryAfter(stringRating))
    expect(conflict!.cells).toBe(2)
  })

  it('ignores a TOMBSTONED definition, in both the probe set and the counts', async () => {
    // A deleted row is not a consumer: its stored config must not enter the
    // probe set, where a dead row could invent a refusal all by itself.
    register(modalCore(codecs.string))
    // The ONLY row on the contested config, and it is deleted. Nothing else
    // distinguishes the two cores, so a conflict here could only come from it.
    const deadId = await createDefinitionBlock('demo-dead', PRESET, {mode: 'narrow'})
    await repo.mutate.delete({id: deadId})

    const {conflicts} = await findPresetIdentityConflicts(
      repo, WS, registryAfter(modalCore(codecs.number)))
    expect(conflicts).toEqual([])
  })

  it('reports an id whose core goes away entirely', async () => {
    // The drop direction: the extension stops contributing an id nothing else
    // claims, so every definition using it publishes no schema at all.
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 2)

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(
      repo, WS, registryDrops(PRESET))
    expect(conflict!.differences).toEqual([
      'codec type "number" -> no core registers this id '
      + '(every definition using it publishes no schema, so its cells read as unset)',
    ])
    expect(conflict!.cells).toBe(2)
  })

  it('reports an id that falls back to the core underneath it', async () => {
    // The same drop, where a kernel core was being shadowed: the id keeps
    // resolving, to a different codec, and nothing about the candidate says so.
    const shadowString = definePresetCore<number>({
      id: 'string', build: () => codecs.number, defaultValue: 0,
    })
    register(shadowString)
    await addDefinitionWithCells('demo-text', 'string', 1)

    const kernelString = kernelValuePresetCoresById.string
    const {conflicts: [conflict]} = await findPresetIdentityConflicts(
      repo, WS, registryDrops('string', kernelString))
    expect(conflict!.differences).toEqual([
      'codec type "number" -> codec type "string" (at the preset default config)',
    ])
  })

  it('flags replacing a kernel core, which re-types definitions the extension never made', async () => {
    const shadowString = definePresetCore<number>({
      id: 'string', build: () => codecs.number, defaultValue: 0,
    })
    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, registryAfter(shadowString))
    expect(conflict!.presetId).toBe('string')
    expect(conflict!.replacesKernelCore).toBe(true)
    expect(presetIdentityRefusal({conflicts: [conflict!], syncGap: null}, '"demo"', WS))
      .toContain('KERNEL preset')
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

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(drifted, WS, registryAfter(stringRating))
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

    const {conflicts: [conflict]} = await findPresetIdentityConflicts(repo, WS, registryAfter(stringRating))
    expect(conflict!.seedNames).toEqual(['demo:seeded-rating'])
  })
})

describe('presetIdentityRefusal', () => {
  it('states what moved, what it counts, and the ways out', async () => {
    register(numberRating)
    await addDefinitionWithCells('demo-rating', PRESET, 2)
    const scan = await findPresetIdentityConflicts(repo, WS, registryAfter(stringRating))

    const message = presetIdentityRefusal(scan, '"Ratings"', WS)
    expect(message).toContain('refusing to install "Ratings"')
    expect(message).toContain('codec type "number" -> codec type "string"')
    expect(message).toContain('demo-rating (2 cells)')
    expect(message).toContain(WS)
    expect(message).toContain('--allow-preset-change')
  })
})
