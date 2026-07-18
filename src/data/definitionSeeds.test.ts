// @vitest-environment node
import {v5 as uuidv5} from 'uuid'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, seedProperty, SeededDefinitionWriteError} from '@/data/api'
import {
  canonicalPropertySeedProperties,
  canonicalTypeSeedProperties,
  awaitPropertySeedMaterializationAccess,
  DEFINITION_SEED_NS,
  isValidSeededDefinition,
  materializePropertySeeds,
  materializeTypeSeeds,
  propertyDefinitionBlockId,
  typeDefinitionBlockId,
} from '@/data/definitionSeeds'
import {
  aliasesProp,
  blockTypeColorProp,
  blockTypeDescriptionProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeHideFromCompletionProp,
  blockTypeLabelProp,
  blockTypeTypeIdProp,
  getAliases,
  getBlockTypes,
  propertyDefaultProp,
  propertyHiddenProp,
  propertyNameProp,
  seedKeyProp,
  seedRevisionProp,
} from '@/data/properties'
import {propertiesPageBlockId} from '@/data/propertiesPage'
import {typesPageBlockId} from '@/data/typesPage'
import {seedType} from '@/data/typeSeeds'
import {buildTypeDefinitionRegistry} from '@/data/typeDefinitionRegistry'
import {typeSeedsFacet} from '@/data/facets'
import {BLOCK_TYPE_TYPE, PAGE_TYPE} from '@/data/blockTypes'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'

