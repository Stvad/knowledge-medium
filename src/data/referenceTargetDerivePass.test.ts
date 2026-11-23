// @vitest-environment node
/**
 * One-time-per-workspace catch-up derive of the LOCAL `reference_target_id`
 * column: rows that predate the column (upgrading device /
 * pre-registry sync) get stamped once, marker-gated, without advancing
 * `updated_at` (the LWW row-version) and without enqueueing uploads.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty, type BlockData } from '@/data/api'
import {
  BLOCKS_REFERENCE_CANDIDATES_INDEX,
  BLOCKS_TABLE_COLUMN_NAMES,
  REFERENCE_TARGET_REDERIVE_CANDIDATES_SQL,
  REFERENCE_TARGET_SWEEP_CANDIDATES_SQL,
  blockToRowParams,
} from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { aliasesProp, typesProp } from '@/data/properties'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'
import { REFERENCE_TARGET_STAMP_CHUNK, type Repo } from './repo'
import { mergeBlocksInTx } from './blockMerge'

const WS = 'ws-derive-pass'
/** A real fieldId is the definition block's UUID. No assertion here turns on
 *  the shape — the whole-block grammar takes any non-paren id — but the
 *  INLINE parser is UUID-only, so a synthetic one would make the seeded
 *  `references` below a shape no real parse could have produced. */
const STATUS_FIELD_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const statusSchema = defineProperty('status', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { vi.useRealTimers() })

/** Mirror production ordering: `workspaceBootstrap` awaits
 *  `whenPropertyDefinitionsReady` (which pins the workspace's registry) before
 *  scheduling the pass; the sweep gates on that registry being for this
 *  workspace. Fake timers scope to the deep-idle deferral only — the pass is
 *  deferred 10s, so the drain helper needs the timer advanced first (same
 *  pattern as backfill.test.ts). */
const runPass = async (
  repo: Repo,
  {ready = true}: {ready?: boolean} = {},
): Promise<void> => {
  if (ready) await repo.whenPropertyDefinitionsReady(WS)
  vi.useFakeTimers()
  repo.scheduleReferenceTargetDerivePass(WS)
  await vi.runAllTimersAsync()
  await repo.awaitReferenceTargetDerive()
  vi.useRealTimers()
}

const INSERT_SQL =
  `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`

/** Raw-seed a pre-upgrade row: column NULL regardless of content, no
 *  processor involvement (the seed bypasses repo.tx entirely). */
const seededBlock = (overrides: Partial<BlockData> & {id: string}): BlockData => ({
    workspaceId: WS,
    parentId: null,
    orderKey: `k-${overrides.id}`,
    content: '',
    properties: {},
    references: [],
    createdAt: 1,
    updatedAt: 1000,
    userUpdatedAt: 1000,
    createdBy: 'u',
    updatedBy: 'u',
    deleted: false,
    referenceTargetId: null,
    ...overrides,
  })

const seedRow = (overrides: Partial<BlockData> & {id: string}): Promise<unknown> =>
  sharedDb.db.execute(INSERT_SQL, blockToRowParams(seededBlock(overrides)))

const setup = (workspaceId = WS): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(workspaceId)
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-status-definition',
    [{
      metadata: {
        fieldId: STATUS_FIELD_ID,
        workspaceId,
        createdAt: 1,
        name: statusSchema.name,
        changeScope: statusSchema.changeScope,
        hidden: false,
        origin: 'user' as const,
      },
      schema: statusSchema,
    }],
    {workspaceId},
  )
  return repo
}

const readColumn = async (id: string): Promise<string | null> => {
  const row = await sharedDb.db.get<{reference_target_id: string | null}>(
    'SELECT reference_target_id FROM blocks WHERE id = ?', [id],
  )
  return row.reference_target_id
}

const refsOf = async (id: string): Promise<unknown> => {
  const row = await sharedDb.db.get<{references_json: string}>(
    'SELECT references_json FROM blocks WHERE id = ?', [id],
  )
  return JSON.parse(row.references_json)
}

