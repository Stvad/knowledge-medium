// @vitest-environment node
/**
 * Fuzz suite pinning commit 7a34b5120 ("child dual-write updates use real
 * metadata, not the parent's skipMetadata"): `writePropertyValueChild`
 * (`src/data/internals/txEngine.ts:1298-1378`) — the eager child half of
 * `tx.setProperty`'s dual-write (PR #288 §5) — must stamp the field-row and
 * value-child rows with REAL metadata (their own `created_at`/`created_by`/
 * `updated_at`/`user_updated_at`/`updated_by`), regardless of whether the
 * PARENT write that triggered them passed `{skipMetadata: true}`. Before the
 * fix, the two CONTENT `update()` calls at :1319 and :1328 forwarded the
 * parent write's `opts` (including `skipMetadata`), so the same logical
 * property change stamped these synced child rows inconsistently depending
 * on whether it went through the eager dual-write or the deferred
 * MATERIALIZE processor (which always passes none, matching the CREATE
 * path at :1362-1377). See docs/fuzzing.md for tier mechanics.
 *
 * Oracle, differential across a `{skipMetadata: true}` write vs a plain
 * write of the SAME value on a twin block:
 *  - CREATE branch (:1362-1377, no existing field row): the freshly
 *    created field row AND value child both get REAL metadata in EITHER
 *    scenario — `created_at`/`updated_at` > 0, `created_by`/`updated_by`
 *    the real user, `user_updated_at` > 0 — never the `skipMetadata`
 *    sentinels (`buildNewBlockRow`, txEngine.ts:1243-1253: updated_at=0,
 *    created_at=0, created_by=''/updated_by='').
 *  - UPDATE branch (:1318-1328, an existing field row from a PRIOR plain
 *    write): a second write with a DIFFERENT value under
 *    `{skipMetadata: true}` must still ADVANCE the value child's
 *    `updated_at`/`user_updated_at` to fresh real values (`metadataPatch`,
 *    txEngine.ts:1210-1221, with `skipMetadata` undefined/false) — not
 *    leave them stale, which is what forwarding the parent's
 *    `{skipMetadata: true}` into the child update would do (`updated_at`
 *    still advances under skipMetadata, `user_updated_at`/`updated_by`
 *    would NOT, since `metadataPatch` returns `{updatedAt}` only —
 *    txEngine.ts:1219).
 *  - The PARENT cell write is the deliberate asymmetry this suite does
 *    NOT relax: under `{skipMetadata: true}` its OWN `user_updated_at`/
 *    `updated_by` stay untouched (`writePropertiesBag`, :764-781, forwards
 *    `opts` as-is) — verified so a future change that also "fixes" the
 *    parent doesn't silently pass this suite.
 *  - `createdTestRepo`'s default `now()` is a deterministic
 *    strictly-increasing counter (`createTestRepo.ts:87`), so a genuine
 *    metadata advance is distinguishable from staleness by plain `>`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import type { Repo } from '@/data/repo'

const WS = 'ws-metadata-parity-fuzz'
const USER = 'user-1'

const statusSchema = defineProperty<string>('status', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const relatedSchema = defineProperty<string>('related', {
  codec: codecs.ref(), defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
type Kind = 'status' | 'related'
const SCHEMAS: Record<Kind, {schema: AnyPropertySchema; fieldId: string}> = {
  status: {schema: statusSchema, fieldId: 'field-status'},
  related: {schema: relatedSchema, fieldId: 'field-related'},
}

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'
const idArb = fc.array(fc.constantFrom(...ID_ALPHABET), {minLength: 1, maxLength: 16})
  .map(cs => cs.join(''))
const valueArbFor = (kind: Kind): fc.Arbitrary<string> =>
  kind === 'status' ? fc.string({maxLength: 20}) : idArb

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})
const guard = statefulFuzzGuard()

const seedWorkspace = async (): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
    [WS, 'ws', USER],
  )
}

const setup = (): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: USER}})
  repo.setActiveWorkspaceId(WS)
  for (const {schema, fieldId} of Object.values(SCHEMAS)) {
    repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      `test-${schema.name}-definition`,
      [{
        metadata: {
          fieldId, workspaceId: WS, createdAt: 1, name: schema.name,
          changeScope: schema.changeScope, hidden: false, origin: 'user' as const,
        },
        schema,
      }],
      {workspaceId: WS},
    )
  }
  return repo
}

interface MetaRow {
  id: string
  created_at: number; updated_at: number; user_updated_at: number
  created_by: string; updated_by: string
}
const metaOf = async (id: string): Promise<MetaRow> =>
  (await sharedDb.db.get<MetaRow>(
    'SELECT id, created_at, updated_at, user_updated_at, created_by, updated_by FROM blocks WHERE id = ?',
    [id],
  ))!

const liveFieldRow = async (parentId: string, fieldId: string): Promise<{id: string} | undefined> =>
  sharedDb.db.getOptional<{id: string}>(
    `SELECT id FROM blocks WHERE parent_id = ? AND reference_target_id = ? AND deleted = 0`,
    [parentId, fieldId],
  )
const liveValueRow = async (fieldRowId: string): Promise<{id: string} | undefined> =>
  sharedDb.db.getOptional<{id: string}>(
    `SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0`, [fieldRowId],
  )

const expectRealMetadata = (meta: MetaRow, label: string): void => {
  expect(meta.created_at, `${label}.created_at`).toBeGreaterThan(0)
  expect(meta.updated_at, `${label}.updated_at`).toBeGreaterThan(0)
  expect(meta.user_updated_at, `${label}.user_updated_at`).toBeGreaterThan(0)
  expect(meta.created_by, `${label}.created_by`).toBe(USER)
  expect(meta.updated_by, `${label}.updated_by`).toBe(USER)
}

const runCase = async ({kind, v1, v2}: {kind: Kind; v1: string; v2: string}): Promise<void> => {
  await resetTestDb(sharedDb.db)
  await seedWorkspace()
  const repo = setup()
  const {schema, fieldId} = SCHEMAS[kind]

  // ── CREATE branch: a fresh block, written once under {skipMetadata:
  //    true}. The parent write is skipMetadata; the child dual-write must
  //    NOT inherit that. ──
  await repo.tx(async tx => {
    await tx.create({id: 'skip', workspaceId: WS, parentId: null, orderKey: 'a0', content: ''})
  }, {scope: ChangeScope.BlockDefault})
  const parentAtCreate = await metaOf('skip')
  await repo.tx(tx => tx.setProperty('skip', schema, v1, {skipMetadata: true}),
    {scope: ChangeScope.BlockDefault})

  const skipField = await liveFieldRow('skip', fieldId)
  expect(skipField, 'skipMetadata: field row exists').toBeDefined()
  const skipValue = await liveValueRow(skipField!.id)
  expect(skipValue, 'skipMetadata: value row exists').toBeDefined()
  expectRealMetadata(await metaOf(skipField!.id), 'skipMetadata field row (create)')
  expectRealMetadata(await metaOf(skipValue!.id), 'skipMetadata value row (create)')
  // The asymmetry this suite does NOT relax: the parent's OWN write stays
  // skipMetadata — user_updated_at untouched from before the write, even
  // though updated_at (the version) still advances (metadataPatch,
  // txEngine.ts:1219). (updated_by isn't a useful differentiator here: this
  // harness writes as a single user throughout, so it reads the same
  // real value either way.)
  const parentAfterSkipWrite = await metaOf('skip')
  expect(parentAfterSkipWrite.user_updated_at, 'parent user_updated_at frozen under skipMetadata')
    .toBe(parentAtCreate.user_updated_at)
  expect(parentAfterSkipWrite.updated_at, 'parent updated_at (version) still advances')
    .toBeGreaterThan(parentAtCreate.updated_at)

  // ── Twin block, same value, written WITHOUT skipMetadata — the
  //    differential control. Child metadata must be equally real. ──
  await repo.tx(async tx => {
    await tx.create({id: 'plain', workspaceId: WS, parentId: null, orderKey: 'a1', content: ''})
  }, {scope: ChangeScope.BlockDefault})
  await repo.tx(tx => tx.setProperty('plain', schema, v1), {scope: ChangeScope.BlockDefault})
  const plainField = await liveFieldRow('plain', fieldId)
  const plainValue = await liveValueRow(plainField!.id)
  expectRealMetadata(await metaOf(plainField!.id), 'plain field row (create)')
  expectRealMetadata(await metaOf(plainValue!.id), 'plain value row (create)')

  // ── UPDATE branch: a SECOND write on `skip`, a DIFFERENT value, again
  //    under {skipMetadata: true}. The existing value row's content update
  //    (:1328) must still ADVANCE to fresh real metadata, not leave the
  //    create-time stamps stale (which forwarding skipMetadata would do —
  //    metadataPatch returns {updatedAt} only, user_updated_at/updated_by
  //    frozen). ──
  const before = await metaOf(skipValue!.id)
  await repo.tx(tx => tx.setProperty('skip', schema, v2, {skipMetadata: true}),
    {scope: ChangeScope.BlockDefault})
  // Same field row and value row identity — updated in place, not recreated.
  expect((await liveFieldRow('skip', fieldId))?.id).toBe(skipField!.id)
  expect((await liveValueRow(skipField!.id))?.id).toBe(skipValue!.id)
  const after = await metaOf(skipValue!.id)
  expectRealMetadata(after, 'skipMetadata value row (update)')
  expect(after.created_at, 'update does not re-create').toBe(before.created_at)
  expect(after.updated_at, 'updated_at advanced').toBeGreaterThan(before.updated_at)
  expect(after.user_updated_at, 'user_updated_at advanced (not frozen by the parent skipMetadata)')
    .toBeGreaterThan(before.user_updated_at)
}

describe('writePropertyValueChild: child rows get real metadata regardless of the parent write\'s skipMetadata', () => {
  it('create and update branches, differential vs a plain (non-skipMetadata) twin write', async () => {
    const kindArb: fc.Arbitrary<Kind> = fc.constantFrom('status', 'related')
    const caseArb = kindArb.chain(kind => fc.record({
      kind: fc.constant(kind),
      v1: valueArbFor(kind),
      v2: valueArbFor(kind).filter(v => v !== ''), // v2 must differ in shape from v1 in general; equality handled below
      prngSeed: fc.integer({min: 1, max: 2 ** 31 - 2}),
    }).filter(({v1, v2}) => v1 !== v2))
    await fc.assert(
      fc.asyncProperty(caseArb, ({kind, v1, v2, prngSeed}) =>
        guard.run(prngSeed, () => runCase({kind, v1, v2}))),
      fuzzParams(20),
    )
  }, fuzzTestTimeout())
})