const WS = 'ws-seeds'
const OTHER_WS = 'ws-other'
const seed = seedProperty({
  seedKey: 'system:test/property/title',
  revision: 2,
  name: 'test:title',
  preset: 'string',
  defaultValue: 'untitled',
  changeScope: ChangeScope.UserPrefs,
  hidden: true,
})
const seedWithoutDefault = seedProperty({
  seedKey: 'system:test/property/count',
  revision: 1,
  name: 'test:count',
  preset: 'number',
  changeScope: ChangeScope.BlockDefault,
})
const typeSeed = seedType({
  seedKey: 'system:test/type/widget',
  revision: 1,
  id: 'test-widget',
  label: 'Widget',
  description: 'a test widget type',
  color: 'tomato',
  hideFromCompletion: true,
  // hideFromBlockDisplay deliberately omitted
})
const seedWithExplicitAbsence = seedProperty({
  seedKey: 'system:test/property/subtitle',
  revision: 1,
  name: 'test:subtitle',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(() => { vi.restoreAllMocks() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.ensureSystemPages(WS)
})

describe('property definition identity and payload', () => {
  it('derives stable workspace-scoped ids and validates seed provenance by equation', () => {
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    expect(propertyDefinitionBlockId(WS, seed.seedKey)).toBe(id)
    expect(propertyDefinitionBlockId(OTHER_WS, seed.seedKey)).not.toBe(id)
    expect(isValidSeededDefinition({
      id,
      workspaceId: WS,
      properties: {[seedKeyProp.name]: seed.seedKey},
    })).toBe(true)
    expect(isValidSeededDefinition({
      id: 'wrong-id',
      workspaceId: WS,
      properties: {[seedKeyProp.name]: seed.seedKey},
    })).toBe(false)
    // A row whose id DOES satisfy the deterministic formula for its stored key,
    // yet the key isn't valid seed grammar — must still be rejected on the
    // grammar gate, not the id-equation. `propertyDefinitionBlockId` now throws
    // on a non-`/property/` key, so compute the formula id directly to stand in
    // for such a row arriving via sync/corruption.
    expect(isValidSeededDefinition({
      id: uuidv5(`${WS}:malformed-key`, DEFINITION_SEED_NS),
      workspaceId: WS,
      properties: {[seedKeyProp.name]: 'malformed-key'},
    })).toBe(false)
  })

  it('validates a /type/-grammar seed row by the same equation, and rejects one at the wrong id', () => {
    const typeSeedKey = 'system:kernel-data/type/page'
    const id = typeDefinitionBlockId(WS, typeSeedKey)
    expect(isValidSeededDefinition({
      id,
      workspaceId: WS,
      properties: {[seedKeyProp.name]: typeSeedKey},
    })).toBe(true)
    expect(isValidSeededDefinition({
      id: 'wrong-id',
      workspaceId: WS,
      properties: {[seedKeyProp.name]: typeSeedKey},
    })).toBe(false)
  })

  it('throws on a non-property seed key (grammar invariant enforced at the call site)', () => {
    // The formula is shared with typeDefinitionBlockId under one namespace; the
    // guard makes a wrong-kind key fail loud instead of silently minting a
    // colliding id.
    expect(() => propertyDefinitionBlockId(WS, 'system:kernel-data/type/page'))
      .toThrow(/not a property seed key/)
    expect(() => propertyDefinitionBlockId(WS, 'malformed-key')).toThrow(/not a property seed key/)
  })

  it('canonically includes explicit defaults and omits absent defaults', () => {
    const explicit = canonicalPropertySeedProperties(seed)
    const omitted = canonicalPropertySeedProperties(seedWithoutDefault)
    const explicitAbsence = canonicalPropertySeedProperties(seedWithExplicitAbsence)

    expect(explicit[propertyNameProp.name]).toBe('test:title')
    expect(explicit[propertyDefaultProp.name]).toBe('untitled')
    expect(explicit[propertyHiddenProp.name]).toBe(true)
    expect(explicit[seedKeyProp.name]).toBe(seed.seedKey)
    expect(explicit[seedRevisionProp.name]).toBe(2)
    expect(propertyDefaultProp.name in omitted).toBe(false)
    expect(explicitAbsence[propertyDefaultProp.name]).toBeNull()
    const rawDefault = propertyDefaultProp.codec.decode(explicitAbsence[propertyDefaultProp.name])
    expect(rawDefault).toBeNull()
    expect(seedWithExplicitAbsence.codec.decode(rawDefault)).toBeUndefined()
  })
})

describe('materializePropertySeeds', () => {
  it('creates missing definitions under Properties and a second pass writes nothing', async () => {
    const getAll = vi.spyOn(repo.db, 'getAll')
    const first = await materializePropertySeeds(repo, WS, [seed, seedWithoutDefault])
    expect(first).toEqual({created: 2, restored: 0, skippedReadOnly: false})
    expect(getAll.mock.calls.filter(([sql]) => String(sql).includes('WHERE id IN'))).toHaveLength(1)

    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    const row = await sharedDb.db.get<{parent_id: string; properties_json: string; updated_at: number}>(
      'SELECT parent_id, properties_json, updated_at FROM blocks WHERE id = ?', [id],
    )
    expect(row.parent_id).toBe(propertiesPageBlockId(WS))
    expect(JSON.parse(row.properties_json)).toMatchObject(canonicalPropertySeedProperties(seed))
    expect(row.updated_at).toBe(0)
    const commands = await sharedDb.db.getAll<{scope: string}>(
      'SELECT scope FROM command_events WHERE description = ?',['materialize property definitions'],
    )
    expect(commands).toEqual([{scope: ChangeScope.Automation}])

    const commandsBefore = await sharedDb.db.get<{count: number}>('SELECT COUNT(*) AS count FROM command_events')
    const second = await materializePropertySeeds(repo, WS, [seed, seedWithoutDefault])
    const commandsAfter = await sharedDb.db.get<{count: number}>('SELECT COUNT(*) AS count FROM command_events')
    expect(second).toEqual({created: 0, restored: 0, skippedReadOnly: false})
    expect(commandsAfter.count).toBe(commandsBefore.count)
  })

  it('restores a tombstone without repairing its stale or tampered bag', async () => {
    await materializePropertySeeds(repo, WS, [seed])
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    const tampered = {
      ...canonicalPropertySeedProperties(seed),
      [propertyNameProp.name]: 'tampered',
      [seedRevisionProp.name]: 1,
    }
    // A tampered/tombstoned seed row can only originate from sync or a legacy
    // client — the tx guard blocks user (BlockDefault) seed-bag edits/deletes —
    // so simulate that non-user origin with the Automation scope it's allowed
    // under.
    await repo.tx(async tx => {
      await tx.update(id, {properties: tampered})
      await tx.delete(id)
    }, {scope: ChangeScope.Automation})

    const result = await materializePropertySeeds(repo, WS, [seed])
    const row = await sharedDb.db.get<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(result).toEqual({created: 0, restored: 1, skippedReadOnly: false})
    expect(row.deleted).toBe(0)
    expect(JSON.parse(row.properties_json)).toEqual(tampered)
  })

  it('only diagnoses stale live rows and does not patch them', async () => {
    await materializePropertySeeds(repo, WS, [seed])
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    // A stale synced/legacy row (revision 1 while code is at 2), written under
    // Automation — not a (guarded) user edit. update() writes the whole bag the
    // way materialization does, avoiding the per-property BlockDefault
    // scope-consistency check that setProperty enforces.
    await repo.tx(tx => tx.update(id, {
      properties: {
        ...canonicalPropertySeedProperties(seed),
        [seedRevisionProp.name]: seedRevisionProp.codec.encode(1),
      },
    }), {scope: ChangeScope.Automation})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = await sharedDb.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [id])

    await materializePropertySeeds(repo, WS, [seed])

    const after = await sharedDb.db.get<{properties_json: string}>('SELECT properties_json FROM blocks WHERE id = ?', [id])
    expect(after.properties_json).toBe(before.properties_json)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('revision 1 trails code revision 2'))
    warn.mockRestore()
  })

  it('skips read-only repos explicitly', async () => {
    repo.setReadOnly(true)
    expect(await materializePropertySeeds(repo, WS, [seed])).toEqual({
      created: 0,
      restored: 0,
      skippedReadOnly: true,
    })
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?', [propertyDefinitionBlockId(WS, seed.seedKey)]))
      .toBeNull()
  })

  it('rejects a live deterministic-id occupant from another workspace', async () => {
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await repo.tx(tx => tx.create({
      id,
      workspaceId: OTHER_WS,
      parentId: null,
      orderKey: 'a0',
      content: 'foreign live row',
    }), {scope: ChangeScope.BlockDefault})

    await expect(materializePropertySeeds(repo, WS, [seed])).rejects.toThrow(
      `seed id ${id} belongs to workspace ${OTHER_WS}`,
    )
    expect((await repo.db.get<{workspace_id: string; deleted: number}>(
      'SELECT workspace_id, deleted FROM blocks WHERE id = ?', [id],
    ))).toEqual({workspace_id: OTHER_WS, deleted: 0})
  })

  it('never restores a tombstoned deterministic-id occupant from another workspace', async () => {
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await repo.tx(async tx => {
      await tx.create({
        id,
        workspaceId: OTHER_WS,
        parentId: null,
        orderKey: 'a0',
        content: 'foreign tombstone',
      })
      await tx.delete(id)
    }, {scope: ChangeScope.BlockDefault})

    await expect(materializePropertySeeds(repo, WS, [seed])).rejects.toThrow(
      `seed id ${id} belongs to workspace ${OTHER_WS}`,
    )
    expect((await repo.db.get<{workspace_id: string; deleted: number}>(
      'SELECT workspace_id, deleted FROM blocks WHERE id = ?', [id],
    ))).toEqual({workspace_id: OTHER_WS, deleted: 1})
  })

  it('rejects a live deterministic-id occupant with the wrong seed provenance', async () => {
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await repo.tx(tx => tx.create({
      id,
      workspaceId: WS,
      parentId: propertiesPageBlockId(WS),
      orderKey: 'a0',
      content: 'wrong provenance',
      properties: {
        ...canonicalPropertySeedProperties(seed),
        [seedKeyProp.name]: 'system:test/property/impostor',
      },
    }), {scope: ChangeScope.BlockDefault})

    await expect(materializePropertySeeds(repo, WS, [seed])).rejects.toThrow(
      `seed id ${id} does not carry expected seed key ${seed.seedKey}`,
    )
  })

  it('aborts the whole batch before writing when any deterministic id is poisoned', async () => {
    const poisonedId = propertyDefinitionBlockId(WS, seed.seedKey)
    const untouchedId = propertyDefinitionBlockId(WS, seedWithoutDefault.seedKey)
    await repo.tx(tx => tx.create({
      id: poisonedId,
      workspaceId: WS,
      parentId: propertiesPageBlockId(WS),
      orderKey: 'a0',
      content: 'wrong provenance',
      properties: {
        ...canonicalPropertySeedProperties(seed),
        [seedKeyProp.name]: 'system:test/property/impostor',
      },
    }), {scope: ChangeScope.BlockDefault})

    await expect(materializePropertySeeds(repo, WS, [seedWithoutDefault, seed]))
      .rejects.toThrow(`seed id ${poisonedId} does not carry expected seed key ${seed.seedKey}`)
    expect(await repo.db.getOptional('SELECT id FROM blocks WHERE id = ?', [untouchedId])).toBeNull()
  })

  it('revalidates every seed in the write transaction before materializing any', async () => {
    await materializePropertySeeds(repo, WS, [seed])
    const poisonedId = propertyDefinitionBlockId(WS, seed.seedKey)
    const untouchedId = propertyDefinitionBlockId(WS, seedWithoutDefault.seedKey)
    const originalGetAll = repo.db.getAll.bind(repo.db)
    vi.spyOn(repo.db, 'getAll').mockImplementationOnce(async (sql, params) => {
      const rows = await originalGetAll(sql, params)
      // Automation scope: the raced impostor mimics a synced/legacy write, not
      // a (guarded) user edit to the seed row.
      await repo.tx(tx => tx.update(poisonedId, {
        properties: {
          ...canonicalPropertySeedProperties(seed),
          [seedKeyProp.name]: 'system:test/property/raced-impostor',
        },
      }), {scope: ChangeScope.Automation})
      return rows
    })

    await expect(materializePropertySeeds(repo, WS, [seed, seedWithoutDefault]))
      .rejects.toThrow(`seed id ${poisonedId} does not carry expected seed key ${seed.seedKey}`)
    expect(await repo.db.getOptional('SELECT id FROM blocks WHERE id = ?', [untouchedId])).toBeNull()
  })

  it('never restores a tombstoned deterministic-id occupant with missing provenance', async () => {
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    const properties = canonicalPropertySeedProperties(seed)
    delete properties[seedKeyProp.name]
    await repo.tx(async tx => {
      await tx.create({
        id,
        workspaceId: WS,
        parentId: propertiesPageBlockId(WS),
        orderKey: 'a0',
        content: 'missing provenance',
        properties,
      })
      await tx.delete(id)
    }, {scope: ChangeScope.BlockDefault})

    await expect(materializePropertySeeds(repo, WS, [seed])).rejects.toThrow(
      `seed id ${id} does not carry expected seed key ${seed.seedKey}`,
    )
    expect((await repo.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [id],
    )).deleted).toBe(1)
  })

  it('rejects duplicate seed keys before probing or writing', async () => {
    const getAll = vi.spyOn(repo.db, 'getAll')
    await expect(materializePropertySeeds(repo, WS, [seed, seed])).rejects.toThrow('duplicate seed key')
    expect(getAll).not.toHaveBeenCalled()
  })
})