describe('reference-target initial derive pass', () => {
  it('stamps pre-existing rows across both resolution paths, prose untouched', async () => {
    // A property field row addresses its definition BY ID (`((fieldId))`, §7),
    // so it stamps textually on the block-ref path — no name→schema tier.
    await seedRow({id: 'field-ref', content: `((${STATUS_FIELD_ID}))`})
    await seedRow({id: 'block-ref', content: '((some-target))'})
    await seedRow({id: 'alias-target', content: 'Inbox', properties: {alias: ['Inbox']}})
    await seedRow({id: 'alias-ref', content: '[[Inbox]]'})
    await seedRow({id: 'prose', content: 'just some ((text)) inline'})
    await seedRow({id: 'tombstone-ref', content: '((dead-target))', deleted: true})

    const repo = setup()
    await runPass(repo)

    expect(await readColumn('field-ref')).toBe(STATUS_FIELD_ID)
    expect(await readColumn('block-ref')).toBe('some-target')
    expect(await readColumn('alias-ref')).toBe('alias-target')
    expect(await readColumn('prose')).toBeNull()
    // Deleted rows are swept too (a later content-unchanged restore would
    // never re-derive them).
    expect(await readColumn('tombstone-ref')).toBe('dead-target')
  })

  it('is local bookkeeping: no updated_at advance, no upload enqueued, no user metadata', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    const before = await sharedDb.db.get<{updated_at: number; user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', ['block-ref'],
    )

    const repo = setup()
    await runPass(repo)

    const after = await sharedDb.db.get<{updated_at: number; user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', ['block-ref'],
    )
    expect(after).toEqual(before)
    const crud = await sharedDb.db.getAll('SELECT id FROM ps_crud')
    expect(crud).toEqual([])
  })

  it('runs once per workspace PER SESSION; a fresh open sweeps again', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    const repo = setup()
    await runPass(repo)
    expect(await readColumn('block-ref')).toBe('some-target')

    // Same session: a re-schedule is a no-op (incremental paths own it).
    await seedRow({id: 'late-row', content: '((late-target))', updatedAt: 2000})
    await runPass(repo)
    expect(await readColumn('late-row')).toBeNull()

    // A new open (new Repo) sweeps again — definitions/aliases that arrived
    // while the app was closed are repaired at the next open (a durable
    // once-ever marker missed them forever).
    const repo2 = setup()
    await runPass(repo2)
    expect(await readColumn('late-row')).toBe('late-target')
  })

  it('skips without a marker when the registry is not this workspace (retries next open)', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    // Active/projected workspace differs from the pass target.
    const repo = setup('ws-other')
    // Prime the OTHER workspace's registry (the active one), then run the
    // pass for WS — the registry mismatch must skip without a marker.
    await repo.whenPropertyDefinitionsReady('ws-other')
    await runPass(repo, {ready: false})

    expect(await readColumn('block-ref')).toBeNull()
    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'reference_target_derive:%'",
    )
    expect(markers).toEqual([])
  })

  it('the CAS write never stamps a row whose content changed after the scan', async () => {
    // TOCTOU pin (adversarial-review fix): the stamp helper re-checks
    // (content, NULL column) inside the write tx.
    await seedRow({id: 'raced', content: '((some-target))'})
    const repo = setup()
    await repo.whenPropertyDefinitionsReady(WS)
    // Simulate the concurrent edit landing between scan and write by
    // mutating content right after scheduling (before the deferred job's
    // timer fires — the job scans AND writes inside the fake-timer drain,
    // so mutate first, then let it run: the scan itself will see the new
    // content. To hit the write-phase check instead, scan-time state must
    // be captured first — covered by the in-tx re-read; this test pins the
    // end-to-end "changed rows are never stamped" behavior).
    await sharedDb.db.execute(
      "UPDATE blocks SET content = 'plain prose now' WHERE id = 'raced'",
    )
    await runPass(repo, {ready: false})
    expect(await readColumn('raced')).toBeNull()
  })

  it('refreshes already-cached snapshots so readers see the repair', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    const {repo, cache} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    // Hydrate the row into the cache pre-pass (stale: column null).
    const preloaded = await repo.load('block-ref')
    expect(preloaded?.referenceTargetId).toBeNull()
    expect(cache.getSnapshot('block-ref')).toBeDefined()

    await runPass(repo)

    expect(cache.getSnapshot('block-ref')?.referenceTargetId).toBe('some-target')
  })

  it('never regresses a cache snapshot that is newer than the disk row it stamps (ack-to-echo window)', async () => {
    await seedRow({id: 'cached-ahead-ref', content: '((some-target))'})
    const {repo, cache} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    // Hydrate the row into the cache pre-pass (stale: column null).
    const preloaded = await repo.load('cached-ahead-ref')
    expect(preloaded?.referenceTargetId).toBeNull()
    const current = cache.getSnapshot('cached-ahead-ref')
    expect(current).toBeDefined()

    // Simulate the sync ack-to-echo window: a local edit lands in the cache
    // (newer updatedAt) after hydration but before the repair pass runs —
    // disk still holds the pre-edit content/version.
    const newer = {...current!, content: 'newer local text', updatedAt: current!.updatedAt + 5000}
    cache.setSnapshot(newer)

    await runPass(repo)

    // Disk stamps: the CAS matched the (unchanged) disk row's (content,
    // NULL column) pair.
    expect(await readColumn('cached-ahead-ref')).toBe('some-target')
    // The cache must never be regressed by the older disk row's stamp — the
    // fan-out's `cached.updatedAt <= after.updatedAt` guard skips writing
    // back into a cache entry that is already newer than the stamped row.
    const afterPass = cache.getSnapshot('cached-ahead-ref')
    expect(afterPass?.content).toBe('newer local text')
    expect(afterPass?.updatedAt).toBe(current!.updatedAt + 5000)
  })
})

