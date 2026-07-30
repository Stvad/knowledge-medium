// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type BlockData } from '@/data/api'
import { BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams } from '@/data/blockSchema'
import { BLOCK_TYPE_TYPE, PAGE_TYPE } from '@/data/blockTypes'
import { typeDefinitionBlockId } from '@/data/definitionSeeds'
import { keyAtEnd } from '@/data/orderKey'
import {
  aliasesProp,
  blockTypeLabelProp,
  getAliases,
  seedKeyProp,
  typesProp,
} from '@/data/properties'
import { getOrCreateTypesPage } from '@/data/typesPage'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension'
import { blockTypeNameAliasBackfill } from './blockTypeAliasBackfill'

const WS = 'ws-block-type-alias-backfill'

let sharedDb: TestDb
let repo: Repo

const setup = async (): Promise<Repo> => {
  await resetTestDb(sharedDb.db)
  const built = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    // The alias plugin is loaded so the backfill's alias writes run against
    // the REAL content<->alias sync, not in isolation.
    extensions: [aliasDataExtension],
  })
  built.repo.setActiveWorkspaceId(WS)
  await getOrCreateTypesPage(built.repo, WS)
  return built.repo
}

const INSERT_SQL =
  `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`

/** Raw-insert a row, bypassing `repo.tx` entirely. Used where the row must NOT
 *  be completed by `core.blockTypeTypeify`, or where its `createdAt` /
 *  workspace must be controlled exactly. Raw writes still fire the
 *  `block_aliases` / `block_types` maintenance triggers (both gated on
 *  `properties_json`), but NOT `block_aliases_workspace_alias_unique` (gated on
 *  `tx_context.source IS NOT NULL`) — which is what lets the duplicate-claim
 *  fixtures below exist at all. */
const seedRow = (
  overrides: Partial<BlockData> & {id: string},
  execute: (sql: string, params: unknown[]) => Promise<unknown> =
    (sql, params) => sharedDb.db.execute(sql, params),
): Promise<unknown> =>
  execute(INSERT_SQL, blockToRowParams({
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
  } as BlockData))

const legacyTypeProperties = (
  label: string,
  extraProps: Record<string, unknown> = {},
): Record<string, unknown> => ({
  [typesProp.name]: [BLOCK_TYPE_TYPE, PAGE_TYPE],
  [blockTypeLabelProp.name]: label,
  ...extraProps,
})

/** A type block in the shape it had BEFORE the write-time alias claim landed:
 *  `block-type` + `page` tagged, label + content set, no alias. Verified
 *  field-for-field against what `createTypeBlock` wrote at `98acca05a^`.
 *
 *  Created through `repo.mutate.createChild` (so it is a real child of the
 *  Types page) and then raw-UPDATEd, because going through `repo.tx` for the
 *  properties write would fire `core.blockTypeTypeify`, which claims the alias
 *  and makes the row un-legacy. */
const makeLegacyType = async (
  target: Repo,
  label: string,
  extraProps: Record<string, unknown> = {},
): Promise<string> => {
  const id = await target.mutate.createChild({parentId: target.typesPageId!})
  await writeLegacyTypeShape(target, id, label, extraProps)
  return id
}

/** The raw `UPDATE` behind `makeLegacyType`, split out so the seed-owned case
 *  can drive it at a deterministic `/type/` id (`isValidSeededDefinition` only
 *  recognises a seed row whose id satisfies the hash for its own workspace). */
const writeLegacyTypeShape = async (
  target: Repo,
  id: string,
  label: string,
  extraProps: Record<string, unknown>,
): Promise<void> => {
  const row = await target.load(id)
  if (!row) throw new Error(`missing block ${id}`)
  await sharedDb.db.writeTransaction(async tx => {
    await tx.execute(
      'UPDATE blocks SET content = ?, properties_json = ? WHERE id = ?',
      [label, JSON.stringify({...row.properties, ...legacyTypeProperties(label, extraProps)}), id],
    )
  })
}