describe('property seed materialization access', () => {
  const insertMembership = async (role: 'owner' | 'editor' | 'viewer'): Promise<void> => {
    await repo.db.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time)
       VALUES (?, ?, ?, ?, ?)`,
      [`member-${role}`, WS, repo.user.id, role, 1],
    )
  }

  it('allows a fresh writable workspace without waiting for membership', async () => {
    await expect(awaitPropertySeedMaterializationAccess(repo, WS, {freshlyCreated: true}))
      .resolves.toEqual({allowed: true})
  })

  it('never authorizes an aborted trigger generation on a fast or ready path', async () => {
    const fresh = new AbortController()
    fresh.abort()
    await expect(awaitPropertySeedMaterializationAccess(repo, WS, {
      freshlyCreated: true,
      signal: fresh.signal,
    })).rejects.toMatchObject({name: 'AbortError'})

    await insertMembership('editor')
    const ready = new AbortController()
    const waiting = awaitPropertySeedMaterializationAccess(repo, WS, {
      freshlyCreated: false,
      signal: ready.signal,
    })
    ready.abort()
    await expect(waiting).rejects.toMatchObject({name: 'AbortError'})
  })

  it('awaits existing-workspace membership and distinguishes editor from viewer', async () => {
    await insertMembership('editor')
    await expect(awaitPropertySeedMaterializationAccess(repo, WS, {freshlyCreated: false}))
      .resolves.toEqual({allowed: true})

    await repo.db.execute('DELETE FROM workspace_members WHERE workspace_id = ?', [WS])
    await insertMembership('viewer')
    await expect(awaitPropertySeedMaterializationAccess(repo, WS, {freshlyCreated: false}))
      .resolves.toEqual({allowed: false, reason: 'viewer'})
  })

  it('skips immediately when read-only or no longer on the captured workspace', async () => {
    repo.setReadOnly(true)
    await expect(awaitPropertySeedMaterializationAccess(repo, WS, {freshlyCreated: false}))
      .resolves.toEqual({allowed: false, reason: 'read-only'})

    repo.setReadOnly(false)
    repo.setActiveWorkspaceId(OTHER_WS)
    await expect(awaitPropertySeedMaterializationAccess(repo, WS, {freshlyCreated: false}))
      .resolves.toEqual({allowed: false, reason: 'inactive-workspace'})
  })

  it('rechecks the workspace after a parked membership wait releases', async () => {
    const waiting = awaitPropertySeedMaterializationAccess(repo, WS, {freshlyCreated: false})
    repo.setActiveWorkspaceId(OTHER_WS)
    await insertMembership('editor')

    await expect(waiting).resolves.toEqual({allowed: false, reason: 'inactive-workspace'})
  })
})

describe('scheduled seed materialization (Repo wiring, §4.3)', () => {
  const insertEditorMembership = async (): Promise<void> => {
    await repo.db.execute(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, create_time)
       VALUES (?, ?, ?, ?, ?)`,
      ['member-editor', WS, repo.user.id, 'editor', 1],
    )
  }

  it('materializes the active workspace registry seeds through the deferred pass', async () => {
    // A writable membership so the (non-fresh) access gate resolves rather than
    // parking on the membership row — otherwise the drain below would hang.
    await insertEditorMembership()
    // Priming the registry is itself a seedKey-set change (null → the kernel
    // seeds), so the applyTypesAndSchemas trigger schedules the pass; the
    // explicit call mirrors the bootstrap trigger. Both drain to the same
    // idempotent create.
    await repo.whenPropertyDefinitionsReady(WS)
    const seedKeys = [...(repo.propertyDefinitions?.seedsByKey.keys() ?? [])]
    expect(seedKeys.length).toBeGreaterThan(0)

    repo.scheduleWorkspaceSeedMaterialization(WS, false)
    await repo.awaitSeedMaterialization()

    // Every registry seed now has a live definition block under Properties.
    for (const seedKey of seedKeys) {
      const id = propertyDefinitionBlockId(WS, seedKey)
      const row = await sharedDb.db.get<{parent_id: string; deleted: number}>(
        'SELECT parent_id, deleted FROM blocks WHERE id = ?', [id],
      )
      expect(row?.parent_id).toBe(propertiesPageBlockId(WS))
      expect(row?.deleted).toBe(0)
    }
  })

  it('re-runs once when a seed-set change coalesces mid-flight (dirty re-run)', async () => {
    await insertEditorMembership()
    await repo.whenPropertyDefinitionsReady(WS)
    const [firstSeedKey] = [...(repo.propertyDefinitions?.seedsByKey.keys() ?? [])]
    expect(firstSeedKey).toBeTruthy()
    // Settle the registry-priming auto-schedule (drain does NOT advance the idle
    // timer, so poll until its pass has actually materialized) — the spy below
    // then only counts our scenario's passes.
    await vi.waitFor(async () => {
      await repo.awaitSeedMaterialization()
      const row = await sharedDb.db.get('SELECT id FROM blocks WHERE id = ?',
        [propertyDefinitionBlockId(WS, firstSeedKey!)])
      expect(row).toBeTruthy()
    })

    type WithRun = {runWorkspaceSeedMaterialization: (...a: unknown[]) => Promise<void>}
    const original = (repo as unknown as WithRun).runWorkspaceSeedMaterialization.bind(repo)
    let calls = 0
    vi.spyOn(repo as unknown as WithRun, 'runWorkspaceSeedMaterialization')
      .mockImplementation(async (...args: unknown[]) => {
        calls += 1
        // A seed-set change (e.g. a newly enabled extension) lands while THIS first
        // pass is in flight: it coalesces onto the running pass, which has already
        // snapshotted its seeds. Only a dirty re-run picks it up — a plain coalesce
        // drops it, leaving the new seed unmaterialized until the next change.
        if (calls === 1) repo.scheduleWorkspaceSeedMaterialization(WS, false)
        await original(...args)
      })

    repo.scheduleWorkspaceSeedMaterialization(WS, false)
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))
    await repo.awaitSeedMaterialization()
    // Exactly one dirty re-run (2 total): the mid-flight change is honored and the
    // loop terminates once no further change is pending — no unbounded re-running.
    expect(calls).toBe(2)
  })

  it('materializes registry TYPE seeds through the same deferred pass', async () => {
    await insertEditorMembership()
    await repo.whenPropertyDefinitionsReady(WS)
    // A dynamic type seed (a `seedType` contribution that appears post-bootstrap).
    repo.setRuntimeContributions(typeSeedsFacet, 'test-type-seed', [typeSeed])
    await vi.waitFor(() => {
      expect(repo.typeDefinitions?.seedsByKey.has(typeSeed.seedKey)).toBe(true)
    })

    // Drive ONLY the wiring path (no direct materializeTypeSeeds call): the one
    // deferred pass must now materialize type seeds alongside property seeds.
    repo.scheduleWorkspaceSeedMaterialization(WS, false)
    await vi.waitFor(async () => {
      await repo.awaitSeedMaterialization()
      const row = await sharedDb.db.getOptional<{parent_id: string; deleted: number}>(
        'SELECT parent_id, deleted FROM blocks WHERE id = ?', [typeDefinitionBlockId(WS, typeSeed.seedKey)],
      )
      expect(row?.parent_id).toBe(typesPageBlockId(WS))
      expect(row?.deleted).toBe(0)
    })
  })

  it('materializes type seeds even when the property pass throws (kinds are isolated)', async () => {
    await insertEditorMembership()
    await repo.whenPropertyDefinitionsReady(WS)
    // Poison the property pass: park a foreign-workspace live row on a property
    // seed's deterministic id, so materializePropertySeeds throws its
    // cross-workspace guard for the whole batch. The independent type pass must
    // still run — a bad property seed can't strand valid type seed backing blocks.
    // (Safe against the registry-priming auto-schedule: that pass is deep-idle
    // deferred ~10-30s and can't fire before this synchronous poison write, so
    // the id is never materialized first — no DuplicateId collision.)
    const [propSeedKey] = [...(repo.propertyDefinitions?.seedsByKey.keys() ?? [])]
    expect(propSeedKey).toBeTruthy()
    await repo.tx(tx => tx.create({
      id: propertyDefinitionBlockId(WS, propSeedKey!),
      workspaceId: OTHER_WS,
      parentId: null,
      orderKey: 'a0',
      content: 'foreign occupant',
    }), {scope: ChangeScope.BlockDefault})

    repo.setRuntimeContributions(typeSeedsFacet, 'test-type-seed', [typeSeed])
    await vi.waitFor(() => {
      expect(repo.typeDefinitions?.seedsByKey.has(typeSeed.seedKey)).toBe(true)
    })

    repo.scheduleWorkspaceSeedMaterialization(WS, false)
    await vi.waitFor(async () => {
      await repo.awaitSeedMaterialization()
      const row = await sharedDb.db.getOptional<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [typeDefinitionBlockId(WS, typeSeed.seedKey)],
      )
      expect(row?.deleted).toBe(0)
    })
  })

  it('reschedules when a type seed id de-collides, even with the key set unchanged', async () => {
    await insertEditorMembership()
    await repo.whenPropertyDefinitionsReady(WS)

    // Two type seeds sharing a membership id but with distinct keys: contested, so
    // `uncontestedTypeSeeds` backs NEITHER.
    const seedA = seedType({seedKey: 'system:test/type/a', revision: 1, id: 'dup', label: 'A'})
    const seedBContested = seedType({seedKey: 'system:test/type/b', revision: 1, id: 'dup', label: 'B'})
    repo.setRuntimeContributions(typeSeedsFacet, 'contested', [seedA, seedBContested])
    await vi.waitFor(() => expect(repo.typeDefinitions?.seedsByKey.size).toBe(2))
    await repo.awaitSeedMaterialization()
    // Neither backed while contested (also the pre-materialization state, so this
    // holds regardless of the auto-scheduled pass's timing).
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, seedA.seedKey)])).toBeNull()

    // De-collide B's id WITHOUT changing the key set. Materializability changed
    // (both are now uncontested), so the reschedule trigger must fire on the id
    // change alone — a key-set-only diff would miss it and leave them unbacked.
    // NOTE: no explicit schedule here — this relies on the applyTypesAndSchemas
    // auto-reschedule, which is the mechanism under test.
    const seedBFixed = seedType({seedKey: 'system:test/type/b', revision: 1, id: 'dup-b', label: 'B'})
    repo.setRuntimeContributions(typeSeedsFacet, 'contested', [seedA, seedBFixed])

    await vi.waitFor(async () => {
      await repo.awaitSeedMaterialization()
      const rowA = await sharedDb.db.getOptional<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [typeDefinitionBlockId(WS, seedA.seedKey)])
      const rowB = await sharedDb.db.getOptional<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [typeDefinitionBlockId(WS, seedBFixed.seedKey)])
      expect(rowA?.deleted).toBe(0)
      expect(rowB?.deleted).toBe(0)
    })
  })

  it('withholds a contested-KEY seed from materialization, then backs it once the key de-collides', async () => {
    await insertEditorMembership()
    await repo.whenPropertyDefinitionsReady(WS)

    // Two contributions sharing a seed KEY (distinct ids). `indexSeedsByKey` keeps
    // the first and flags the key contested; the registry collapses them, so the
    // materializer's own `assertUniqueSeedKeys` never sees the duplicate. The
    // scheduled pass must still withhold the order-dependent backing row.
    const DUP_KEY = 'system:test/type/dup'
    const first = seedType({seedKey: DUP_KEY, revision: 1, id: 'dup-first', label: 'First'})
    const second = seedType({seedKey: DUP_KEY, revision: 1, id: 'dup-second', label: 'Second'})
    const backingId = typeDefinitionBlockId(WS, DUP_KEY)
    repo.setRuntimeContributions(typeSeedsFacet, 'contested-key', [first, second])
    await vi.waitFor(() => {
      expect(repo.typeDefinitions?.seedsByKey.size).toBe(1)
      expect(repo.typeDefinitions?.contestedSeedKeys.has(DUP_KEY)).toBe(true)
    })

    // Force a pass while contested: nothing is written (the keep-first winner is
    // withheld, not persisted), even though `seedsByKey` holds it.
    repo.scheduleWorkspaceSeedMaterialization(WS, false)
    await repo.awaitSeedMaterialization()
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?', [backingId])).toBeNull()

    // De-collide by dropping the duplicate. `seedsByKey` is byte-identical (the
    // survivor WAS the kept first), so only the contested-set diff can fire the
    // reschedule — no explicit schedule here, this rides the applyTypesAndSchemas
    // auto-reschedule under test.
    repo.setRuntimeContributions(typeSeedsFacet, 'contested-key', [first])
    await vi.waitFor(() => expect(repo.typeDefinitions?.contestedSeedKeys.has(DUP_KEY)).toBe(false))
    await vi.waitFor(async () => {
      await repo.awaitSeedMaterialization()
      const row = await sharedDb.db.getOptional<{deleted: number}>(
        'SELECT deleted FROM blocks WHERE id = ?', [backingId])
      expect(row?.deleted).toBe(0)
    })
  })

  it('withholds an id-loser mirror when a contested-KEY winner shares its id', async () => {
    await insertEditorMembership()
    await repo.whenPropertyDefinitionsReady(WS)

    // A & B share KEY k1 (→ k1 key-contested, A kept first); A & C share membership
    // id 'x'. If `workspaceSeeds` only dropped the contested KEY, it would remove A
    // and leave C looking id-uncontested (uncontestedTypeSeeds counts x once) →
    // materialize an order-dependent loser mirror, since A is the id-'x' winner
    // in-memory. Filtering contested IDS against the registry withholds C too.
    const K1 = 'system:test/type/k1'
    const K2 = 'system:test/type/k2'
    const seedA = seedType({seedKey: K1, revision: 1, id: 'x', label: 'A'})
    const seedB = seedType({seedKey: K1, revision: 1, id: 'y', label: 'B'})
    const seedC = seedType({seedKey: K2, revision: 1, id: 'x', label: 'C'})
    repo.setRuntimeContributions(typeSeedsFacet, 'triple', [seedA, seedB, seedC])
    await vi.waitFor(() => {
      expect(repo.typeDefinitions?.contestedSeedKeys.has(K1)).toBe(true)
      expect(repo.typeDefinitions?.contestedTypeIds.has('x')).toBe(true)
    })

    repo.scheduleWorkspaceSeedMaterialization(WS, false)
    await repo.awaitSeedMaterialization()
    // Neither the contested-key winner (K1) nor the id-loser (K2) gets a backing row.
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, K1)])).toBeNull()
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, K2)])).toBeNull()
  })
})