describe('core.aliasClaimRederive — alias claims schedule the late-binding rederive (#402)', () => {
  // The gap this hook closes: only the two seat-minting sites in
  // references.parseReferences used to schedule the rederive, so an alias
  // added via ANY other path (property panel, alias.sync, typeify, agent
  // bridge) left existing NULL-stamped `[[alias]]` rows stale until the
  // next workspace open's sweep.
  // The hook fires in post-commit dispatch; the drain rides the deferred
  // idle queue (setTimeout(0) under Node), so poll the outcome rather
  // than sleeping (AGENTS.md) — `awaitReferenceTargetDerive` inside the
  // poll awaits whatever drains have fired by then.
  const expectStamped = async (repo: Repo, id: string, target: string): Promise<void> => {
    await repo.awaitProcessors()
    await vi.waitFor(async () => {
      await repo.awaitReferenceTargetDerive()
      expect(await readColumn(id)).toBe(target)
    })
  }

  it('re-stamps an existing [[alias]] row when a property write claims the alias', async () => {
    const repo = setup()
    await runPass(repo)  // sweep done — pre-sweep the schedule no-ops by design

    // Written before anything claims "Foo": derives to NULL.
    await repo.tx(async tx => {
      await tx.create({id: 'referrer', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[Foo]]'})
      await tx.create({id: 'target', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Foo page'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await readColumn('referrer')).toBeNull()

    // The claim arrives via a plain property write — one of the paths that
    // never scheduled the repair before this hook.
    await repo.tx(tx => tx.setProperty('target', aliasesProp, ['Foo']),
      {scope: ChangeScope.BlockDefault})

    await expectStamped(repo, 'referrer', 'target')
  })

  it('re-stamps when a tombstoned claimant is restored (deleted → live counts as gaining every alias)', async () => {
    const repo = setup()
    await runPass(repo)

    await repo.tx(async tx => {
      await tx.create({id: 'target', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Foo page'})
      await tx.setProperty('target', aliasesProp, ['Foo'])
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.delete('target'), {scope: ChangeScope.BlockDefault})
    // Written while the claimant is tombstoned: unresolvable, NULL stamp.
    await repo.tx(async tx => {
      await tx.create({id: 'referrer', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[Foo]]'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await readColumn('referrer')).toBeNull()

    await repo.tx(tx => tx.restore('target'), {scope: ChangeScope.BlockDefault})

    await expectStamped(repo, 'referrer', 'target')
  })
})

describe('late-binding stamp → owner-cell re-projection (§9 recognition, issue #402 group 1)', () => {
  // A marked `::[[Foo]]` row written before anything claims "Foo" derives
  // to a NULL target, so §9's third condition (the target resolves to a
  // definition) fails and the row is NOT yet a field row. The alias claim
  // is what makes it one — and the stamp that records it is a raw UPDATE
  // outside `repo.tx` (it must not advance `updated_at`), so NO processor
  // observes the transition. Without an explicit re-projection the owner's
  // cell would stay unkeyed until some unrelated edit to the subtree.
  const flipWorkspace = (): Promise<unknown> => sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
    [WS, 'test ws', 'user-1'],
  )

  /** The workspace as it exists before slice C touches it: present, dormant.
   *  Seeding through this and flipping afterwards is what reproduces the
   *  real rollout state — cells full of values, no field rows materialized. */
  const seedDormantWorkspace = (): Promise<unknown> => sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'cell')`,
    [WS, 'test ws', 'user-1'],
  )

  const flipSeededWorkspace = (): Promise<unknown> => sharedDb.db.execute(
    `UPDATE workspaces SET properties_migration = 'children' WHERE id = ?`, [WS],
  )

  const cellOf = async (id: string, name: string): Promise<unknown> => {
    const row = await sharedDb.db.get<{properties_json: string}>(
      'SELECT properties_json FROM blocks WHERE id = ?', [id],
    )
    return (JSON.parse(row.properties_json) as Record<string, unknown>)[name]
  }

  /** owner → marked-or-plain `[[Foo]]` child → value child, with nothing
   *  claiming "Foo" yet. */
  const seedUnresolvedRow = async (repo: Repo, content: string): Promise<void> => {
    await repo.tx(async tx => {
      await tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({
        id: STATUS_FIELD_ID, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'status',
      })
      await tx.create({id: 'row', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content})
      await tx.create({id: 'value', workspaceId: WS, parentId: 'row', orderKey: 'a0', content: 'done'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await readColumn('row')).toBeNull()
    expect(await cellOf('owner', statusSchema.name)).toBeUndefined()
  }

  const claimAlias = async (repo: Repo): Promise<void> => {
    await repo.tx(tx => tx.setProperty(STATUS_FIELD_ID, aliasesProp, ['Foo']),
      {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    await vi.waitFor(async () => {
      await repo.awaitReferenceTargetDerive()
      expect(await readColumn('row')).toBe(STATUS_FIELD_ID)
    })
  }

  /** A user-declared refList definition, `named-refs`, keyed `named-ref-field`. */
  const registerNamedRefs = (repo: Repo) => {
    const schema = defineProperty('named-refs', {codec: codecs.refList(), defaultValue: [], changeScope: ChangeScope.BlockDefault})
    repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-named-refs', [{
      metadata: {fieldId: 'named-ref-field', workspaceId: WS, createdAt: 1, name: schema.name,
        changeScope: schema.changeScope, hidden: false, origin: 'user' as const}, schema,
    }], {workspaceId: WS})
    return schema
  }

  it('leaves an old named-value projection alone on open, then refreshes on content edit', async () => {
    await flipWorkspace()
    const repo = setup()
    const schema = registerNamedRefs(repo)
    await seedRow({id: 'named-owner', properties: {[schema.name]: [], unrelated: 'keep'}})
    await seedRow({id: 'named-field', parentId: 'named-owner', content: '::((named-ref-field))',
      referenceTargetId: 'named-ref-field', isFieldForm: true})
    await seedRow({id: 'named-value', parentId: 'named-field', content: '[[Existing name]]', referenceTargetId: 'existing-target'})
    await seedRow({id: 'existing-target', properties: {[aliasesProp.name]: ['Existing name']}})
    expect(await cellOf('named-owner', schema.name)).toEqual([])
    await runPass(repo)
    expect(await cellOf('named-owner', schema.name)).toEqual([])
    await repo.tx(tx => tx.update('named-value', {content: '[[Existing name]] '}),
      {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    expect(await cellOf('named-owner', schema.name)).toEqual(['existing-target'])
    expect(await cellOf('named-owner', 'unrelated')).toBe('keep')
    expect(await repo.load('named-value')).toMatchObject({content: '[[Existing name]] '})
  })

  it('projects a refList member when its previously missing name resolves', async () => {
    await flipWorkspace()
    const repo = setup()
    const schema = registerNamedRefs(repo)
    await runPass(repo)
    await repo.tx(async tx => {
      await tx.create({id: 'named-owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'owner'})
      await tx.create({id: 'late-target', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'target'})
      await tx.create({id: 'named-field', workspaceId: WS, parentId: 'named-owner', orderKey: 'a0', content: '::((named-ref-field))'})
      await tx.create({id: 'named-value', workspaceId: WS, parentId: 'named-field', orderKey: 'a0', content: '[[Late name]]'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await readColumn('named-value')).toBeNull()
    expect(await cellOf('named-owner', schema.name)).toEqual([])
    const before = await repo.load('named-value')
    await repo.tx(tx => tx.setProperty('late-target', aliasesProp, ['Late name']), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    await vi.waitFor(async () => {
      await repo.awaitReferenceTargetDerive()
      expect(await readColumn('named-value')).toBe('late-target')
      expect(await cellOf('named-owner', schema.name)).toEqual(['late-target'])
    })
    expect(await repo.load('named-value')).toMatchObject({content: '[[Late name]]', updatedAt: before!.updatedAt})
  })

  /** A synced owner whose refList cell another device projected from
   *  `[[name]]` value rows that this device has not stamped yet — the state a
   *  fresh device's first open finds. `names` are the value rows' names, in
   *  sibling order; `cell` is the stored value. */
  const seedSyncedNamedRefList = async (
    repo: Repo, names: readonly string[], cell: readonly string[],
  ) => {
    const schema = registerNamedRefs(repo)
    // `references` as the owner's own parse derives them from that cell, so
    // the only write a pass could owe this row is a property one.
    await seedRow({id: 'named-owner', properties: {[schema.name]: [...cell]},
      references: cell.map(id => ({id, alias: id, sourceField: schema.name}))})
    await seedRow({id: 'named-field', parentId: 'named-owner', content: '::((named-ref-field))',
      referenceTargetId: 'named-ref-field', isFieldForm: true})
    for (const [i, name] of names.entries()) {
      await seedRow({id: `named-value-${i}`, parentId: 'named-field', orderKey: `a${i}`, content: `[[${name}]]`})
    }
    return schema
  }

  const ownerWrites = async (): Promise<unknown[]> =>
    sharedDb.db.getAll(`SELECT id FROM ps_crud WHERE data LIKE '%named-owner%'`)

  it('the sweep never drops a list member whose name this device cannot resolve yet', async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'target-a', properties: {[aliasesProp.name]: ['Name A']}})
    // "Name C"'s page has not reached this device, so its row stays unstamped.
    const schema = await seedSyncedNamedRefList(repo, ['Name A', 'Name C'], ['target-a', 'target-c'])

    await runPass(repo)
    await repo.awaitProcessors()

    // Precondition: the sweep did stamp the sibling, so the resolved-values
    // projection ran over this owner.
    expect(await readColumn('named-value-0')).toBe('target-a')
    expect(await readColumn('named-value-1')).toBeNull()
    expect(await cellOf('named-owner', schema.name)).toEqual(['target-a', 'target-c'])
    expect(await ownerWrites()).toEqual([])
  })

  it('still adds a member that resolves while a sibling never will', async () => {
    await flipWorkspace()
    const repo = setup()
    const schema = registerNamedRefs(repo)
    await runPass(repo)
    // Typed before either page exists; "Never name" never gets one here.
    await repo.tx(async tx => {
      await tx.create({id: 'named-owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'owner'})
      await tx.create({id: 'late-target', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'target'})
      await tx.create({id: 'named-field', workspaceId: WS, parentId: 'named-owner', orderKey: 'a0', content: '::((named-ref-field))'})
      await tx.create({id: 'named-value', workspaceId: WS, parentId: 'named-field', orderKey: 'a0', content: '[[Late name]]'})
      await tx.create({id: 'never-value', workspaceId: WS, parentId: 'named-field', orderKey: 'a1', content: '[[Never name]]'})
    }, {scope: ChangeScope.BlockDefault})
    expect(await cellOf('named-owner', schema.name)).toEqual([])

    await repo.tx(tx => tx.setProperty('late-target', aliasesProp, ['Late name']), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    await vi.waitFor(async () => {
      await repo.awaitReferenceTargetDerive()
      expect(await readColumn('named-value')).toBe('late-target')
      expect(await cellOf('named-owner', schema.name)).toEqual(['late-target'])
    })
    expect(await readColumn('never-value')).toBeNull()

    // A write made from the cell must not take the resolved member's row with it.
    await repo.tx(tx => tx.setProperty('named-owner', schema, ['late-target', 'other']),
      {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    expect(await repo.load('named-value')).toMatchObject({content: '[[Late name]]', deleted: false})
  })

  it('writes nothing when two members of one list resolve in different stamp chunks', async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'target-a', properties: {[aliasesProp.name]: ['Name A']}})
    await seedRow({id: 'target-b', properties: {[aliasesProp.name]: ['Name B']}})
    const schema = await seedSyncedNamedRefList(repo, ['Name A'], ['target-a', 'target-b'])
    // A full chunk of other resolvable rows between the two members puts the
    // second one in the sweep's next chunk.
    await sharedDb.db.writeTransaction(async tx => {
      for (let i = 0; i < REFERENCE_TARGET_STAMP_CHUNK; i += 1) {
        for (const filler of [
          {id: `filler-target-${i}`, properties: {[aliasesProp.name]: [`Filler ${i}`]}},
          {id: `filler-${i}`, content: `[[Filler ${i}]]`},
        ]) await tx.execute(INSERT_SQL, blockToRowParams(seededBlock(filler)))
      }
    })
    await seedRow({id: 'named-value-1', parentId: 'named-field', orderKey: 'a1', content: '[[Name B]]'})
    // Precondition: every candidate stamps, so its position in the scan is its
    // position in the stamp list.
    const scan = (await sharedDb.db.getAll<{id: string}>(REFERENCE_TARGET_SWEEP_CANDIDATES_SQL, [WS]))
      .map(row => row.id)
    const chunkOf = (id: string) => Math.floor(scan.indexOf(id) / REFERENCE_TARGET_STAMP_CHUNK)
    expect(chunkOf('named-value-0')).toBe(0)
    expect(chunkOf('named-value-1')).toBe(1)

    await runPass(repo)
    await repo.awaitProcessors()

    expect(await readColumn('named-value-0')).toBe('target-a')
    expect(await readColumn('named-value-1')).toBe('target-b')
    expect(await cellOf('named-owner', schema.name)).toEqual(['target-a', 'target-b'])
    // The flap's first write dropped `target-b` and its second restored it;
    // both uploaded.
    expect(await ownerWrites()).toEqual([])
    // Measured at 1.4–3.8s under a loaded machine: two stamp chunks.
  }, 20_000)

  /** A synced `[target-a, target-c]` list whose `[[Name C]]` row this device
   *  cannot stamp, after the sweep has run. */
  const seedWithPendingSibling = async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'target-a', properties: {[aliasesProp.name]: ['Name A']}})
    await seedRow({id: 'target-b', properties: {[aliasesProp.name]: ['Name B']}})
    const schema = await seedSyncedNamedRefList(repo, ['Name A', 'Name C'], ['target-a', 'target-c'])
    await runPass(repo)
    await repo.awaitProcessors()
    expect(await readColumn('named-value-0')).toBe('target-a')
    expect(await readColumn('named-value-1')).toBeNull()
    return {repo, schema}
  }

  it("a user's removal lands at once while a sibling is pending", async () => {
    const {repo, schema} = await seedWithPendingSibling()

    await repo.tx(tx => tx.delete('named-value-0'), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await cellOf('named-owner', schema.name)).toEqual(['target-c'])
  })

  it('a user edit of one member keeps a pending sibling and replaces the edited one', async () => {
    const {repo, schema} = await seedWithPendingSibling()

    await repo.tx(tx => tx.update('named-value-0', {content: '[[Name B]]'}), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await readColumn('named-value-0')).toBe('target-b')
    expect(await cellOf('named-owner', schema.name)).toEqual(['target-c', 'target-b'])
  })

  it('an edit that keeps a member writes nothing while a sibling is pending', async () => {
    const {repo, schema} = await seedWithPendingSibling()

    await repo.tx(tx => tx.update('named-value-0', {content: '[[Name A]] '}), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await readColumn('named-value-0')).toBe('target-a')
    expect(await cellOf('named-owner', schema.name)).toEqual(['target-a', 'target-c'])
    expect(await ownerWrites()).toEqual([])
  })

  /** Two field rows for one definition under a `[target-a, target-c]` owner:
   *  `named-field-2` holds the resolved `[[Name A]]`, the other the pending
   *  `[[Name C]]`; `other-owner` is a block to move a field row to. */
  const seedTwoFieldRows = async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'target-a', properties: {[aliasesProp.name]: ['Name A']}})
    await seedRow({id: 'target-b', properties: {[aliasesProp.name]: ['Name B']}})
    const schema = await seedSyncedNamedRefList(repo, ['Name C'], ['target-a', 'target-c'])
    await seedRow({id: 'named-field-2', parentId: 'named-owner', orderKey: 'b0', content: '::((named-ref-field))',
      referenceTargetId: 'named-ref-field', isFieldForm: true})
    await seedRow({id: 'moved-value', parentId: 'named-field-2', content: '[[Name A]]'})
    await seedRow({id: 'other-owner', orderKey: 'zz', content: 'other'})
    await runPass(repo)
    await repo.awaitProcessors()
    expect(await readColumn('moved-value')).toBe('target-a')
    expect(await readColumn('named-value-0')).toBeNull()
    expect(await cellOf('named-owner', schema.name)).toEqual(['target-a', 'target-c'])
    return {repo, schema}
  }

  it('moving a whole field row away removes its members while a sibling field row is pending', async () => {
    const {repo, schema} = await seedTwoFieldRows()

    await repo.tx(tx => tx.move('named-field-2', {parentId: 'other-owner', orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await cellOf('named-owner', schema.name)).toEqual(['target-c'])
    expect(await cellOf('other-owner', schema.name)).toEqual(['target-a'])
  })

  // Both orders: which of a row's two states the departure set keeps must not
  // depend on whether the value or its field row changed first.
  it.each([
    ['move, then rewrite', ['move', 'rewrite']],
    ['rewrite, then move', ['rewrite', 'move']],
  ] as const)('a field row moved with its value rewritten in one tx removes the value it held (%s)', async (_case, steps) => {
    const {repo, schema} = await seedTwoFieldRows()

    await repo.tx(async tx => {
      for (const step of steps) {
        if (step === 'move') await tx.move('named-field-2', {parentId: 'other-owner', orderKey: 'a0'})
        else await tx.update('moved-value', {content: '[[Name B]]'})
      }
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await cellOf('named-owner', schema.name)).toEqual(['target-c'])
    expect(await cellOf('other-owner', schema.name)).toEqual(['target-b'])
  })

  /** A user-declared scalar `ref` keyed `named-ref-scalar`, stored `stored`,
   *  with value rows of `contents` in sibling order. */
  const seedScalarRef = async (repo: Repo, contents: readonly string[], stored: string) => {
    const schema = defineProperty('named-ref', {codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault})
    repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, 'test-named-ref', [{
      metadata: {fieldId: 'named-ref-scalar', workspaceId: WS, createdAt: 1, name: schema.name,
        changeScope: schema.changeScope, hidden: false, origin: 'user' as const}, schema,
    }], {workspaceId: WS})
    await seedRow({id: 'scalar-owner', properties: {[schema.name]: stored},
      references: [{id: stored, alias: stored, sourceField: schema.name}]})
    await seedRow({id: 'scalar-field', parentId: 'scalar-owner', content: '::((named-ref-scalar))',
      referenceTargetId: 'named-ref-scalar', isFieldForm: true})
    for (const [i, content] of contents.entries()) {
      await seedRow({id: `scalar-value-${i}`, parentId: 'scalar-field', orderKey: `a${i}`, content})
    }
    return schema
  }

  it('a scalar edit lands while a later sibling is pending', async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'target-a', properties: {[aliasesProp.name]: ['Name A']}})
    await seedRow({id: 'target-b', properties: {[aliasesProp.name]: ['Name B']}})
    const schema = await seedScalarRef(repo, ['[[Name A]]', '[[Name C]]'], 'target-a')
    await runPass(repo)
    await repo.awaitProcessors()
    expect(await readColumn('scalar-value-1')).toBeNull()

    await repo.tx(tx => tx.update('scalar-value-0', {content: '[[Name B]]'}), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await readColumn('scalar-value-0')).toBe('target-b')
    expect(await cellOf('scalar-owner', schema.name)).toBe('target-b')
  })

  it('a stamp still repairs a stale scalar while a later sibling is pending', async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'target-b', properties: {[aliasesProp.name]: ['Name B']}})
    const schema = await seedScalarRef(repo, ['[[Name B]]', '[[Name C]]'], 'target-a')

    await runPass(repo)
    await repo.awaitProcessors()

    expect(await readColumn('scalar-value-0')).toBe('target-b')
    expect(await readColumn('scalar-value-1')).toBeNull()
    expect(await cellOf('scalar-owner', schema.name)).toBe('target-b')
  })

  it('a scalar keeps the stored value an earlier pending sibling may hold', async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'target-a', properties: {[aliasesProp.name]: ['Name A']}})
    await seedRow({id: 'target-b', properties: {[aliasesProp.name]: ['Name B']}})
    const schema = await seedScalarRef(repo, ['[[Name C]]', '[[Name A]]'], 'target-c')
    await runPass(repo)
    await repo.awaitProcessors()
    expect(await readColumn('scalar-value-0')).toBeNull()
    expect(await cellOf('scalar-owner', schema.name)).toBe('target-c')

    await repo.tx(tx => tx.update('scalar-value-1', {content: '[[Name B]]'}), {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await readColumn('scalar-value-1')).toBe('target-b')
    expect(await cellOf('scalar-owner', schema.name)).toBe('target-c')
  })

  it('a field row moved with its value deleted in one tx removes the value from its old owner', async () => {
    const {repo, schema} = await seedTwoFieldRows()

    await repo.tx(async tx => {
      await tx.move('named-field-2', {parentId: 'other-owner', orderKey: 'a0'})
      await tx.delete('moved-value')
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    expect(await cellOf('named-owner', schema.name)).toEqual(['target-c'])
  })

  it('a block merge mints no duplicate for a pending member, and converges once it resolves', async () => {
    const {repo, schema} = await seedWithPendingSibling()
    await seedRow({id: 'into-owner', orderKey: 'zz', content: 'into'})

    await repo.tx(async tx => {
      await mergeBlocksInTx(tx, {into: (await tx.get('into-owner'))!, from: (await tx.get('named-owner'))!})
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()

    const liveValues = async () => (await sharedDb.db.getAll<{content: string}>(
      `SELECT v.content FROM blocks v JOIN blocks f ON v.parent_id = f.id
        WHERE f.parent_id = 'into-owner' AND f.is_field_form = 1 AND f.deleted = 0 AND v.deleted = 0
        ORDER BY v.order_key, v.id`)).map(row => row.content)
    expect(await liveValues()).toEqual(['[[Name A]]', '[[Name C]]'])

    await repo.tx(async tx => {
      await tx.create({id: 'target-c', workspaceId: WS, parentId: null, orderKey: 'a9', content: 'target'})
      await tx.setProperty('target-c', aliasesProp, ['Name C'])
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    await vi.waitFor(async () => {
      await repo.awaitReferenceTargetDerive()
      expect(await readColumn('named-value-1')).toBe('target-c')
      expect(await cellOf('into-owner', schema.name)).toEqual(['target-a', 'target-c'])
    })
    expect(await liveValues()).toEqual(['[[Name A]]', '[[Name C]]'])
  })

  it('with nothing left pending, a stamp still repairs a stale member', async () => {
    await flipWorkspace()
    const repo = setup()
    await seedRow({id: 'new-target', properties: {[aliasesProp.name]: ['New name']}})
    const schema = await seedSyncedNamedRefList(repo, ['New name'], ['old-target'])

    await runPass(repo)
    await repo.awaitProcessors()

    expect(await readColumn('named-value-0')).toBe('new-target')
    expect(await cellOf('named-owner', schema.name)).toEqual(['new-target'])
  })

  it('projects the owner cell when the claim turns a marked row into a field row', async () => {
    await flipWorkspace()
    const repo = setup()
    await runPass(repo)
    await seedUnresolvedRow(repo, '::[[Foo]]')

    await claimAlias(repo)

    // The stamp made `row` a recognized field row for the status property,
    // and its value child projected onto the owner in the same repair.
    await vi.waitFor(async () => {
      expect(await cellOf('owner', statusSchema.name)).toBe('done')
    })

    // The ADD path writes an unsettled cell key, so materialize runs over it
    // and converges the field row to the canonical id form. That
    // canonicalization is materialize's pre-existing behavior for EVERY
    // field row it touches (unchanged on master — this branch only changed
    // what "canonical" means), so the alias form is transient by design and
    // the same rewrite would land on the user's next property edit anyway.
    // Pinned so a future change to the repair path can't quietly start
    // preserving or mangling the form without someone deciding to.
    await repo.awaitProcessors()
    const row = await sharedDb.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?', ['row'],
    )
    expect(row.content).toBe(`::((${STATUS_FIELD_ID}))`)
    // What must NOT change is the value — the repair added the key, and the
    // user's value child still backs it.
    expect(await cellOf('owner', statusSchema.name)).toBe('done')
  })

  it('leaves the owner cell alone when the late-bound row is UNMARKED', async () => {
    await flipWorkspace()
    const repo = setup()
    await runPass(repo)
    await seedUnresolvedRow(repo, '[[Foo]]')

    await claimAlias(repo)

    // Same stamp, same resolution — but no `::`, so the row is an ordinary
    // reference and `value` is an ordinary child, not a property value.
    await repo.awaitProcessors()
    expect(await cellOf('owner', statusSchema.name)).toBeUndefined()
  })

  // The repair is ADDITIVE: it may give an owner a key it lacked, never
  // change or remove one it already has. This is the state every owner is in
  // for the whole window between a workspace flipping and its backfill
  // landing — a full cell, no field rows yet — so a repair that re-projected
  // it wholesale would read "no parseable value" as "unset this key", and
  // the follow-on materialize (unsettled, because this write is not the
  // PROJECT processor's) would read that unset as a user's key deletion and
  // tombstone the rows. Adversarial review reproduced exactly that.
  /** The rollout state: seed while dormant (so cells populate with NO field
   *  rows), then flip. `valueContent` null = the marked row has no child at
   *  all, so nothing under it parses as a value. */
  const seedPreFlipOwner = async (
    repo: Repo, valueContent: string | null,
  ): Promise<void> => {
    await repo.tx(async tx => {
      await tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({
        id: STATUS_FIELD_ID, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'status',
      })
      await tx.setProperty('owner', statusSchema, 'pre-existing')
      // A marked row that will late-bind to the status definition once the
      // alias is claimed.
      await tx.create({id: 'row', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: '::[[Foo]]'})
      if (valueContent !== null) {
        await tx.create({id: 'value', workspaceId: WS, parentId: 'row', orderKey: 'a0', content: valueContent})
      }
    }, {scope: ChangeScope.BlockDefault})
    // Dormant: the cell holds the value and nothing was materialized.
    expect(await cellOf('owner', statusSchema.name)).toBe('pre-existing')
    await flipSeededWorkspace()
  }

  it('never unsets a cell key the owner already holds, even with no parseable value', async () => {
    await seedDormantWorkspace()
    const repo = setup()
    await runPass(repo)
    await seedPreFlipOwner(repo, null)

    await claimAlias(repo)
    await repo.awaitProcessors()

    // The key survives untouched…
    expect(await cellOf('owner', statusSchema.name)).toBe('pre-existing')
    // …and so does the row the user authored. A tombstone here is the
    // materialize cascade the additive rule exists to prevent: the repair
    // write is not settled, so an unset would read back as a key deletion.
    const row = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', ['row'],
    )
    expect(row.deleted).toBe(0)
  })

  it('does not overwrite a cell key the owner already holds', async () => {
    await seedDormantWorkspace()
    const repo = setup()
    await runPass(repo)
    await seedPreFlipOwner(repo, 'from-children')

    await claimAlias(repo)
    await repo.awaitProcessors()

    // Children ARE truth post-flip, but reconciling a populated cell against
    // them is the backfill's job, not a background stamp repair's — and
    // winning here would also let the unsettled write drive materialize into
    // rewriting the user's `::[[Foo]]` text to a canonical `::((id))`.
    expect(await cellOf('owner', statusSchema.name)).toBe('pre-existing')
    const row = await sharedDb.db.get<{content: string}>(
      'SELECT content FROM blocks WHERE id = ?', ['row'],
    )
    expect(row.content).toBe('::[[Foo]]')
  })

  // Dormancy is the entire safety argument for landing this branch ahead of
  // slice C, and on this path it rests on one line. Without a test, deleting
  // the flip gate makes a cell-mode workspace's catch-up sweep start writing
  // user-visible `properties_json` keys, and the whole suite stays green.
  it('writes nothing in a DORMANT workspace — the flip gate is what arms this', async () => {
    await seedDormantWorkspace()
    const repo = setup()
    await runPass(repo)
    await repo.tx(async tx => {
      await tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({
        id: STATUS_FIELD_ID, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'status',
      })
      await tx.create({id: 'row', workspaceId: WS, parentId: 'owner', orderKey: 'a0', content: '::[[Foo]]'})
      await tx.create({id: 'value', workspaceId: WS, parentId: 'row', orderKey: 'a0', content: 'done'})
    }, {scope: ChangeScope.BlockDefault})

    await claimAlias(repo)
    await repo.awaitProcessors()

    // The stamp still lands — the columns are slice-A machinery, maintained
    // everywhere — but nothing projects onto the owner.
    expect(await readColumn('row')).toBe(STATUS_FIELD_ID)
    expect(await cellOf('owner', statusSchema.name)).toBeUndefined()
  })

  // The sweep documents itself as "safe in a read-only workspace" because its
  // writes are local bookkeeping. A projection tx is NOT that: its scope is
  // rejected in read-only mode, and the throw would escape before the sweep
  // marks itself done — disabling late-binding for the rest of the session.
  /** Raw-seeded owner → `::((fieldId))` row → value, all with NULL derived
   *  columns, so the catch-up SWEEP is what stamps and recognizes them. The
   *  id form resolves textually, so no alias claim is needed. */
  const rawSeedSweepFixture = async (): Promise<void> => {
    await seedRow({id: 'owner', content: 'page'})
    await seedRow({id: 'row', parentId: 'owner', content: `::((${STATUS_FIELD_ID}))`})
    await seedRow({id: 'value', parentId: 'row', content: 'done'})
    await flipSeededWorkspace()
  }

  // The sweep documents itself as "NOT gated on writability … safe in a
  // read-only workspace" because its writes are raw local bookkeeping. A
  // projection tx is NOT that — its scope is rejected in read-only mode, and
  // the throw escapes before the sweep marks itself done, which disables
  // late-binding for the rest of the session.
  it('skips the re-projection in a read-only workspace rather than throwing', async () => {
    await seedDormantWorkspace()
    const repo = setup()
    await rawSeedSweepFixture()
    repo.setReadOnly(true)
    // The guard has to be pinned on the ATTEMPT, not the outcome: the
    // projection tx is wrapped in a catch, so without the guard the throw is
    // swallowed and every other observable here looks identical. A silent
    // console.error on every read-only workspace open is exactly the
    // regression this catches.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(runPass(repo)).resolves.toBeUndefined()

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    // The local bookkeeping still happened — that part really is read-only
    // safe — but no cell was written.
    expect(await readColumn('row')).toBe(STATUS_FIELD_ID)
    expect(await cellOf('owner', statusSchema.name)).toBeUndefined()
  })

  // Adding the key is an unsettled write, so materialize follows it — and
  // with two field rows for one definition that means
  // `collapseDuplicateFieldRow`, which tombstones the loser and uploads the
  // tombstone. A background repair must not reap a user's row.
  it('declines to break a tie — two field rows for one definition are left alone', async () => {
    await seedDormantWorkspace()
    const repo = setup()
    await runPass(repo)
    await repo.tx(async tx => {
      await tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({
        id: STATUS_FIELD_ID, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'status',
      })
      await tx.create({id: 'rowA', workspaceId: WS, parentId: 'owner', orderKey: 'a2', content: '::[[Foo]]'})
      await tx.create({id: 'valA', workspaceId: WS, parentId: 'rowA', orderKey: 'a0', content: 'from-A'})
      await tx.create({id: 'rowB', workspaceId: WS, parentId: 'owner', orderKey: 'a3', content: '::[[Foo]]'})
      await tx.create({id: 'valB', workspaceId: WS, parentId: 'rowB', orderKey: 'a0', content: 'from-B'})
    }, {scope: ChangeScope.BlockDefault})
    await flipSeededWorkspace()

    await repo.tx(tx => tx.setProperty(STATUS_FIELD_ID, aliasesProp, ['Foo']),
      {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    await vi.waitFor(async () => {
      await repo.awaitReferenceTargetDerive()
      expect(await readColumn('rowA')).toBe(STATUS_FIELD_ID)
      expect(await readColumn('rowB')).toBe(STATUS_FIELD_ID)
    })
    await repo.awaitProcessors()

    const rowB = await sharedDb.db.get<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', ['rowB'],
    )
    expect(rowB.deleted).toBe(0)
    // The cell stays unset too: the repair declined the whole projection
    // rather than picking a winner. A real user edit projects settled and
    // resolves it then.
    expect(await cellOf('owner', statusSchema.name)).toBeUndefined()
  })

  it('keeps the repair off the user cmd-Z stack', async () => {
    await flipWorkspace()
    const repo = setup()
    await runPass(repo)
    await seedUnresolvedRow(repo, '::[[Foo]]')

    await claimAlias(repo)
    await vi.waitFor(async () => {
      expect(await cellOf('owner', statusSchema.name)).toBe('done')
    })

    // Undo must revert the user's last action (the alias claim), never the
    // background repair that followed it.
    await repo.undo(ChangeScope.BlockDefault)
    expect(await cellOf(STATUS_FIELD_ID, aliasesProp.name)).toBeUndefined()
  })

  /** The stamp writes the derived target column while preserving parsed
   *  references; both remain independently observable after the pass. */
  it('stamps recognized field rows without changing their parsed references', async () => {
    await seedDormantWorkspace()
    const repo = setup()
    // The upgrading device's shape: derived columns NULL because they
    // predate the column, `references` already parsed by the older build.
    // Raw writes, so no processor re-derives anything before the sweep runs.
    await seedRow({id: 'owner', content: 'page'})
    await seedRow({
      id: STATUS_FIELD_ID,
      content: 'status',
      // The SQL predicate resolves definition-ness through `block_types`
      // (trigger-maintained), not through the runtime registry `setup()`
      // contributes — without the type this row would never recognize.
      properties: {[typesProp.name]: [PROPERTY_SCHEMA_TYPE]},
    })
    await seedRow({id: 'target-page', content: 'Target'})
    await seedRow({
      id: 'row', parentId: 'owner', content: `::((${STATUS_FIELD_ID}))`,
      references: [{id: STATUS_FIELD_ID, alias: STATUS_FIELD_ID}],
    })
    await seedRow({
      id: 'value', parentId: 'row', content: '[[Target]]',
      references: [{id: 'target-page', alias: 'Target'}],
    })
    await flipSeededWorkspace()

    await runPass(repo)
    expect(await readColumn('row')).toBe(STATUS_FIELD_ID)

    // Parse writes references from content alone, independent of derived
    // recognition, and the pass leaves those stored references untouched.
    expect(await refsOf('row')).toEqual([{id: STATUS_FIELD_ID, alias: STATUS_FIELD_ID}])
    expect(await refsOf('value')).toEqual([{id: 'target-page', alias: 'Target'}])
  })
})

describe('candidate scans', () => {
  // Pins that each query's literal predicate still proves the partial index
  // (`INDEXED BY` throws at prepare time otherwise) and that the plan is an
  // index SEARCH, not a full-index SCAN. Whether the planner would pick the
  // index unhinted is not what this checks; the hint is there because it
  // does not on a real DB without statistics.
  it('both candidate queries plan to a SEARCH of the reference-candidates index', async () => {
    for (const sql of [REFERENCE_TARGET_SWEEP_CANDIDATES_SQL, REFERENCE_TARGET_REDERIVE_CANDIDATES_SQL]) {
      const plan = (await sharedDb.db.getAll<{detail: string}>(`EXPLAIN QUERY PLAN ${sql}`, ['ws']))
        .map(row => row.detail).join(' | ')
      expect(plan).toContain(`SEARCH blocks USING INDEX ${BLOCKS_REFERENCE_CANDIDATES_INDEX}`)
    }
  })
})