/** A live page claiming `alias` — the rival the backfill must not rob. */
const makeAliasedPage = async (target: Repo, alias: string): Promise<string> => {
  const id = await target.mutate.createChild({parentId: target.typesPageId!})
  await target.tx(async tx => {
    await tx.update(id, {content: alias})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
  return id
}

/** Drain the deep-idle-deferred backfill. Owns the fake-clock window, since
 *  that deferral is the only thing in these tests that needs one. */
const runBackfill = async (target: Repo): Promise<void> => {
  vi.useFakeTimers()
  try {
    target.scheduleWorkspaceBackfills(WS)
    await vi.runAllTimersAsync()
    await target.awaitWorkspaceBackfills()
    await target.awaitProcessors()
    // Flush again: the post-commit hooks the claims fired (notably
    // `core.aliasClaimRederive`) enqueue their own deferred work, which would
    // be discarded by the switch back to real timers.
    await vi.runAllTimersAsync()
  } finally {
    vi.useRealTimers()
  }
}

/** Drive `run` directly with a hand-built context. The per-row rechecks inside
 *  the tx defend against state that changed AFTER the candidate SELECT, so the
 *  only way to exercise them is to hand the pass a candidate the SELECT itself
 *  would never have returned. */
const runDirect = async (target: Repo, ids: readonly string[]): Promise<void> => {
  await blockTypeNameAliasBackfill.run({
    workspaceId: WS,
    getAll: (async () => ids.map(id => ({id}))) as never,
    tx: target.tx.bind(target),
  })
  await target.awaitProcessors()
}

/** Capture the pass's own warnings. The in-tx claimant veto and the
 *  swallow-the-latent-collision catch produce the SAME end state (row left
 *  alias-less, batch intact), so the diagnostic is the only thing that
 *  distinguishes them — and a wrong or spurious one is a real defect: it is
 *  the sole signal a user gets that a type was skipped, and it tells them
 *  what to do about it. */
const captureWarnings = (): string[] => {
  const seen: string[] = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    const text = args.map(String).join(' ')
    if (text.includes('[blockTypeNameAliasBackfill]')) seen.push(text)
  })
  return seen
}

const aliasesOf = async (target: Repo, id: string): Promise<readonly string[]> => {
  const row = await target.load(id)
  if (!row) throw new Error(`missing block ${id}`)
  return getAliases(row)
}

/** The stored alias property, read straight from the row — works on a
 *  tombstone, which `repo.load` won't return. */
const storedAliases = async (id: string): Promise<unknown> => {
  const row = await sharedDb.db.getOptional<{v: string | null}>(
    `SELECT json_extract(properties_json, '$."${aliasesProp.name}"') AS v FROM blocks WHERE id = ?`,
    [id],
  )
  return row?.v ?? null
}

/** Alias entries the trigger-maintained index actually holds for a block —
 *  the ground truth `[[X]]` resolves through, which can differ from the
 *  property bag when the stored value is malformed. */
const indexedAliases = async (id: string): Promise<string[]> =>
  (await sharedDb.db.getAll<{alias: string}>(
    'SELECT alias FROM block_aliases WHERE block_id = ? ORDER BY alias', [id],
  )).map(r => r.alias)

/** ps_crud ops for a block id — proof a write did (or did not) reach the
 *  upload queue. */