describe('seed definition write guard (tx layer)', () => {
  it('rejects user-scope bag edits and deletes of a materialized seed block', async () => {
    await materializePropertySeeds(repo, WS, [seed])
    const id = propertyDefinitionBlockId(WS, seed.seedKey)

    await expect(repo.tx(
      tx => tx.update(id, {
        properties: {...canonicalPropertySeedProperties(seed), [propertyNameProp.name]: 'hacked'},
      }),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(SeededDefinitionWriteError)

    await expect(repo.tx(
      tx => tx.setProperty(id, propertyHiddenProp, false),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(SeededDefinitionWriteError)

    // The outline delete key routes here (core.delete runs under BlockDefault).
    await expect(repo.tx(
      tx => tx.delete(id),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(SeededDefinitionWriteError)

    const row = await sharedDb.db.get<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(row.deleted).toBe(0)
    expect(JSON.parse(row.properties_json)).toEqual(canonicalPropertySeedProperties(seed))
  })

  it('rejects a user-scope create that forges a provenance-valid seed row', async () => {
    // The deterministic id is publicly computable (uuidv5 of
    // `workspaceId:seedKey`), so without a create-side guard a user-scope
    // caller could author the row BEFORE materialization runs — and the
    // materialization probe would then trust the forged bag forever (live
    // row → skipped, payloads never repaired). Found by definitionSeeds.fuzz.
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await expect(repo.tx(async tx => {
      await tx.create({
        id,
        workspaceId: WS,
        parentId: propertiesPageBlockId(WS),
        orderKey: 'a0',
        content: seed.name,
        properties: canonicalPropertySeedProperties(seed),
      })
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(SeededDefinitionWriteError)
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?', [id])).toBeNull()
  })

  it('rejects a user-scope update that makes an occupant row provenance-valid', async () => {
    // The third forge direction: create a PLAIN row at the deterministic id
    // (legal — it is just a block), then write the canonical bag onto it.
    // The old per-primitive guards checked only the `before` row and let
    // this through; the commit-time check over the snapshots map rejects a
    // row BECOMING a valid seeded definition under user scope.
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await repo.tx(async tx => {
      await tx.create({
        id,
        workspaceId: WS,
        parentId: propertiesPageBlockId(WS),
        orderKey: 'a0',
        content: 'innocent occupant',
        properties: {},
      })
    }, {scope: ChangeScope.BlockDefault})

    await expect(repo.tx(
      tx => tx.update(id, {properties: canonicalPropertySeedProperties(seed)}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(SeededDefinitionWriteError)
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(JSON.parse(row.properties_json)).toEqual({})
  })

  it('rejects a user-scope createOrGet insert of a provenance-valid seed row', async () => {
    // createOrGet's insert path builds the same row shape as create — the
    // old per-primitive guard covered only create (Codex review). The
    // commit-time check sees the insert's snapshot like any other write.
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await expect(repo.tx(async tx => {
      await tx.createOrGet({
        id,
        workspaceId: WS,
        parentId: propertiesPageBlockId(WS),
        orderKey: 'a0',
        content: seed.name,
        properties: canonicalPropertySeedProperties(seed),
      })
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow(SeededDefinitionWriteError)
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?', [id])).toBeNull()
  })

  it('rejects a user-scope restore patch that makes a tombstoned occupant provenance-valid', async () => {
    // The dual of restore-tamper: the tombstone is a PLAIN occupant of the
    // deterministic id, and the patch writes the canonical bag in — the
    // resulting row, not the before row, is what forges (Codex review).
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await repo.tx(async tx => {
      await tx.create({
        id,
        workspaceId: WS,
        parentId: propertiesPageBlockId(WS),
        orderKey: 'a0',
        content: 'placeholder',
        properties: {},
      })
      await tx.delete(id)
    }, {scope: ChangeScope.BlockDefault})

    await expect(repo.tx(
      tx => tx.restore(id, {properties: canonicalPropertySeedProperties(seed)}),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(SeededDefinitionWriteError)
    const row = await sharedDb.db.get<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(row.deleted).toBe(1)
    expect(JSON.parse(row.properties_json)).toEqual({})
  })

  it('rejects a user-scope restore that rewrites a tombstoned seed bag', async () => {
    // `restore` accepts a properties patch — without a guard it was the one
    // bag-write path a user-scope caller could still reach (tombstone the
    // row via Automation/sync, then resurrect it with a forged bag). A
    // PLAIN restore stays allowed: it keeps the code-owned bag intact.
    // Found by definitionSeeds.fuzz.
    await materializePropertySeeds(repo, WS, [seed])
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await repo.tx(tx => tx.delete(id), {scope: ChangeScope.Automation})

    await expect(repo.tx(
      tx => tx.restore(id, {
        properties: {
          ...canonicalPropertySeedProperties(seed),
          [propertyNameProp.name]: 'forged',
        },
      }),
      {scope: ChangeScope.BlockDefault},
    )).rejects.toThrow(SeededDefinitionWriteError)
    const tampered = await sharedDb.db.get<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(tampered.deleted).toBe(1)
    expect(JSON.parse(tampered.properties_json)).toEqual(canonicalPropertySeedProperties(seed))

    await repo.tx(tx => tx.restore(id), {scope: ChangeScope.BlockDefault})
    const restored = await sharedDb.db.get<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(restored.deleted).toBe(0)
    expect(JSON.parse(restored.properties_json)).toEqual(canonicalPropertySeedProperties(seed))
  })

  it('allows system (Automation) bag writes so materialization/upgrades work', async () => {
    await materializePropertySeeds(repo, WS, [seed])
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    await expect(repo.tx(
      tx => tx.update(id, {
        properties: {
          ...canonicalPropertySeedProperties(seed),
          [seedRevisionProp.name]: seedRevisionProp.codec.encode(3),
        },
      }),
      {scope: ChangeScope.Automation},
    )).resolves.toBeUndefined()
  })

  it('does not block user-scope bag writes on a non-seed block', async () => {
    const plainId = await repo.mutate.createChild({parentId: propertiesPageBlockId(WS)})
    await expect(repo.tx(
      tx => tx.update(plainId, {properties: {types: ['note']}}),
      {scope: ChangeScope.BlockDefault},
    )).resolves.toBeUndefined()
  })

  it('an outline subtree-delete of a page containing a seed definition aborts the whole tx atomically', async () => {
    // The guard is primitive-agnostic (assertNoSeedDefinitionWrites runs
    // once over the tx's whole snapshots map), so it also catches a seed
    // row tombstoned TRANSITIVELY by `repo.mutate.delete`'s subtree cascade
    // (`core.delete` → softDeleteSubtree, mutators.ts:222-246) — not just a
    // direct `tx.delete` on the seed's own id. That cascade is exactly the
    // outline delete key's path (txEngine.ts:117's own rationale names it).
    //
    // Deliberately characterized here as correct-but-hostile UX: a user who
    // deletes an ordinary page/section that happens to contain a seeded
    // definition somewhere in its subtree gets the ENTIRE delete rejected
    // and rolled back, with no indication which descendant blocked it.
    // Softening this product-side (e.g. skipping seed rows during subtree
    // delete instead of aborting the whole operation) is a flagged OPEN
    // decision — NOT implemented here.
    await materializePropertySeeds(repo, WS, [seed])
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    const pageId = await repo.mutate.createChild({parentId: propertiesPageBlockId(WS), content: 'a page'})
    await repo.tx(tx => tx.move(id, {parentId: pageId, orderKey: 'a0'}), {scope: ChangeScope.BlockDefault})

    await expect(repo.mutate.delete({id: pageId})).rejects.toThrow(SeededDefinitionWriteError)

    const pageRow = await sharedDb.db.get<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [pageId])
    expect(pageRow.deleted, 'the page itself rolled back, not just the seed').toBe(0)
    const seedRow = await sharedDb.db.get<{deleted: number; properties_json: string}>(
      'SELECT deleted, properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(seedRow.deleted).toBe(0)
    expect(JSON.parse(seedRow.properties_json)).toEqual(canonicalPropertySeedProperties(seed))
  })

  it('merge of a propertyless sibling into a seed definition succeeds (content-only merge is a legal edit)', async () => {
    // `core.merge` (blockMerge.ts) writes `into`'s content AND properties in
    // one `tx.update`. mergeProperties(into.properties, from.properties)
    // with an EMPTY `from` bag never touches a key the guard would see as
    // changed, so this is legal even though the seed is the merge target —
    // matching the fuzzer's prediction (definitionSeeds.fuzz.test.ts
    // `mergeIntoSeed` with `nonEmptyBag: false`). If a donor with a
    // non-empty bag were merged in instead, mergeProperties would copy its
    // from-only keys into `into` and the guard would reject it — see the
    // `nonEmptyBag: true` fuzzer case for that direction.
    await materializePropertySeeds(repo, WS, [seed])
    const id = propertyDefinitionBlockId(WS, seed.seedKey)
    const siblingId = await repo.mutate.createChild({
      parentId: propertiesPageBlockId(WS), content: ' (extra note)',
    })

    await expect(repo.mutate.merge({intoId: id, fromId: siblingId})).resolves.toBeUndefined()

    const seedRow = await sharedDb.db.get<{content: string; properties_json: string}>(
      'SELECT content, properties_json FROM blocks WHERE id = ?', [id],
    )
    expect(seedRow.content).toBe(`${seed.name} (extra note)`)
    expect(JSON.parse(seedRow.properties_json)).toEqual(canonicalPropertySeedProperties(seed))
    const siblingRow = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [siblingId],
    )
    expect(siblingRow.deleted, 'the donor was tombstoned by the merge').toBe(1)
  })
})

describe('type definition materialization', () => {
  it('canonicalTypeSeedProperties encodes identity/display facts, is provenance-valid, and carries only block-type membership', () => {
    const id = typeDefinitionBlockId(WS, typeSeed.seedKey)
    const bag = canonicalTypeSeedProperties(typeSeed)

    expect(isValidSeededDefinition({id, workspaceId: WS, properties: bag})).toBe(true)
    expect(blockTypeLabelProp.codec.decode(bag[blockTypeLabelProp.name])).toBe(typeSeed.label)
    expect(blockTypeTypeIdProp.codec.decode(bag[blockTypeTypeIdProp.name])).toBe(typeSeed.id)
    expect(seedKeyProp.codec.decode(bag[seedKeyProp.name])).toBe(typeSeed.seedKey)
    expect(seedRevisionProp.codec.decode(bag[seedRevisionProp.name])).toBe(typeSeed.revision)
    expect(blockTypeDescriptionProp.codec.decode(bag[blockTypeDescriptionProp.name])).toBe(typeSeed.description)
    expect(blockTypeColorProp.codec.decode(bag[blockTypeColorProp.name])).toBe(typeSeed.color)
    expect(blockTypeHideFromCompletionProp.codec.decode(bag[blockTypeHideFromCompletionProp.name])).toBe(true)
    expect(bag).not.toHaveProperty(blockTypeHideFromBlockDisplayProp.name)
    expect(bag).not.toHaveProperty(aliasesProp.name)
    // Membership is BLOCK_TYPE_TYPE only — a code type is not a navigable page.
    expect(getBlockTypes({properties: bag})).toEqual([BLOCK_TYPE_TYPE])
  })

  it('materializes the backing block under Types, bare (no PAGE_TYPE, no alias), and is idempotent', async () => {
    const id = typeDefinitionBlockId(WS, typeSeed.seedKey)
    expect(await materializeTypeSeeds(repo, WS, [typeSeed]))
      .toEqual({created: 1, restored: 0, skippedReadOnly: false})

    const row = repo.block(id).peek()
    expect(row).toBeTruthy()
    expect(row!.parentId).toBe(typesPageBlockId(WS))
    // Proves the typeify carve-out fired: a plain block-type block would have
    // picked up PAGE_TYPE + an alias (see the control test below).
    expect(getBlockTypes(row!)).toContain(BLOCK_TYPE_TYPE)
    expect(getBlockTypes(row!)).not.toContain(PAGE_TYPE)
    expect(getAliases(row!)).toEqual([])

    expect(await materializeTypeSeeds(repo, WS, [typeSeed]))
      .toEqual({created: 0, restored: 0, skippedReadOnly: false})
  })

  it('restores a tombstoned backing block', async () => {
    await materializeTypeSeeds(repo, WS, [typeSeed])
    const id = typeDefinitionBlockId(WS, typeSeed.seedKey)
    await repo.tx(tx => tx.delete(id), {scope: ChangeScope.Automation})

    expect(await materializeTypeSeeds(repo, WS, [typeSeed]))
      .toEqual({created: 0, restored: 1, skippedReadOnly: false})
    const row = await sharedDb.db.get<{deleted: number}>('SELECT deleted FROM blocks WHERE id = ?', [id])
    expect(row.deleted).toBe(0)
  })

  it('skips read-only repos explicitly', async () => {
    repo.setReadOnly(true)
    expect(await materializeTypeSeeds(repo, WS, [typeSeed]))
      .toEqual({created: 0, restored: 0, skippedReadOnly: true})
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?', [typeDefinitionBlockId(WS, typeSeed.seedKey)]))
      .toBeNull()
  })

  it('rejects a live deterministic-id occupant from another workspace (cross-workspace guard is wired)', async () => {
    const id = typeDefinitionBlockId(WS, typeSeed.seedKey)
    await repo.tx(tx => tx.create({
      id,
      workspaceId: OTHER_WS,
      parentId: null,
      orderKey: 'a0',
      content: 'foreign live row',
    }), {scope: ChangeScope.BlockDefault})

    await expect(materializeTypeSeeds(repo, WS, [typeSeed])).rejects.toThrow(
      `seed id ${id} belongs to workspace ${OTHER_WS}`,
    )
  })

  it('does not open the write tx when the generation aborts during the probe', async () => {
    // The switch-away window: the abort lands AFTER the caller's pre-probe check,
    // while the seed-id probe is in flight. materializeSeeds must recheck the
    // signal and skip the write — not create a backing block in the workspace the
    // user just left (`repo.tx` pins by row workspace, not the active one).
    const controller = new AbortController()
    // The seed is fresh, so the probe finds no existing rows (empty). Abort the
    // moment it runs, simulating a switch-away in the probe's await window.
    vi.spyOn(repo.db, 'getAll').mockImplementation((async (sql: string) => {
      if (sql.includes('WHERE id IN')) controller.abort()
      return []
    }) as typeof repo.db.getAll)

    expect(await materializeTypeSeeds(repo, WS, [typeSeed], controller.signal))
      .toEqual({created: 0, restored: 0, skippedReadOnly: false})
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, typeSeed.seedKey)])).toBeNull()
  })

  it('ensures its own Types page when it does not exist yet (self-sufficient before bootstrap)', async () => {
    // A `setActiveWorkspaceId`-driven reschedule can fire the type pass before
    // bootstrap's `ensureSystemPages` creates the Types page (the type registry has
    // no priming gate). The pass must ensure its parent rather than throw
    // ParentNotFound and leave the seed unmaterialized until the next open/change.
    // This workspace never had `ensureSystemPages` run (beforeEach only ensures WS).
    const freshWs = 'ws-no-pages'
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typesPageBlockId(freshWs)])).toBeNull()

    expect(await materializeTypeSeeds(repo, freshWs, [typeSeed]))
      .toEqual({created: 1, restored: 0, skippedReadOnly: false})

    // The parent Types page was materialized by the pass itself...
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typesPageBlockId(freshWs)])).not.toBeNull()
    // ...and the backing block is parented under it.
    const row = await sharedDb.db.get<{parent_id: string}>(
      'SELECT parent_id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(freshWs, typeSeed.seedKey)])
    expect(row.parent_id).toBe(typesPageBlockId(freshWs))
  })

  it('skips the seed write when the generation aborts during the parent-page ensure', async () => {
    // Distinct switch-away window from the probe test above: the pre-tx check
    // passes, then `ensureParent` awaits — an abort landing THERE must still skip
    // the seed write. Abort while the parent page is loaded (inside ensureParent);
    // the recheck at the top of the write tx must commit nothing, even though the
    // page itself gets created (ensureParent ignores the signal).
    const freshWs = 'ws-abort-in-ensure'
    const controller = new AbortController()
    const realLoad = repo.load.bind(repo)
    vi.spyOn(repo, 'load').mockImplementation((async (
      id: string,
      opts?: {children?: boolean; ancestors?: boolean; descendants?: boolean | number},
    ) => {
      if (id === typesPageBlockId(freshWs)) {
        controller.abort()
        return null
      }
      return realLoad(id, opts)
    }) as typeof repo.load)

    expect(await materializeTypeSeeds(repo, freshWs, [typeSeed], controller.signal))
      .toEqual({created: 0, restored: 0, skippedReadOnly: false})
    // ensureParent still ran (it doesn't observe the signal), so the page exists...
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typesPageBlockId(freshWs)])).not.toBeNull()
    // ...but the aborted generation wrote no backing block.
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(freshWs, typeSeed.seedKey)])).toBeNull()
  })

  it('skips the seed write when the role demotes to viewer before the write loop', async () => {
    // `ChangeScope.Automation` is permitted in read-only mode, so a demotion that
    // lands after the top-of-fn read-only check + access gate but before the write
    // loop must be caught at the final checkpoint — else a viewer gets backing rows
    // and RLS-rejected writes. WS's Types page already exists (beforeEach), so
    // `ensureParent` is a no-op read; demote during that read (still returning the
    // real page so ensureParent doesn't try a read-only-blocked create), then the
    // write loop must skip.
    const realLoad = repo.load.bind(repo)
    vi.spyOn(repo, 'load').mockImplementation((async (
      id: string,
      opts?: {children?: boolean; ancestors?: boolean; descendants?: boolean | number},
    ) => {
      if (id === typesPageBlockId(WS)) repo.setReadOnly(true)
      return realLoad(id, opts)
    }) as typeof repo.load)

    expect(await materializeTypeSeeds(repo, WS, [typeSeed]))
      .toEqual({created: 0, restored: 0, skippedReadOnly: false})
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, typeSeed.seedKey)])).toBeNull()
  })

  it('with revalidation on, skips a seed the live registry no longer declares (stale-snapshot guard)', async () => {
    // The scheduled path snapshots the seed set, then awaits (probe / ensure / tx
    // setup); a facet change during that window can drop a seed. The write path must
    // recheck the live registry and skip it — create/restore-only can't undo a stale
    // write, so a retired row would be republished later as a phantom block-id type.
    // Simulate the post-await state: the live registry no longer declares typeSeed.
    const emptyRegistry = buildTypeDefinitionRegistry({
      workspaceId: WS, projectedDefinitions: new Map(), seeds: [],
    })
    vi.spyOn(repo, 'typeDefinitions', 'get').mockReturnValue(emptyRegistry)

    // `revalidateAgainstRegistry: true` is what the scheduled path passes; the
    // snapshot argument still lists typeSeed, but the live registry no longer does.
    expect(await materializeTypeSeeds(repo, WS, [typeSeed], undefined, true))
      .toEqual({created: 0, restored: 0, skippedReadOnly: false})
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, typeSeed.seedKey)])).toBeNull()

    // Control: a direct caller (revalidation OFF) trusts its explicit array and still
    // materializes, proving the guard is scoped to the scheduled path.
    expect((await materializeTypeSeeds(repo, WS, [typeSeed])).created).toBe(1)
  })

  it('with revalidation on, skips a seed the live registry now flags id-contested (stale-snapshot guard)', async () => {
    // A seed uncontested at snapshot time can become duplicate-ID contested during
    // the pass's awaits (a twin declaration lands). The live recheck must withhold
    // it by MEMBERSHIP ID too — not only removed or key-contested seeds — else an
    // order-dependent loser mirror gets written. Simulate that post-await registry.
    const contestedRegistry = buildTypeDefinitionRegistry({
      workspaceId: WS,
      projectedDefinitions: new Map(),
      seeds: [
        typeSeed,
        seedType({seedKey: 'system:test/type/twin', revision: 1, id: typeSeed.id, label: 'Twin'}),
      ],
    })
    expect(contestedRegistry.contestedTypeIds.has(typeSeed.id)).toBe(true)
    vi.spyOn(repo, 'typeDefinitions', 'get').mockReturnValue(contestedRegistry)

    expect((await materializeTypeSeeds(repo, WS, [typeSeed], undefined, true)).created).toBe(0)
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, typeSeed.seedKey)])).toBeNull()
  })

  it('with revalidation on, skips when the live declaration for the key has a new membership id', async () => {
    // The snapshot has typeSeed (id=test-widget). The live registry now maps that
    // SAME key to a replacement declaration with a new membership id (revision left
    // unchanged, so this isolates the id identity check). Writing the stale snapshot
    // would put the old id into the deterministic block; create/restore-only never
    // repairs it, so the registry would bind the new id to a row claiming the old
    // one. Skip — the dirty re-run materializes the current declaration.
    const replaced = seedType({seedKey: typeSeed.seedKey, revision: typeSeed.revision, id: 'new-widget', label: 'Renamed'})
    const replacedRegistry = buildTypeDefinitionRegistry({
      workspaceId: WS, projectedDefinitions: new Map(), seeds: [replaced],
    })
    vi.spyOn(repo, 'typeDefinitions', 'get').mockReturnValue(replacedRegistry)

    expect((await materializeTypeSeeds(repo, WS, [typeSeed], undefined, true)).created).toBe(0)
    expect(await sharedDb.db.getOptional('SELECT id FROM blocks WHERE id = ?',
      [typeDefinitionBlockId(WS, typeSeed.seedKey)])).toBeNull()
  })

  it('typeify still completes a NON-seed block-type block into a page + alias (carve-out is narrow)', async () => {
    const id = await repo.mutate.createChild({parentId: repo.typesPageId!})
    await repo.tx(async tx => {
      await repo.addTypeInTx(tx, id, BLOCK_TYPE_TYPE, {})
      await tx.setProperty(id, blockTypeLabelProp, 'Plain Type')
    }, {scope: ChangeScope.BlockDefault})

    const row = repo.block(id).peek()
    expect(getBlockTypes(row!)).toContain(PAGE_TYPE)
    expect(getAliases(row!)).toEqual(['Plain Type'])
  })

  it('flows a materialized seed through the registry to repo.types + getTypeBlockId', async () => {
    repo.setRuntimeContributions(typeSeedsFacet, 'test-type-seed', [typeSeed])
    await materializeTypeSeeds(repo, WS, [typeSeed])

    // The declared-seed contribution publishes into `repo.types` immediately
    // (independent of the block), so wait on the block-bound side of the
    // registry to prove the materialized row was actually projected.
    await vi.waitFor(() => {
      expect(repo.userTypes.getTypeBlockId(typeSeed.id)).toBeDefined()
    }, {timeout: 3000})

    expect(repo.types.get(typeSeed.id)).toMatchObject({
      id: typeSeed.id,
      label: typeSeed.label,
      hideFromCompletion: true,
    })
    const blockId = typeDefinitionBlockId(WS, typeSeed.seedKey)
    expect(repo.userTypes.getTypeBlockId(typeSeed.id)).toBe(blockId)
    expect(repo.typeDefinitions?.blockIdByTypeId.get(typeSeed.id)).toBe(blockId)
  })

  it('materializes NO seed of a contested membership id, but still materializes the uncontested ones', async () => {
    // typeSeed + twin share an `id` but carry different keys (→ different
    // deterministic ids, so assertUniqueSeedKeys passes). Materializing an
    // order-dependent keep-first winner would orphan a phantom `/type/` row on a
    // reorder / authoring fix (this create/restore-only pass never deletes), so
    // NEITHER contested declaration is backed. A third, uncontested seed in the
    // same batch must still materialize — one bad contribution can't abort the pass.
    const twin = seedType({
      seedKey: 'system:test/type/widget-twin', revision: 1, id: typeSeed.id, label: 'Widget Twin',
    })
    const other = seedType({
      seedKey: 'system:test/type/gadget', revision: 1, id: 'test-gadget', label: 'Gadget',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await materializeTypeSeeds(repo, WS, [typeSeed, twin, other]))
        .toEqual({created: 1, restored: 0, skippedReadOnly: false})
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('duplicate type seed id'))
    } finally {
      warn.mockRestore()
    }
    // No backing row for either contested declaration...
    expect(await sharedDb.db.getOptional(
      'SELECT id FROM blocks WHERE id = ?', [typeDefinitionBlockId(WS, typeSeed.seedKey)],
    )).toBeNull()
    expect(await sharedDb.db.getOptional(
      'SELECT id FROM blocks WHERE id = ?', [typeDefinitionBlockId(WS, twin.seedKey)],
    )).toBeNull()
    // ...but the uncontested seed materialized.
    expect(repo.block(typeDefinitionBlockId(WS, other.seedKey)).peek()).toBeTruthy()
  })

  it('rejects a user-scope create that forges a provenance-valid /type/ seed row (tx guard is grammar-agnostic)', async () => {
    // The tx-layer seed-write guard (`assertNoSeedDefinitionWrites`) fires for
    // BlockDefault-scope writes on any row transitioning into a valid seeded
    // definition — property OR type grammar. This closes the loop the existing
    // forge tests only cover for `/property/` keys.
    const id = typeDefinitionBlockId(WS, typeSeed.seedKey)
    await expect(repo.tx(tx => tx.create({
      id,
      workspaceId: WS,
      parentId: repo.typesPageId!,
      orderKey: 'a0',
      content: typeSeed.label,
      properties: canonicalTypeSeedProperties(typeSeed),
    }), {scope: ChangeScope.BlockDefault})).rejects.toThrow(SeededDefinitionWriteError)
  })
})
