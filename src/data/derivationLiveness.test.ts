// @vitest-environment node
/**
 * Derivation-liveness acceptance tests (issue #402): the commit
 * pipeline's write-generation re-run pass. Each case is a row from the
 * issue's matrix — a plugin (or later kernel) write invalidating the
 * input a kernel derivation already derived from, in the SAME tx — that
 * previously committed stale and now converges via the bounded second
 * pass. The mechanism itself lives in `commitPipeline.ts`; kernel
 * processors opt in with `rerunOnDirtyRows` / declare intent with
 * `settledWrites` (see `sameTxProcessor.ts`).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, defineSameTxProcessor } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet, sameTxProcessorsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { aliasesProp } from '@/data/properties'
import type { Repo } from '@/data/repo'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { referencesDataExtension } from '@/plugins/references/dataExtension.js'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'

const WS = 'ws-derivation-liveness'

const STATUS_FIELD_ID = 'field-status-liveness'
const statusSchema = defineProperty('status', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

const RELATED_FIELD_ID = 'field-related-liveness'
const relatedSchema = defineProperty<string>('related', {
  codec: codecs.ref(),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

// Mergeable property DEFINITIONS need uuid-shaped ids: the references
// plugin's `((id))` grammar (parse + merge rewrite) is uuid-anchored,
// and the definition-merge case rides exactly that rewrite.
const DEF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DEF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const alphaSchema = defineProperty('alpha', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})
const betaSchema = defineProperty('beta', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })

const seedFlippedWorkspace = async (): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
    [WS, 'test ws', 'user-1', ],
  )
}

const definitionContribution = (
  fieldId: string,
  schema: typeof statusSchema,
) => ({
  metadata: {
    fieldId, workspaceId: WS, createdAt: 1,
    name: schema.name, changeScope: schema.changeScope,
    hidden: false, origin: 'user' as const,
  },
  schema,
})

const setup = async (): Promise<Repo> => {
  await seedFlippedWorkspace()
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [referencesDataExtension, aliasDataExtension],
  })
  repo.setActiveWorkspaceId(WS)
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-liveness-definitions',
    [
      definitionContribution(STATUS_FIELD_ID, statusSchema),
      definitionContribution(RELATED_FIELD_ID, relatedSchema),
      definitionContribution(DEF_A, alphaSchema),
      definitionContribution(DEF_B, betaSchema),
    ],
    {workspaceId: WS},
  )
  return repo
}

interface Row {
  id: string
  content: string
  reference_target_id: string | null
  deleted: number
  properties_json: string
}

const rowOf = async (id: string): Promise<Row> =>
  sharedDb.db.get<Row>(
    `SELECT id, content, reference_target_id, deleted, properties_json
       FROM blocks WHERE id = ?`, [id],
  )

const childrenOf = async (parentId: string): Promise<Row[]> =>
  (await sharedDb.db.getAll<Row>(
    `SELECT id, content, reference_target_id, deleted, properties_json
       FROM blocks WHERE parent_id = ? ORDER BY order_key, id`,
    [parentId],
  )).filter(r => r.deleted === 0)

const cellOf = async (id: string, name: string): Promise<unknown> =>
  (JSON.parse((await rowOf(id)).properties_json) as Record<string, unknown>)[name]

const liveFieldRows = async (parentId: string, fieldId: string): Promise<Row[]> =>
  (await childrenOf(parentId)).filter(r => r.reference_target_id === fieldId)

describe('defineSameTxProcessor validation', () => {
  it('rejects rerunOnDirtyRows on an event-watch processor', () => {
    expect(() => defineSameTxProcessor({
      name: 'test.bad',
      watches: {kind: 'event', events: ['some.event']},
      rerunOnDirtyRows: true,
      apply: async () => {},
    })).toThrow(/field-watch only/)
  })
})

describe('net-zero watched-field revert (Codex review on PR #428)', () => {
  // A later processor can rewrite a watched field BACK to its tx-start
  // value after a derivation ran on the intermediate value: the net tx
  // diff is empty, but the derived state describes the intermediate
  // value. The re-run pass must dispatch on dirtiness (any post-watermark
  // write), never on the net field diff.
  it('re-derives from the final content when a plugin reverts it after DERIVE ran', async () => {
    const X = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const reverter = defineSameTxProcessor({
      name: 'test.revertContent',
      watches: {kind: 'field', table: 'blocks', fields: ['properties']},
      apply: async (event, ctx) => {
        for (const row of event.changedRows) {
          const target = row.after?.properties['revert-to']
          if (typeof target !== 'string') continue
          if (row.after!.content !== target) {
            await ctx.tx.update(row.id, {content: target})
          }
        }
      },
    })
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setFacetRuntime(resolveFacetRuntimeSync([
      kernelDataExtension,
      sameTxProcessorsFacet.of(reverter, {source: 'test'}),
    ]))
    await repo.tx(async tx => {
      await tx.create({id: 'r', workspaceId: WS, parentId: null, orderKey: 'a0', content: `((${X}))`})
    }, {scope: ChangeScope.BlockDefault})
    expect((await rowOf('r')).reference_target_id).toBe(X)

    // One tx: content moves to prose (pass-one DERIVE clears the stamp),
    // then the plugin reverts it — net content diff is zero.
    await repo.tx(async tx => {
      await tx.update('r', {content: 'plain prose'})
      await tx.update('r', {properties: {'revert-to': `((${X}))`}})
    }, {scope: ChangeScope.BlockDefault})

    const row = await rowOf('r')
    expect(row.content).toBe(`((${X}))`)
    // The stamp reflects the FINAL content, not the intermediate prose.
    expect(row.reference_target_id).toBe(X)
  })
})

describe('merge retarget → kernel derivations (same tx)', () => {
  const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const T = '99999999-9999-4999-8999-999999999999'
  /** root + merge source F + merge target T + owner block `s`. */
  const seedMergePair = (repo: Repo): Promise<void> =>
    repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({id: F, workspaceId: WS, parentId: 'root', orderKey: 'a1', content: 'From'})
      await tx.create({id: T, workspaceId: WS, parentId: 'root', orderKey: 'a2', content: 'To'})
      await tx.create({id: 's', workspaceId: WS, parentId: 'root', orderKey: 'a3', content: 'owner'})
    }, {scope: ChangeScope.BlockDefault})

  // Matrix row: "mergeRetarget content → PROJECT" on a VALUE CHILD whose
  // string-typed text merely CONTAINS ((fromId)) — no ref-property path
  // patches the cell, so before the re-run pass the child moved and the
  // owner's cell kept naming the merged-away block (issue comment,
  // instance 3).
  it('re-projects the owner cell after a string value child containing ((fromId)) is retargeted', async () => {
    const repo = await setup()
    await seedMergePair(repo)
    await repo.tx(tx => tx.setProperty('s', statusSchema, `see ((${F}))`),
      {scope: ChangeScope.BlockDefault})
    // Let parseReferences index the value child's ((F)) mark, so the
    // merge's retarget pass picks the child up as a referrer.
    await repo.awaitProcessors()

    await repo.mutate.merge({intoId: T, fromId: F, contentStrategy: 'keepTarget'})

    const [fieldRow] = await liveFieldRows('s', STATUS_FIELD_ID)
    const [value] = await childrenOf(fieldRow!.id)
    expect(value!.content).toBe(`see ((${T}))`)
    // The owner cell converged in the SAME tx — no stale `((F))` left for
    // an unrelated later edit to clean up.
    expect(await cellOf('s', statusSchema.name)).toBe(`see ((${T}))`)
  })

  // Matrix row: "mergeRetarget properties → MATERIALIZE" — the merge
  // rewrites a ref-typed CELL value with a raw properties write, and the
  // backing value child had no stored reference yet (parse lag / fresh
  // sync arrival), so no content rewrite converged it. Before the re-run
  // pass the child kept naming the merged-away block.
  it('re-materializes the backing child after a raw ref-cell rewrite', async () => {
    const repo = await setup()
    await seedMergePair(repo)
    await repo.tx(tx => tx.setProperty('s', relatedSchema, F),
      {scope: ChangeScope.BlockDefault})
    await repo.awaitProcessors()
    const [fieldRow] = await liveFieldRows('s', RELATED_FIELD_ID)
    const [value] = await childrenOf(fieldRow!.id)
    expect(value!.content).toBe(`((${F}))`)
    // Simulate the value child whose local parse hasn't run yet (the
    // reachable shape: a freshly sync-applied row) — drop its stored
    // references so the merge's content-rewrite path can't see it and
    // only the owner's raw cell rewrite fires.
    await sharedDb.db.execute(
      'DELETE FROM block_references WHERE source_id = ?', [value!.id],
    )

    await repo.mutate.merge({intoId: T, fromId: F, contentStrategy: 'keepTarget'})

    expect(await cellOf('s', relatedSchema.name)).toBe(T)
    const [valueAfter] = await childrenOf(fieldRow!.id)
    // Cell and child converged in the same tx: the re-run MATERIALIZE saw
    // the plugin's raw bag write, and the re-run DERIVE re-stamped the
    // rewritten child.
    expect(valueAfter!.content).toBe(`((${T}))`)
    expect(valueAfter!.reference_target_id).toBe(T)
  })

  // Doc §11 acceptance case (a) / matrix row "mergeRetarget content →
  // PROJECT (owner cell)": merging property DEFINITION A into B retargets
  // each owner's field row `((A))` → `((B))`, which changes WHICH schema
  // the owner's children denote — the owner cell must re-key from
  // `alpha` to `beta` in the same tx (B2's definition-merge problem).
  it('re-keys consuming owner cells when a property definition is merged away', async () => {
    const repo = await setup()
    await repo.tx(async tx => {
      await tx.create({id: 'root', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({
        id: DEF_A, workspaceId: WS, parentId: 'root', orderKey: 'a1',
        content: 'alpha', properties: {types: ['property-schema']},
      })
      await tx.create({
        id: DEF_B, workspaceId: WS, parentId: 'root', orderKey: 'a2',
        content: 'beta', properties: {types: ['property-schema']},
      })
      await tx.create({id: 'o', workspaceId: WS, parentId: 'root', orderKey: 'a3', content: 'owner'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('o', alphaSchema, 'v1'),
      {scope: ChangeScope.BlockDefault})
    // parseReferences indexes the field row's ((DEF_A)) mark so the merge
    // retarget enumerates it as a referrer.
    await repo.awaitProcessors()

    await repo.mutate.merge({intoId: DEF_B, fromId: DEF_A, contentStrategy: 'keepTarget'})

    const fieldRows = await liveFieldRows('o', DEF_B)
    expect(fieldRows).toHaveLength(1)
    expect(fieldRows[0]!.content).toBe(`((${DEF_B}))`)
    // The owner cell followed the retarget in the SAME tx: the old key is
    // gone and the value now projects under the surviving definition.
    expect(await cellOf('o', alphaSchema.name)).toBeUndefined()
    expect(await cellOf('o', betaSchema.name)).toBe('v1')
  })
})

describe('alias reverse-sync → PROJECT (same tx)', () => {
  // Matrix row: "alias.sync content → PROJECT" — an AR1 alias swap
  // rewrites a child's content to `((fieldId))` AFTER the kernel PROJECT
  // pass ran, so the row becomes a field row with the owner's cell unset
  // until some unrelated tree edit (found by Codex on PR #386).
  it('projects the owner cell when an alias swap turns a child into a field row', async () => {
    const repo = await setup()
    await repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
      await tx.create({id: 'c', workspaceId: WS, parentId: 'p', orderKey: 'a0', content: 'x'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(async tx => {
      await tx.create({id: 'v', workspaceId: WS, parentId: 'c', orderKey: 'a0', content: 'done'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('c', aliasesProp, ['x']),
      {scope: ChangeScope.BlockDefault})

    // The 1-for-1 alias swap whose removed entry matches current content
    // (AR1): alias.sync rewrites `c`'s content to the added alias — here
    // spelled as an exact reference to the status definition.
    await repo.tx(tx => tx.setProperty('c', aliasesProp, [`((${STATUS_FIELD_ID}))`]),
      {scope: ChangeScope.BlockDefault})

    const c = await rowOf('c')
    expect(c.content).toBe(`((${STATUS_FIELD_ID}))`)
    expect(c.reference_target_id).toBe(STATUS_FIELD_ID)
    // The re-run PROJECT saw the plugin's rewrite: `c` now denotes the
    // status property of `p`, and the first parseable value projected.
    expect(await cellOf('p', statusSchema.name)).toBe('done')
  })
})

describe('field row becoming ordinary → MATERIALIZE (same tx)', () => {
  // Issue comment, instance 2: one tx rewrites a field row's content away
  // from `((fieldId))` AND writes a property on it. MATERIALIZE's
  // ancestry gate read the STORED stamp (still a field row) and skipped;
  // DERIVE cleared the stamp later in the pass. The re-run MATERIALIZE
  // sees the cleared stamp and materializes the now-ordinary row's bag.
  it('materializes a bag written in the tx that un-field-rows the row', async () => {
    const repo = await setup()
    await repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(tx => tx.setProperty('p', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault})
    const [fieldRow] = await liveFieldRows('p', STATUS_FIELD_ID)

    await repo.tx(async tx => {
      await tx.update(fieldRow!.id, {content: 'now ordinary prose'})
      await tx.update(fieldRow!.id, {properties: {[statusSchema.name]: 'self'}})
    }, {scope: ChangeScope.BlockDefault})

    const row = await rowOf(fieldRow!.id)
    expect(row.reference_target_id).toBeNull()
    // The owner's cell dropped the key (PROJECT saw the field row leave
    // in pass one)...
    expect(await cellOf('p', statusSchema.name)).toBeUndefined()
    // ...and the now-ordinary row's own bag got backing children from the
    // re-run MATERIALIZE instead of committing cell-only.
    const ownFieldRows = await liveFieldRows(fieldRow!.id, STATUS_FIELD_ID)
    expect(ownFieldRows).toHaveLength(1)
    const [ownValue] = await childrenOf(ownFieldRows[0]!.id)
    expect(ownValue!.content).toBe('self')

    // Undo coherence: the re-run's writes amended the SAME tx, so one
    // undo restores the field row, the owner cell, and removes the
    // re-run's materialized children together.
    await repo.undo(ChangeScope.BlockDefault)
    expect((await rowOf(fieldRow!.id)).content).toBe(`((${STATUS_FIELD_ID}))`)
    expect(await cellOf('p', statusSchema.name)).toBe('done')
    expect(await liveFieldRows(fieldRow!.id, STATUS_FIELD_ID)).toEqual([])
  })
})
