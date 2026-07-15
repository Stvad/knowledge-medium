// @vitest-environment node
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {ChangeScope, seedProperty, SeededDefinitionWriteError} from '@/data/api'
import {
  canonicalPropertySeedProperties,
  awaitPropertySeedMaterializationAccess,
  isValidSeededDefinition,
  materializePropertySeeds,
  propertyDefinitionBlockId,
} from '@/data/definitionSeeds'
import {
  propertyDefaultProp,
  propertyHiddenProp,
  propertyNameProp,
  seedKeyProp,
  seedRevisionProp,
} from '@/data/properties'
import {propertiesPageBlockId} from '@/data/propertiesPage'
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
    expect(isValidSeededDefinition({
      id: propertyDefinitionBlockId(WS, 'malformed-key'),
      workspaceId: WS,
      properties: {[seedKeyProp.name]: 'malformed-key'},
    })).toBe(false)
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
})