const uploadOps = async (id: string): Promise<string[]> =>
  (await sharedDb.db.getAll<{data: string}>('SELECT data FROM ps_crud ORDER BY id'))
    .map(r => JSON.parse(r.data) as {op: string; id: string})
    .filter(e => e.id === id)
    .map(e => e.op)

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { repo = await setup() })
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('blockTypeNameAliasBackfill', () => {
  it('claims the label so [[label]] resolves to a legacy type block', async () => {
    const id = await makeLegacyType(repo, 'Author')
    expect(await aliasesOf(repo, id)).toEqual([])

    await runBackfill(repo)

    expect(await aliasesOf(repo, id)).toEqual(['Author'])
    const resolved = await repo.query.aliasLookup({workspaceId: WS, alias: 'Author'}).load()
    expect(resolved?.id).toBe(id)
  })

  it('appends to — never replaces — an alias set the user already curated', async () => {
    const id = await makeLegacyType(repo, 'Author', {[aliasesProp.name]: ['Scribe']})

    await runBackfill(repo)

    expect(await aliasesOf(repo, id)).toEqual(['Scribe', 'Author'])
  })

  it('leaves the type alias-less when another block already claims the name', async () => {
    const pageId = await makeAliasedPage(repo, 'Author')
    const typeId = await makeLegacyType(repo, 'Author')
    // A bystander in the SAME batch tx. Without the in-tx claimant check the
    // colliding `setProperty` trips `block_aliases_workspace_alias_unique` and
    // rolls the whole batch back, so this is what proves the veto is doing the
    // work rather than the storage trigger catching it after the damage.
    const bystanderId = await makeLegacyType(repo, 'Publisher')
    const warnings = captureWarnings()

    await runBackfill(repo)

    expect(await aliasesOf(repo, typeId)).toEqual([])
    expect(await aliasesOf(repo, pageId)).toEqual(['Author'])
    expect(await aliasesOf(repo, bystanderId)).toEqual(['Publisher'])
    const resolved = await repo.query.aliasLookup({workspaceId: WS, alias: 'Author'}).load()
    expect(resolved?.id).toBe(pageId)
    // Without the in-tx veto the end state is identical — the storage trigger
    // aborts the statement and the catch below swallows it — so the diagnostic
    // is what pins the veto. It must name the rival, not blame one of the
    // type's own aliases.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(pageId)
    expect(warnings[0]).toContain('"Author" (claimed by')
  })

  it('survives a latent duplicate on one of the row’s OTHER aliases', async () => {
    // Cross-client dupes sync in trigger-free, so two live blocks can both
    // claim "Foo". `blocks_alias_update` re-inserts the WHOLE alias list, so
    // claiming "Author" on the first re-checks "Foo" and ABORTs — a collision
    // on a claim this pass never asked for. Unswallowed it rolls back the
    // batch, the run throws, no marker is recorded, and it re-throws forever.
    const typeId = await makeLegacyType(repo, 'Author', {[aliasesProp.name]: ['Foo']})
    await seedRow({id: 'rival-foo', content: 'Foo', properties: {[aliasesProp.name]: ['Foo']}})
    const bystanderId = await makeLegacyType(repo, 'Publisher')

    await runBackfill(repo)

    expect(await aliasesOf(repo, typeId)).toEqual(['Foo'])
    expect(await aliasesOf(repo, bystanderId)).toEqual(['Publisher'])
    // The run completed, so the marker is recorded — no re-throw on every open.
    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers.map(m => m.key)).toContain(`workspace_backfill:${WS}:${blockTypeNameAliasBackfill.id}`)
  })

  it('survives that latent duplicate in a properties_migration = children workspace too', async () => {
    // The sibling test above passes even with the claim merely WRAPPED in a
    // try/catch, because in cell mode the collision is raised by the
    // `setProperty` statement itself. In a flipped workspace it isn't: the
    // value children are written first and the parent-bag collision surfaces
    // later, from the children projection, OUTSIDE any try/catch in the pass —
    // it arrives from `repo.tx`. Catching is therefore not a fix here; only the
    // preflight is. This is the shape live graphs are migrating to.
    await sharedDb.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, ?)
       ON CONFLICT(id) DO UPDATE SET properties_migration = excluded.properties_migration`,
      [WS, 'test ws', 'user-1', 'children'],
    )
    // Assert the precondition rather than trusting it — an un-flipped
    // workspace would make this test a duplicate of the one above.
    const flip = await sharedDb.db.get<{properties_migration: string | null}>(
      'SELECT properties_migration FROM workspaces WHERE id = ?', [WS],
    )
    expect(flip.properties_migration).toBe('children')

    const typeId = await makeLegacyType(repo, 'Author', {[aliasesProp.name]: ['Foo']})
    await seedRow({id: 'rival-foo', content: 'Foo', properties: {[aliasesProp.name]: ['Foo']}})
    const bystanderId = await makeLegacyType(repo, 'Publisher')

    await runBackfill(repo)

    expect(await aliasesOf(repo, typeId)).toEqual(['Foo'])
    expect(await indexedAliases(typeId)).toEqual(['Foo'])
    expect(await aliasesOf(repo, bystanderId)).toEqual(['Publisher'])
    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'workspace_backfill:%'",
    )
    expect(markers.map(m => m.key)).toContain(`workspace_backfill:${WS}:${blockTypeNameAliasBackfill.id}`)
  })

  it('skips a malformed alias list rather than wiping the claims it still holds', async () => {
    // `getAliases` degrades a codec throw to `[]` while the `block_aliases`
    // trigger indexes every string element, so `["Scribe", 1]` is a LIVE claim
    // on "Scribe". Appending against a decoded `[]` would write `["Author"]`
    // and silently un-claim it.
    const id = await makeLegacyType(repo, 'Author', {[aliasesProp.name]: ['Scribe', 1]})
    expect(await indexedAliases(id)).toEqual(['Scribe'])
    await sharedDb.db.execute('DELETE FROM ps_crud') // drop the setup PUTs

    await runBackfill(repo)

    expect(await indexedAliases(id)).toEqual(['Scribe'])
    expect(await uploadOps(id)).toEqual([])
  })

  it('doesn’t stamp the migrated type as freshly user-edited', async () => {
    // `core.recentBlocks` sorts on `user_updated_at`. Without `skipMetadata`
    // every type in the graph is stamped with the moment the backfill ran, so
    // Recents fills with type pages the user never touched — and `updated_by`
    // falsely attributes the edit to whoever happened to open the app.
    const id = await makeLegacyType(repo, 'Author')
    const before = await sharedDb.db.get<{user_updated_at: number; updated_by: string | null}>(
      'SELECT user_updated_at, updated_by FROM blocks WHERE id = ?', [id],
    )

    await runBackfill(repo)

    expect(await aliasesOf(repo, id)).toEqual(['Author'])
    const after = await sharedDb.db.get<{user_updated_at: number; updated_by: string | null}>(
      'SELECT user_updated_at, updated_by FROM blocks WHERE id = ?', [id],
    )
    expect(after.user_updated_at).toBe(before.user_updated_at)
    expect(after.updated_by).toBe(before.updated_by)
  })

  it('claims for the oldest of two same-named legacy types', async () => {
    // Which one wins must not depend on physical scan order: that differs
    // between devices (sync-arrival vs local-creation), and two devices
    // claiming the name on different blocks both stick, since sync-apply
    // skips the uniqueness trigger.
    await seedRow({id: 'newer', createdAt: 200, content: 'Author', properties: legacyTypeProperties('Author')})
    await seedRow({id: 'older', createdAt: 100, content: 'Author', properties: legacyTypeProperties('Author')})

    await runBackfill(repo)

    expect(await aliasesOf(repo, 'older')).toEqual(['Author'])
    expect(await aliasesOf(repo, 'newer')).toEqual([])
  })

  it('skips seed-owned type blocks without aborting the rest of the batch', async () => {
    // A seed row is only recognised as one at its deterministic id, so mint it
    // there rather than at a generated id (which would make the guard vacuous).
    const seedKey = 'system:kernel-data/type/page'
    const seedRowId = typeDefinitionBlockId(WS, seedKey)
    await repo.tx(async tx => {
      await tx.createOrGet({
        id: seedRowId,
        workspaceId: WS,
        parentId: repo.typesPageId!,
        orderKey: keyAtEnd(),
        content: 'Page',
      })
    }, {scope: ChangeScope.BlockDefault})
    await writeLegacyTypeShape(repo, seedRowId, 'Page', {[seedKeyProp.name]: seedKey})
    const userTypeId = await makeLegacyType(repo, 'Author')

    await runBackfill(repo)

    // Editing a seed-materialized row is refused outright by
    // `assertNoSeedDefinitionWrites`, which THROWS. Reaching one un-skipped
    // would abort the whole run, marker included, so the bystander's claim is
    // what proves the skip happened before the write rather than after it.
    expect(await aliasesOf(repo, seedRowId)).toEqual([])
    expect(await aliasesOf(repo, userTypeId)).toEqual(['Author'])
  })

  it('doesn’t claim an empty alias for a label-less type block', async () => {
    const id = await makeLegacyType(repo, '')

    await runBackfill(repo)

    expect(await aliasesOf(repo, id)).toEqual([])
  })

  it('doesn’t claim a whitespace-only label', async () => {
    // Distinct from the label-less case: `parseTypeDefinitionMetadata` accepts
    // "   " as a label, so only the trim-then-check below stops it becoming a
    // blank alias entry.
    const id = await makeLegacyType(repo, '   ')

    await runBackfill(repo)

    expect(await aliasesOf(repo, id)).toEqual([])
  })

  it('skips a grammar-shaped label instead of claiming it as alias text', async () => {
    // Both label-writing paths refuse one; claiming `"[[Foo]]"` would mint a
    // name that reads back as a reference span.
    const id = await makeLegacyType(repo, '[[Foo]]')
    const bystanderId = await makeLegacyType(repo, 'Publisher')

    await runBackfill(repo)

    expect(await aliasesOf(repo, id)).toEqual([])
    expect(await aliasesOf(repo, bystanderId)).toEqual(['Publisher'])
  })

  it('writes nothing for a type that already claims its label', async () => {
    const id = await makeLegacyType(repo, 'Author', {[aliasesProp.name]: ['Author']})
    await sharedDb.db.execute('DELETE FROM ps_crud')
    const warnings = captureWarnings()

    await runBackfill(repo)

    expect(await aliasesOf(repo, id)).toEqual(['Author'])
    // The early-out must be a genuine no-op, not a redundant re-write of the
    // same value — these writes upload.
    expect(await uploadOps(id)).toEqual([])
    // …and it must be the SILENT early-out. Drop it and the row falls through
    // to the claimant veto, which finds the block's own claim and warns that
    // this healthy type was left alias-less — a lie, and the user's only
    // signal.
    expect(warnings).toEqual([])
  })

  it('claims across more than one batch', async () => {
    const ids = Array.from({length: 101}, (_, i) => `bulk-${String(i).padStart(3, '0')}`)
    await sharedDb.db.writeTransaction(async tx => {
      for (const [i, id] of ids.entries()) {
        await seedRow(
          {id, createdAt: 1000 + i, content: id, properties: legacyTypeProperties(id)},
          (sql, params) => tx.execute(sql, params),
        )
      }
    })

    await runBackfill(repo)

    const claimed = await sharedDb.db.getAll<{n: number}>(
      "SELECT COUNT(*) AS n FROM block_aliases WHERE workspace_id = ? AND alias LIKE 'bulk-%'", [WS],
    )
    expect(claimed[0].n).toBe(ids.length)
  })

  it('re-derives pre-existing [[label]] references onto the type block', async () => {
    // Mirror production ordering: the per-open derive sweep must have run
    // before `scheduleReferenceTargetNameRederive` accumulates anything (it
    // no-ops pre-sweep by design, since the sweep covers every name).
    await repo.whenPropertyDefinitionsReady(WS)
    vi.useFakeTimers()
    repo.scheduleReferenceTargetDerivePass(WS)
    await vi.runAllTimersAsync()
    await repo.awaitReferenceTargetDerive()
    vi.useRealTimers()

    const typeId = await makeLegacyType(repo, 'Author')
    // A reference written while nothing claimed "Author" stamps NULL, and
    // nothing content-driven ever revisits it — the CLAIM is the trigger. The
    // backfill writes through `repo.tx`, so `core.aliasClaimRederive` fires and
    // the stale row re-binds without a reload.
    const refId = await repo.mutate.createChild({parentId: repo.typesPageId!})
    await repo.tx(async tx => {
      await tx.update(refId, {content: '[[Author]]'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    expect((await repo.load(refId))?.referenceTargetId ?? null).toBeNull()

    await runBackfill(repo)

    await vi.waitFor(async () => {
      await repo.awaitReferenceTargetDerive()
      expect((await repo.load(refId))?.referenceTargetId).toBe(typeId)
    })
  })

  describe('per-row rechecks inside the tx', () => {
    it('never writes to a row that was tombstoned after the candidate scan', async () => {
      const id = await makeLegacyType(repo, 'Author')
      await repo.tx(tx => tx.delete(id), {scope: ChangeScope.BlockDefault})

      await runDirect(repo, [id])

      // `tx.get` does not filter tombstones, so nothing else would stop this.
      expect(await storedAliases(id)).toBeNull()
    })

    it('never writes to a row in another workspace', async () => {
      const foreign = 'ws-other'
      const id = 'foreign-type'
      await sharedDb.db.execute(INSERT_SQL, blockToRowParams({
        id,
        workspaceId: foreign,
        parentId: null,
        orderKey: 'k-foreign',
        content: 'Alien',
        properties: legacyTypeProperties('Alien'),
        references: [],
        createdAt: 1,
        updatedAt: 1000,
        userUpdatedAt: 1000,
        createdBy: 'u',
        updatedBy: 'u',
        deleted: false,
        referenceTargetId: null,
      } as BlockData))

      await runDirect(repo, [id])

      // `checkWorkspace` only rejects AFTER the tx pins a workspace, so a
      // foreign row handed to the pass first would be written.
      expect(await aliasesOf(repo, id)).toEqual([])
    })
  })
})
