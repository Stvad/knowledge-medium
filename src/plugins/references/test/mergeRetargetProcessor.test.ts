// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  normalizeReferences,
  type BlockData,
} from '@/data/api'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { definitionSeedsFacet } from '@/data/facets.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { ALIAS_COLLISION_MERGE_MUTATOR } from '@/plugins/alias/collisionMerge.ts'
import { referencesDataExtension } from '../dataExtension.ts'
import { refTestSeed } from './refTestSeeds.ts'

const WS = 'ws-1'

interface Harness {
  h: TestDb
  repo: Repo
  read(id: string): BlockData | undefined
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const { repo, cache } = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions: [referencesDataExtension, aliasDataExtension],
  })
  return {
    h,
    repo,
    read: id => cache.getSnapshot(id),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })

const aliasProperty = (aliases: readonly string[]) => ({
  [aliasesProp.name]: aliasesProp.codec.encode([...aliases]),
})

describe('references.retargetMergedBlockReferences', () => {
  it('retargets stored backlinks and blockref syntax from source to target atomically with core.merge', async () => {
    const intoId = '11111111-1111-4111-8111-111111111111'
    const fromId = '22222222-2222-4222-8222-222222222222'
    const refId = '33333333-3333-4333-8333-333333333333'

    await env.repo.tx(async tx => {
      await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0'})
      await tx.create({
        id: intoId,
        workspaceId: WS,
        parentId: 'p',
        orderKey: 'a0',
        content: 'Target page',
        properties: aliasProperty(['Target page']),
      })
      await tx.create({
        id: fromId,
        workspaceId: WS,
        parentId: 'p',
        orderKey: 'a1',
        content: 'Source page',
        properties: aliasProperty(['Source page']),
      })
      await tx.create({
        id: refId,
        workspaceId: WS,
        parentId: 'p',
        orderKey: 'a2',
        content: `Links [[Source page]] ((${fromId})) [source block](((${fromId}))) !((${fromId}))`,
        references: [
          {id: fromId, alias: 'Source page'},
          {id: fromId, alias: fromId},
        ],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.mutate.merge({intoId, fromId, contentStrategy: 'keepTarget'})

    expect(env.read(fromId)!.deleted).toBe(true)
    expect(env.read(intoId)!.properties[aliasesProp.name]).toEqual(['Target page', 'Source page'])
    expect(env.read(refId)!.content).toBe(
      `Links [[Source page]] ((${intoId})) [source block](((${intoId}))) !((${intoId}))`,
    )
    expect(env.read(refId)!.references).toEqual(normalizeReferences([
      {id: intoId, alias: 'Source page'},
      {id: intoId, alias: intoId},
    ]))
  })

  // Regression (PR #386 review): `core.deriveReferenceTarget` runs earlier
  // in the same-tx processor pass (kernel processors precede plugin ones)
  // and stamps `referenceTargetId` from the PRE-retarget content. Without
  // recomputing it here, a whole-block `((old))` row would keep
  // `referenceTargetId: old` even after its content became `((new))`.
  describe('referenceTargetId', () => {
    it('recomputes referenceTargetId when retargeting stamps a whole-block reference', async () => {
      const intoId = '44444444-4444-4444-8444-444444444444'
      const fromId = '55555555-5555-4555-8555-555555555555'
      const wholeRefId = '66666666-6666-4666-8666-666666666666'

      await env.repo.tx(async tx => {
        await tx.create({id: 'p2', workspaceId: WS, parentId: null, orderKey: 'b0'})
        await tx.create({id: intoId, workspaceId: WS, parentId: 'p2', orderKey: 'b0', content: 'Target'})
        await tx.create({id: fromId, workspaceId: WS, parentId: 'p2', orderKey: 'b1', content: 'Source'})
        await tx.create({
          id: wholeRefId,
          workspaceId: WS,
          parentId: 'p2',
          orderKey: 'b2',
          content: `((${fromId}))`,
          references: [{id: fromId, alias: fromId}],
        })
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.awaitProcessors()

      expect(env.read(wholeRefId)!.referenceTargetId).toBe(fromId)

      await env.repo.mutate.merge({intoId, fromId, contentStrategy: 'keepTarget'})

      expect(env.read(wholeRefId)!.content).toBe(`((${intoId}))`)
      expect(env.read(wholeRefId)!.referenceTargetId).toBe(intoId)
    })

    it('leaves referenceTargetId null for a partial-content occurrence retargeted by a merge', async () => {
      const intoId = '77777777-7777-4777-8777-777777777777'
      const fromId = '88888888-8888-4888-8888-888888888888'
      const partialRefId = '99999999-9999-4999-8999-999999999999'

      await env.repo.tx(async tx => {
        await tx.create({id: 'p3', workspaceId: WS, parentId: null, orderKey: 'c0'})
        await tx.create({id: intoId, workspaceId: WS, parentId: 'p3', orderKey: 'c0', content: 'Target'})
        await tx.create({id: fromId, workspaceId: WS, parentId: 'p3', orderKey: 'c1', content: 'Source'})
        await tx.create({
          id: partialRefId,
          workspaceId: WS,
          parentId: 'p3',
          orderKey: 'c2',
          content: `see ((${fromId})) here`,
          references: [{id: fromId, alias: fromId}],
        })
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.awaitProcessors()

      expect(env.read(partialRefId)!.referenceTargetId).toBeNull()

      await env.repo.mutate.merge({intoId, fromId, contentStrategy: 'keepTarget'})

      expect(env.read(partialRefId)!.content).toBe(`see ((${intoId})) here`)
      expect(env.read(partialRefId)!.referenceTargetId).toBeNull()
    })
  })

  it('uses alias rewrite metadata from alias-collision merges', async () => {
    await env.repo.tx(async tx => {
      await tx.create({
        id: 'target',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'Existing',
        properties: aliasProperty(['Existing']),
      })
      await tx.create({
        id: 'source',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a1',
        content: 'Partial',
        properties: aliasProperty(['Partial', 'Other']),
      })
      await tx.create({
        id: 'ref',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a2',
        content: 'see [[Partial]] and [[Other]]',
        references: [
          {id: 'source', alias: 'Partial'},
          {id: 'source', alias: 'Other'},
        ],
      })
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.awaitProcessors()

    await env.repo.run(ALIAS_COLLISION_MERGE_MUTATOR, {
      intoId: 'target',
      fromId: 'source',
      collisionAlias: 'Existing',
      dropSourceAliases: ['Partial'],
    })

    expect(env.read('source')!.deleted).toBe(true)
    expect(env.read('target')!.content).toBe('Existing')
    expect(env.read('target')!.properties[aliasesProp.name]).toEqual(['Existing', 'Other'])
    expect(env.read('ref')!.content).toBe('see [[Existing]] and [[Other]]')
    expect(env.read('ref')!.references).toEqual(normalizeReferences([
      {id: 'target', alias: 'Existing'},
      {id: 'target', alias: 'Other'},
    ]))
  })

  // Regression (found by referencesRecompute.fuzz.test.ts): property-derived
  // refs project from the property VALUE, so retargeting the ref entry
  // without rewriting the value left a projection anomaly that the next
  // re-parse silently reverted.
  describe('property-derived refs', () => {
    const reviewerProp = refTestSeed('reviewer', 'ref')
    const relatedProp = refTestSeed('related', 'refList')

    const seed = async (repo: Repo): Promise<void> => {
      await repo.tx(async tx => {
        await tx.create({id: 'into', workspaceId: WS, parentId: null, orderKey: 'a0'})
        await tx.create({id: 'from', workspaceId: WS, parentId: null, orderKey: 'a1'})
        await tx.create({
          id: 'ref',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a2',
          properties: {reviewer: 'from', related: ['from', 'into']},
          references: [
            {id: 'from', alias: 'from', sourceField: 'reviewer'},
            {id: 'from', alias: 'from', sourceField: 'related'},
            {id: 'into', alias: 'into', sourceField: 'related'},
          ],
        })
      }, {scope: ChangeScope.BlockDefault})
      await repo.awaitProcessors()
    }

    it('rewrites the property value alongside the ref when the schema is loaded', async () => {
      await resetTestDb(sharedDb.db)
      const {repo, cache} = createTestRepo({
        db: sharedDb.db,
        user: {id: 'user-1'},
        extensions: [
          referencesDataExtension,
          aliasDataExtension,
          definitionSeedsFacet.of(reviewerProp, {source: 'test'}),
          definitionSeedsFacet.of(relatedProp, {source: 'test'}),
        ],
      })
      repo.setActiveWorkspaceId(WS)
      await seed(repo)

      await repo.mutate.merge({intoId: 'into', fromId: 'from'})

      const ref = cache.getSnapshot('ref')!
      expect(ref.properties.reviewer).toBe('into')
      // The list rewrite dedupes the `into` entry it introduces.
      expect(ref.properties.related).toEqual(['into'])
      expect(ref.references).toEqual(normalizeReferences([
        {id: 'into', alias: 'into', sourceField: 'reviewer'},
        {id: 'into', alias: 'into', sourceField: 'related'},
      ]))
    })

    it('leaves ref AND value untouched when the schema is absent (value-tied retention)', async () => {
      // The value-tied state arises when refs were derived while the
      // owning plugin was loaded and the app later runs without it —
      // seed through a schema-carrying repo, merge through one without.
      await resetTestDb(sharedDb.db)
      const seeder = createTestRepo({
        db: sharedDb.db,
        user: {id: 'user-1'},
        extensions: [
          referencesDataExtension,
          aliasDataExtension,
          definitionSeedsFacet.of(reviewerProp, {source: 'test'}),
          definitionSeedsFacet.of(relatedProp, {source: 'test'}),
        ],
      })
      seeder.repo.setActiveWorkspaceId(WS)
      await seed(seeder.repo)

      // Distinct generators — two Repos over one db otherwise mint
      // colliding tx-seqs/ids (see the createTestRepo module doc).
      let txSeq = 1000
      let time = 1_800_000_000_000
      const {repo, cache} = createTestRepo({
        db: sharedDb.db,
        user: {id: 'user-1'},
        extensions: [referencesDataExtension, aliasDataExtension],
        newTxSeq: () => ++txSeq,
        now: () => ++time,
        newId: () => `second-${++txSeq}`,
      })
      await repo.mutate.merge({intoId: 'into', fromId: 'from'})
      await repo.awaitProcessors()

      const ref = cache.getSnapshot('ref') ?? await repo.load('ref')
      expect(ref!.properties.reviewer).toBe('from')
      expect(ref!.properties.related).toEqual(['from', 'into'])
      expect(ref!.references).toEqual(normalizeReferences([
        {id: 'from', alias: 'from', sourceField: 'reviewer'},
        {id: 'from', alias: 'from', sourceField: 'related'},
        {id: 'into', alias: 'into', sourceField: 'related'},
      ]))
    })

    it('rewrites a ref property the merge itself copied onto the TARGET', async () => {
      // mergeProperties can copy a ref property from `from` onto `into`
      // (target lacked the key) with a value naming fromId — e.g. a
      // self-reference on the merged-away block. `into` has no stored
      // reference entry for fromId yet, so entry-driven collection
      // can't see the field, and the follow-up parse would project a
      // backlink to the tombstoned merge source (Codex review on
      // PR #371). The merge target is now always a retarget candidate
      // and eligible fields are collected from the bag too.
      await resetTestDb(sharedDb.db)
      const {repo} = createTestRepo({
        db: sharedDb.db,
        user: {id: 'user-1'},
        extensions: [
          referencesDataExtension,
          aliasDataExtension,
          definitionSeedsFacet.of(reviewerProp, {source: 'test'}),
        ],
      })
      repo.setActiveWorkspaceId(WS)
      await repo.tx(async tx => {
        await tx.create({id: 'into', workspaceId: WS, parentId: null, orderKey: 'a0'})
        await tx.create({
          id: 'from',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a1',
          properties: {reviewer: 'from'},
          references: [{id: 'from', alias: 'from', sourceField: 'reviewer'}],
        })
      }, {scope: ChangeScope.BlockDefault})
      await repo.awaitProcessors()

      await repo.mutate.merge({intoId: 'into', fromId: 'from'})
      await repo.awaitProcessors()

      const into = await repo.load('into')
      expect(into!.properties.reviewer).toBe('into')
      expect(
        into!.references.some(r => r.id === 'from'),
        `no backlink to the tombstoned merge source (refs: ${JSON.stringify(into!.references)})`,
      ).toBe(false)
      expect(into!.references.some(r => r.id === 'into' && r.sourceField === 'reviewer')).toBe(true)
    })

    it('retargets a stale entry whose value ALREADY points at the merge target', async () => {
      // Stale derived data (value updated to intoId, entry still naming
      // fromId, no pending parse event): rewriteRefValue reports no
      // change, but the ENTRY must still be retargeted — otherwise the
      // merge leaves a backlink to a tombstone in exactly the stale
      // states this processor exists to clean up (Codex review on
      // PR #371).
      await resetTestDb(sharedDb.db)
      const {repo} = createTestRepo({
        db: sharedDb.db,
        user: {id: 'user-1'},
        extensions: [
          referencesDataExtension,
          aliasDataExtension,
          definitionSeedsFacet.of(reviewerProp, {source: 'test'}),
        ],
      })
      repo.setActiveWorkspaceId(WS)
      await repo.tx(async tx => {
        await tx.create({id: 'into', workspaceId: WS, parentId: null, orderKey: 'a0'})
        await tx.create({id: 'from', workspaceId: WS, parentId: null, orderKey: 'a1'})
        await tx.create({
          id: 'ref',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a2',
          properties: {reviewer: 'into'},
          references: [{id: 'into', alias: 'into', sourceField: 'reviewer'}],
        })
      }, {scope: ChangeScope.BlockDefault})
      await repo.awaitProcessors()
      // The stale state is NOT constructible through the tx path — any
      // write that could create it re-fires parseReferences (references
      // is watched) and the authoritative recompute heals it. It arrives
      // only via sync-applied rows, which bypass TxEngine — simulate
      // that with a raw column swap.
      await sharedDb.db.execute(
        `UPDATE blocks SET references_json = ? WHERE id = 'ref'`,
        [JSON.stringify([{id: 'from', alias: 'from', sourceField: 'reviewer'}])],
      )

      await repo.mutate.merge({intoId: 'into', fromId: 'from'})
      await repo.awaitProcessors()

      const ref = await repo.load('ref')
      expect(ref!.properties.reviewer).toBe('into')
      expect(
        ref!.references.some(r => r.id === 'from'),
        `no entry may keep pointing at the tombstoned merge source (refs: ${JSON.stringify(ref!.references)})`,
      ).toBe(false)
    })

    it('retargets value AND entry even for a ref field whose scope is not policy-equivalent to the merge tx', async () => {
      // A merge must not leave a pointer dangling at the tombstoned source,
      // so it retargets a ref field's value+entry REGARDLESS of the field's
      // declared scope — matching the value-child content path, which always
      // retargets. The write lands under the merge's BlockDefault scope, so
      // the retarget is undoable with the merge (undoing the merge restores
      // the pointer). Overriding the field's default scope is exactly right
      // for a merge (Vlad, PR #386 F7 — reversing the earlier PR #371 skip).
      const pinnedProp = refTestSeed('pinned-view', 'ref', ChangeScope.UiState)
      await resetTestDb(sharedDb.db)
      const {repo, cache} = createTestRepo({
        db: sharedDb.db,
        user: {id: 'user-1'},
        extensions: [
          referencesDataExtension,
          aliasDataExtension,
          definitionSeedsFacet.of(reviewerProp, {source: 'test'}),
          definitionSeedsFacet.of(pinnedProp, {source: 'test'}),
        ],
      })
      repo.setActiveWorkspaceId(WS)
      await repo.tx(async tx => {
        await tx.create({id: 'into', workspaceId: WS, parentId: null, orderKey: 'a0'})
        await tx.create({id: 'from', workspaceId: WS, parentId: null, orderKey: 'a1'})
        await tx.create({
          id: 'ref',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a2',
          properties: {reviewer: 'from', 'pinned-view': 'from'},
          references: [
            {id: 'from', alias: 'from', sourceField: 'reviewer'},
            {id: 'from', alias: 'from', sourceField: 'pinned-view'},
          ],
        })
      }, {scope: ChangeScope.BlockDefault})
      await repo.awaitProcessors()

      await repo.mutate.merge({intoId: 'into', fromId: 'from'})

      const ref = cache.getSnapshot('ref')!
      // Policy-equivalent field: rewritten as usual.
      expect(ref.properties.reviewer).toBe('into')
      // UiState field: NOW ALSO retargeted — no dangling pointer at `from`.
      expect(ref.properties['pinned-view']).toBe('into')
      expect(ref.references).toEqual(normalizeReferences([
        {id: 'into', alias: 'into', sourceField: 'reviewer'},
        {id: 'into', alias: 'into', sourceField: 'pinned-view'},
      ]))
    })
  })

  // PR #386 review raised this as a gap: the properties patch updates the
  // owner's CELL, but the value child under the field row would keep
  // `((fromId))` — and the child is PROJECT's truth, so the tombstoned id
  // would come back. It doesn't happen, and the reason is worth pinning:
  // removing the parse-level machinery suppression put value rows in
  // `block_references` like any other row, so the retarget walk reaches the
  // child directly and rewrites its content. Cell and child converge.
  describe('property value children in a child-backed workspace', () => {
    const REF_DEF = '55555555-5555-4555-8555-555555555555'
    const FROM = '66666666-6666-4666-8666-666666666666'
    const INTO = '77777777-7777-4777-8777-777777777777'


    it('retargets the value child itself, not just the owner cell', async () => {
      await env.h.db.execute(
        `INSERT OR REPLACE INTO workspaces
           (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
         VALUES (?, 'test ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
        [WS],
      )
      await env.repo.tx(async tx => {
        await tx.create({
          id: REF_DEF, workspaceId: WS, parentId: null, orderKey: 'a0',
          content: 'related', properties: {types: ['property-schema']},
        })
        await tx.create({id: FROM, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'From'})
        await tx.create({id: INTO, workspaceId: WS, parentId: null, orderKey: 'a2', content: 'Into'})
        await tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a3', content: 'Owner'})
        await tx.create({
          id: 'field', workspaceId: WS, parentId: 'owner', orderKey: 'a0',
          content: `((${REF_DEF}))`,
        })
        await tx.create({
          id: 'value', workspaceId: WS, parentId: 'field', orderKey: 'a0',
          content: `((${FROM}))`, references: [{id: FROM, alias: FROM}],
        })
      }, {scope: ChangeScope.BlockDefault})
      await env.repo.awaitProcessors()
      expect(env.read('value')!.referenceTargetId).toBe(FROM)

      await env.repo.mutate.merge({fromId: FROM, intoId: INTO})
      await env.repo.awaitProcessors()

      expect(env.read('value')!.content).toBe(`((${INTO}))`)
      expect(env.read('value')!.referenceTargetId).toBe(INTO)
      expect(env.read('value')!.references).toEqual([{id: INTO, alias: INTO}])
    })
  })
})
