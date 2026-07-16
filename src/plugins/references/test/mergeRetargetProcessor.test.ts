// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ChangeScope,
  normalizeReferences,
  type BlockData,
} from '@/data/api'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { seedProperty } from '@/data/propertySeeds'
import { definitionSeedsFacet } from '@/data/facets.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { ALIAS_COLLISION_MERGE_MUTATOR } from '@/plugins/alias/collisionMerge.ts'
import { referencesDataExtension } from '../dataExtension.ts'

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
    const reviewerProp = seedProperty({
      seedKey: 'test:references/property/reviewer',
      revision: 1,
      name: 'reviewer',
      preset: 'ref',
      changeScope: ChangeScope.BlockDefault,
    })
    const relatedProp = seedProperty({
      seedKey: 'test:references/property/related',
      revision: 1,
      name: 'related',
      preset: 'refList',
      changeScope: ChangeScope.BlockDefault,
    })

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

    it('skips value AND entry for a ref field whose scope is not policy-equivalent to the merge tx', async () => {
      // The value rewrite lands via the raw `properties` patch in the
      // merge tx (BlockDefault), bypassing setProperty's per-field scope
      // routing — so a UiState-scoped ref pointer must be left alone
      // entirely (value AND entry, like the absent-schema branch), not
      // silently mutated inside an undoable document merge (Codex
      // review on PR #371).
      const pinnedProp = seedProperty({
        seedKey: 'test:references/property/pinned-view',
        revision: 1,
        name: 'pinned-view',
        preset: 'ref',
        changeScope: ChangeScope.UiState,
      })
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
      // UiState field: value AND entry untouched.
      expect(ref.properties['pinned-view']).toBe('from')
      expect(ref.references).toEqual(normalizeReferences([
        {id: 'into', alias: 'into', sourceField: 'reviewer'},
        {id: 'from', alias: 'from', sourceField: 'pinned-view'},
      ]))
    })
  })
})
