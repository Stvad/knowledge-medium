// @vitest-environment node
/**
 * Integration tests for the parseReferences + cleanupOrphanAliases
 * post-commit processors (spec §7.4). Runs the full pipeline:
 * `repo.tx` write of `content` → field-watch fires
 * references.parseReferences → it ensures alias targets +  writes
 * `references` on source → optionally schedules references.cleanupOrphanAliases
 * with delayMs:4000 → tests advance timers + await processors before
 * asserting.
 *
 * What's covered (§7.4 list):
 *   - setContent with [[foo]] → alias target created + source.references
 *   - [[YYYY-MM-DD]] produces deterministic daily-note id; double
 *     create converges
 *   - typing [[foo]] then deleting within 4s → orphan removed
 *   - typing [[foo]] then linking from another block within 4s → kept
 *   - typing [[Inbox]] when Inbox pre-exists → existing kept
 *   - typing [[YYYY-MM-DD]] then deleting → daily note kept (§7.6)
 *   - two clients concurrently typing [[YYYY-MM-DD]] → same id
 *   - re-typing [[foo]] after a create-and-cleanup cycle → restored
 *   - command_events.scope='block-default:references' on processor txs
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasesProp } from '@/data/properties'
import { seedProperty } from '@/data/propertySeeds'
import { Repo } from '@/data/repo'
import { aliasSeatSeed, computeAliasSeatId } from '@/data/targets'
import { dailyNoteBlockId, dailyNotesDataExtension } from '@/plugins/daily-notes'
import { definitionSeedsFacet, projectedPropertyDefinitionsFacet } from '@/data/facets.js'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet.js'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { referencesDataExtension } from '../dataExtension.ts'
import { refTestSeed } from './refTestSeeds.ts'
import {
  CLEANUP_ORPHAN_ALIASES_PROCESSOR,
  PARSE_REFERENCES_PROCESSOR,
} from '../referencesProcessor.ts'

interface Harness {
  h: TestDb
  cache: BlockCache
  repo: Repo
  /** Read a row directly from SQL (bypasses the cache). Useful for
   *  asserting on processor-written rows that may not yet be cached. */
  read(id: string): Promise<{id: string; content: string; deleted: 0 | 1; properties_json: string; references_json: string} | null>
}

const setup = async (
  extraExtensions: readonly AppExtension[] = [],
): Promise<Harness> => {
  // Shared DB opened once per file (beforeAll), reset here per test. Called
  // again from a nested beforeEach (with a different schema extension); the
  // reset is idempotent and h.cleanup disposes the prior Repo's observer.
  await resetTestDb(sharedDb.db)
  const { repo, cache } = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      dailyNotesDataExtension,
      referencesDataExtension,
      ...extraExtensions,
    ],
  })
  // Reprojection is workspace-scoped: it only scans + marks the active
  // workspace. All fixtures here live in WS, so make it active or every
  // schema-swap reprojection would no-op (no active workspace ⇒ skip).
  repo.setActiveWorkspaceId(WS)
  const h: TestDb = {db: sharedDb.db, cleanup: async () => { repo.stopSyncObserver() }}
  return {
    h,
    cache,
    repo,
    read: async id => h.db.getOptional(
      `SELECT id, content, deleted, properties_json, references_json
       FROM blocks WHERE id = ?`,
      [id],
    ),
  }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({shouldAdvanceTime: true})
})
afterEach(async () => {
  // Drain any in-flight reprojection before swapping back to real timers
  // and resetting the shared DB — otherwise a fire-and-forget reprojection
  // from this test can write into the next one (the DB is shared per file).
  await env.repo.awaitReprojections()
  vi.useRealTimers()
  await env.h.cleanup()
})

const WS = 'ws-1'

const aliasId = (alias: string) => computeAliasSeatId(alias, WS)
const dailyId = (date: string) => dailyNoteBlockId(WS, date)

/** Run all pending processors to completion (synchronous + delayed).
 *  Also advances fake time by 1 ms so any pending `setTimeout(0)`
 *  callbacks (e.g. deferred reprojections scheduled by the rebuild
 *  step) fire before assertions. The 1 ms advance is too small to
 *  trip the orphan-cleanup processor's 4 s delay timers, so those
 *  tests still see the pre-cleanup intermediate state. */
const flush = async (delayMs = 0) => {
  await vi.advanceTimersByTimeAsync(1)
  // Schema-swap reprojections are fire-and-forget (scheduled via
  // setTimeout(0) off the cold-start path); advancing the timer starts
  // them but does not await their write. Drain them — then processors —
  // so callers see a fully-settled references_json without racing
  // vi.waitFor (issue #85).
  await env.repo.awaitReprojections()
  await env.repo.awaitProcessors()
  if (delayMs > 0) {
    await vi.advanceTimersByTimeAsync(delayMs)
    await env.repo.awaitReprojections()
    await env.repo.awaitProcessors()
  }
}

describe('parseReferences — basic alias creation', () => {
  it('writes [[foo]] → creates alias target + source.references contains it', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'I link to [[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const target = await env.read(aliasId('foo'))
    expect(target).not.toBeNull()
    expect(target!.deleted).toBe(0)
    const aliases = JSON.parse(target!.properties_json).alias as string[]
    expect(aliases).toEqual(['foo'])

    const src = await env.read('src')
    const refs = JSON.parse(src!.references_json) as Array<{id: string; alias: string}>
    expect(refs).toEqual([{id: aliasId('foo'), alias: 'foo'}])
  })

  it('block ref ((uuid)) lands in references with id=alias=uuid', async () => {
    const someUuid = '550e8400-e29b-41d4-a716-446655440000'
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: `see ((${someUuid}))`}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const refs = JSON.parse((await env.read('src'))!.references_json)
    expect(refs).toEqual([{id: someUuid, alias: someUuid}])
  })

  it('aliased block ref [label](((uuid))) lands in references once', async () => {
    const someUuid = '550e8400-e29b-41d4-a716-446655440000'
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: `see [shortcut](((${someUuid})))`}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const refs = JSON.parse((await env.read('src'))!.references_json)
    expect(refs).toEqual([{id: someUuid, alias: someUuid}])
  })

  // Regression (found by referencesRecompute.fuzz.test.ts): tx.update
  // legally writes content on tombstones, and apply() skips soft-deleted
  // rows — so without the `deleted` field-watch, a block edited while
  // tombstoned came back live with marks but no derived refs.
  it('restore re-parses content that was edited while soft-deleted', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'plain'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    await env.repo.tx(tx => tx.delete('src'), {scope: ChangeScope.BlockDefault})
    await flush()
    await env.repo.tx(tx => tx.update('src', {content: 'now links [[foo]]'}), {scope: ChangeScope.BlockDefault})
    await flush()
    // While deleted: no derivation happened (apply skips tombstones).
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([])

    await env.repo.tx(tx => tx.restore('src'), {scope: ChangeScope.BlockDefault})
    await flush()
    const refs = JSON.parse((await env.read('src'))!.references_json) as BlockReference[]
    expect(refs).toEqual([{id: aliasId('foo'), alias: 'foo'}])
    expect((await env.read(aliasId('foo')))?.deleted).toBe(0)
  })
})

describe('parseReferences — ref-typed properties', () => {
  const reviewerProp = refTestSeed('reviewer', 'ref')
  const relatedProp = refTestSeed('related', 'refList')
  const malformedProp = refTestSeed('malformed-ref-list', 'refList')
  const refSchemaExtension = [reviewerProp, relatedProp, malformedProp].map(p =>
    definitionSeedsFacet.of(p, {source: 'test'}))

  beforeEach(async () => {
    await env.h.cleanup()
    env = await setup(refSchemaExtension)
  })

  it('projects ref and refList properties with sourceField without alias-target creation', async () => {
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {
          reviewer: 'target-a',
          related: ['target-b', 'target-a', ''],
          // A well-formed id alongside a malformed (non-string) element: the
          // refList codec drops `42` element-wise (#189) and projects the
          // survivor, proving the field is recognised as ref-typed end-to-end
          // (an absent schema would project neither — the assertion would then
          // simply lack the `malformed-ref-list` entry).
          'malformed-ref-list': ['target-d', 42],
        },
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const refs = JSON.parse((await env.read('src'))!.references_json)
    // tx.update normalises references_json on write — sorted by
    // (sourceField, id, alias) with duplicates collapsed. The assertion lists
    // the four surviving triples in canonical-sorted order (sourceField first,
    // so `malformed-ref-list` leads).
    expect(refs).toEqual([
      {id: 'target-d', alias: 'target-d', sourceField: 'malformed-ref-list'},
      {id: 'target-a', alias: 'target-a', sourceField: 'related'},
      {id: 'target-b', alias: 'target-b', sourceField: 'related'},
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])
    expect(await env.read('target-a')).toBeNull()
    expect(await env.read('target-b')).toBeNull()
    expect(await env.read('target-d')).toBeNull()
  })

  it('reprojects when only properties change', async () => {
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'see [[content-target]]',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    await env.repo.tx(
      tx => tx.update('src', {properties: {reviewer: 'target-c'}}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const refs = JSON.parse((await env.read('src'))!.references_json)
    expect(refs).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
      {id: 'target-c', alias: 'target-c', sourceField: 'reviewer'},
    ])
  })
})

describe('parseReferences — schema-swap reprojection', () => {
  const reviewerProp = refTestSeed('reviewer', 'ref')
  const approverProp = refTestSeed('approver', 'ref')
  // `reviewer` redefined with a NON-ref preset — the real "stopped being
  // ref-typed" transition (e.g. a user changes the property's preset from a
  // ref type to text). Distinct from `runtimeWithoutReviewer`, where the
  // schema is *absent* (a load-transient that must NOT strip refs). A distinct
  // seedKey under the same name models a genuinely different definition, so this
  // one stays an explicit seedProperty (refTestSeed derives the key from name).
  const reviewerStringProp = seedProperty({
    seedKey: 'test:references/property/reviewer-string',
    revision: 1,
    name: 'reviewer',
    preset: 'string',
    changeScope: ChangeScope.BlockDefault,
  })
  const runtimeWithReviewer = () => resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
    definitionSeedsFacet.of(reviewerProp, {source: 'test'}),
  ])
  const runtimeWithReviewerAsString = () => resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
    definitionSeedsFacet.of(reviewerStringProp, {source: 'test'}),
  ])
  const runtimeWithReviewerAndApprover = () => resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
    definitionSeedsFacet.of(reviewerProp, {source: 'test'}),
    definitionSeedsFacet.of(approverProp, {source: 'test'}),
  ])
  const runtimeWithoutReviewer = () => resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    referencesDataExtension,
  ])

  it('projects existing blocks when a property becomes ref-typed', async () => {
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([])

    env.repo.setFacetRuntime(runtimeWithReviewer())

    await vi.waitFor(async () => {
      expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
        {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
      ])
    })
  })

  it('preserves references committed after the schema-swap scan starts', async () => {
    // The concurrent write must be INPUT-BACKED (here: an absent-schema
    // property value, the retainable shape): since the parser started
    // watching `references`, a raw entry with no backing input is
    // re-derived away on the spot — the derived-column model working,
    // not the reprojection clobber this test guards against.
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {reviewer: 'target-a', 'other-prop': 'target-b'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const liveReference: BlockReference = {id: 'target-b', alias: 'target-b', sourceField: 'other-prop'}
    const originalGetAll = env.h.db.getAll.bind(env.h.db)
    let intercepted = false
    const getAllSpy = vi.spyOn(env.h.db, 'getAll').mockImplementation(async <T,>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      const rows = await originalGetAll<T>(sql, params)
      if (!intercepted && sql.includes('json_each(b.properties_json) prop')) {
        intercepted = true
        await env.repo.tx(
          tx => tx.update('src', {references: [liveReference]}, {skipMetadata: true}),
          {scope: ChangeScope.References},
        )
      }
      return rows
    })

    try {
      env.repo.setFacetRuntime(runtimeWithReviewer())

      await vi.waitFor(async () => {
        expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
          liveReference,
          {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
        ])
      })
      expect(intercepted).toBe(true)
    } finally {
      getAllSpy.mockRestore()
    }
  })

  it('retains the field ref on a ref→non-ref redefine, stripping it lazily on the next write', async () => {
    // Reprojection is add-only — it never strips. A genuine ref→non-ref redefine
    // therefore does NOT eagerly sweep the field's derived refs; they're retained
    // until the block's next write, when the per-block references processor
    // recomputes the field against its now-non-ref schema and drops it. Schema
    // changes only ever ADD projections; removal is value-driven.
    env.repo.setFacetRuntime(runtimeWithReviewer())
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'see [[content-target]]',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])

    // `reviewer` is redefined to a *present* non-ref schema. Reprojection,
    // being add-only, RETAINS the stale field ref (does not strip it).
    env.repo.setFacetRuntime(runtimeWithReviewerAsString())
    await flush()
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])

    // The next write to the block recomputes its refs against the now-non-ref
    // `reviewer` schema, so the stale field ref is stripped lazily (the content
    // ref survives the edit).
    await env.repo.tx(
      tx => tx.update('src', {content: 'see [[content-target]] (edited)'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
    ])
  })

  it('retains derived refs and the marker when a ref-typed property goes absent (toggle off / not yet loaded)', async () => {
    // A property *absent* from the active workspace's schema set is "not
    // ref-typed here right now" — but absence is "not loaded / toggled off",
    // NOT a deletion. It occurs when async user/import schemas
    // (UserSchemasService) republish their bucket as rows materialize, when a
    // non-essential plugin is toggled off, and when ?safeMode forces every
    // non-essential off at once. Stripping on absence is what silently deleted
    // ~10k `next-review-date` backlinks fleet-wide when SRS was toggled off, so
    // the derived refs (and the marker) MUST be retained. Only a *present
    // non-ref* redefine strips (see the test above). Genuinely deleting a
    // schema is tolerated until each block's next write — far cheaper than a
    // mass silent delete.
    env.repo.setFacetRuntime(runtimeWithReviewer())
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: 'see [[content-target]]',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    // Backfill happened: the marker is set and the reviewer ref is present.
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])
    expect(await env.h.db.getOptional(
      `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:${WS}:reviewer'`,
    )).not.toBeNull()

    // reviewer's schema goes absent (its plugin toggled off / not yet loaded).
    env.repo.setFacetRuntime(runtimeWithoutReviewer())
    await flush()

    // The reviewer ref is RETAINED (not stripped); the marker is left intact so
    // re-enabling the plugin doesn't trigger a redundant re-scan.
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])
    expect(await env.h.db.getOptional(
      `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:${WS}:reviewer'`,
    )).not.toBeNull()
  })

  it('only reprojects the active workspace, leaving unopened workspaces untouched', async () => {
    // Reprojection scans + marks only repo.activeWorkspaceId. `propertySchemas`
    // reflects just the active workspace's user-data schemas, so evaluating
    // ref-ness against another workspace's blocks is meaningless — and
    // rewriting/stripping their references_json is exactly the cross-workspace
    // churn (every A↔B switch re-evaluating the whole graph) behind the flood.
    const OTHER_WS = 'ws-2'
    await env.repo.tx(
      tx => tx.create({
        id: 'src-active', workspaceId: WS, parentId: null, orderKey: 'a0',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(
      tx => tx.create({
        id: 'src-other', workspaceId: OTHER_WS, parentId: null, orderKey: 'a0',
        properties: {reviewer: 'target-b'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    env.repo.setFacetRuntime(runtimeWithReviewer())
    await flush()

    // Active workspace: the reviewer ref is backfilled.
    expect(JSON.parse((await env.read('src-active'))!.references_json)).toEqual([
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])
    // Unopened workspace: its block is never scanned — references_json stays
    // as the create-time processor left it (reviewer was not ref-typed then).
    expect(JSON.parse((await env.read('src-other'))!.references_json)).toEqual([])
    // And the per-workspace marker is recorded for the active workspace only.
    expect(await env.h.db.getOptional(
      `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:${WS}:reviewer'`,
    )).not.toBeNull()
    expect(await env.h.db.getOptional(
      `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:${OTHER_WS}:reviewer'`,
    )).toBeNull()
  })

  it('skips the deferred scan for a workspace the user has left (isolation gate)', async () => {
    // A reprojection captures (names, scheduled schemas, workspaceId) atomically
    // and runs deferred. If the user switches workspace before it fires, the scan
    // must NOT touch the workspace they've left: reprojecting a non-active
    // workspace's blocks — even correctly, from the frozen snapshot — violates
    // workspace isolation. The scan skips instead (the runner's active gate),
    // deferring WS's backfill to its next open. Skipping ALSO subsumes the older
    // concern this test guarded — the other workspace's registry can't strip the
    // captured workspace's refs, because the scan doesn't run at all.
    await env.repo.tx(
      tx => tx.create({
        id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // Schedule the backfill for WS (reviewer is ref-typed here)...
    env.repo.setFacetRuntime(runtimeWithReviewer())
    // ...then, before the deferred scan fires, switch away and drop reviewer
    // from the (now other-workspace) live registry.
    env.repo.setActiveWorkspaceId('ws-2')
    env.repo.setFacetRuntime(runtimeWithoutReviewer())
    await flush()

    // The WS-scheduled scan skipped (WS is no longer active): `src` is neither
    // backfilled (its ref waits for WS's next open) nor stripped.
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([])
  })

  it('does not add a ref for a parked ref-typed backfill after the property is redefined non-ref', async () => {
    // reproj-1 is scheduled when `reviewer` becomes ref-typed, then parks inside
    // its SELECT. Before it resumes, `reviewer` is redefined to a NON-ref codec.
    // Reprojection is add-only, so the parked backfill can only *add* — and it
    // must NOT add the reviewer ref, because `latestRefProjectionSchema` projects
    // against the live (non-ref) schema while the live registry still knows the
    // name. (Without that reconciliation it would re-add from the scheduled ref
    // snapshot.)
    const originalGetAll = env.h.db.getAll.bind(env.h.db)
    let releaseScan: (() => void) | null = null
    let intercepted = false
    let scanParked!: () => void
    const scanParkedPromise = new Promise<void>(resolve => { scanParked = resolve })
    const getAllSpy = vi.spyOn(env.h.db, 'getAll').mockImplementation(async <T,>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      if (!intercepted && sql.includes('json_each(b.properties_json) prop')) {
        intercepted = true
        const rows = await originalGetAll<T>(sql, params)
        await new Promise<void>(resolve => { releaseScan = resolve; scanParked() })
        return rows
      }
      return originalGetAll<T>(sql, params)
    })

    try {
      // Create with the reviewer VALUE but no reviewer schema yet ⇒ no reviewer ref.
      await env.repo.tx(
        tx => tx.create({
          id: 'src',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a0',
          content: 'see [[content-target]]',
          properties: {reviewer: 'target-a'},
        }),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.awaitProcessors()
      expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
        {id: aliasId('content-target'), alias: 'content-target'},
      ])

      // `reviewer` becomes ref-typed ⇒ schedule reproj-1; park it in the SELECT.
      env.repo.setFacetRuntime(runtimeWithReviewer())
      await vi.advanceTimersByTimeAsync(1)
      await scanParkedPromise

      // Redefine `reviewer` to a non-ref codec while reproj-1 is parked.
      env.repo.setFacetRuntime(runtimeWithReviewerAsString())
      await vi.advanceTimersByTimeAsync(1)

      // Resume reproj-1: add-only + live-non-ref reconciliation ⇒ no ref added.
      releaseScan!()
      await flush()
      expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
        {id: aliasId('content-target'), alias: 'content-target'},
      ])
    } finally {
      getAllSpy.mockRestore()
    }
  })

  it('retains refs when a parked ref-typed scan runs after the property goes absent (toggle off)', async () => {
    // Mirror of the redefine test above, but `reviewer` goes *absent* (its
    // plugin toggled off / not yet loaded) rather than being redefined to a
    // non-ref codec. A parked "became ref-typed" scan that fires after the
    // schema left the live registry must RETAIN the field's refs — absence is
    // not a deletion. This is the narrower-race sibling of the toggle-off strip
    // that silently deleted ~10k next-review-date backlinks: the gate skips a
    // reprojection scheduled with an already-absent snapshot, and
    // `latestRefProjectionSchema` keeps the scheduled ref schema when the live
    // registry no longer knows the name, so neither path strips here.
    const originalGetAll = env.h.db.getAll.bind(env.h.db)
    let releaseScan: (() => void) | null = null
    let intercepted = false
    let scanParked!: () => void
    const scanParkedPromise = new Promise<void>(resolve => { scanParked = resolve })
    const getAllSpy = vi.spyOn(env.h.db, 'getAll').mockImplementation(async <T,>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      if (!intercepted && sql.includes('json_each(b.properties_json) prop')) {
        intercepted = true
        const rows = await originalGetAll<T>(sql, params)
        await new Promise<void>(resolve => { releaseScan = resolve; scanParked() })
        return rows
      }
      return originalGetAll<T>(sql, params)
    })

    try {
      env.repo.setFacetRuntime(runtimeWithReviewer())
      await env.repo.tx(
        tx => tx.create({
          id: 'src',
          workspaceId: WS,
          parentId: null,
          orderKey: 'a0',
          content: 'see [[content-target]]',
          properties: {reviewer: 'target-a'},
        }),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.awaitProcessors()

      await vi.advanceTimersByTimeAsync(1)
      // Wait for reprojection-1 to park inside its SELECT (release fn captured).
      await scanParkedPromise

      // `reviewer`'s schema goes absent (its plugin toggled off) while
      // reprojection-1 is parked. The toggle-off swap schedules reprojection-2
      // with an already-absent snapshot, which the gate skips (no strip).
      env.repo.setFacetRuntime(runtimeWithoutReviewer())
      await vi.advanceTimersByTimeAsync(1)

      // Release the parked scan; it must NOT strip the reviewer ref even though
      // the live registry no longer knows `reviewer`.
      releaseScan!()
      await flush()

      expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
        {id: aliasId('content-target'), alias: 'content-target'},
        {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
      ])
    } finally {
      getAllSpy.mockRestore()
    }
  })

  it('per-block processor retains a derived ref when its schema is absent and the value is unchanged', async () => {
    // The per-block "drip": with the owning plugin toggled off, editing a block
    // re-runs the references processor against the absent schema. It must RETAIN
    // the field's derived ref (the value still encodes the relationship) rather
    // than dropping it — dropping is the same silent deletion as the reprojection
    // mass-strip, one block at a time.
    env.repo.setFacetRuntime(runtimeWithReviewer())
    await env.repo.tx(
      tx => tx.create({
        id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'see [[content-target]]', properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])

    // reviewer's schema goes absent (its plugin toggled off).
    env.repo.setFacetRuntime(runtimeWithoutReviewer())
    await flush()

    // Edit the block's CONTENT (not the reviewer field) while the schema is absent.
    await env.repo.tx(
      tx => tx.update('src', {content: 'see [[content-target]] (edited)'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // The reviewer ref is RETAINED — the edit didn't touch its value, and
    // absence is not a deletion.
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])
  })

  it('per-block processor drops a derived ref when its schema is absent and the value is directly edited', async () => {
    // The exception to retain-on-absence: if THIS write changed the field's own
    // value, a retained ref would point at the OLD value's target — a ref that
    // contradicts the new value. We can't re-derive without the schema, so drop.
    env.repo.setFacetRuntime(runtimeWithReviewer())
    await env.repo.tx(
      tx => tx.create({
        id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'see [[content-target]]', properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // reviewer's schema goes absent (its plugin toggled off).
    env.repo.setFacetRuntime(runtimeWithoutReviewer())
    await flush()

    // Directly edit the reviewer field's VALUE while the schema is absent.
    await env.repo.tx(
      tx => tx.update('src', {properties: {reviewer: 'target-b'}}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // The stale reviewer ref (to target-a) is dropped — its value changed and we
    // can't re-derive the new one without the schema. The content ref survives.
    expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
      {id: aliasId('content-target'), alias: 'content-target'},
    ])
  })

  it('records markers when a follow-up setFacetRuntime swaps the merged map mid-scan', async () => {
    // Reproduces the AppRuntimeProvider double-setFacetRuntime cold-start
    // race: kernel+static plugins go in synchronously, then a second
    // setFacetRuntime lands once dynamic extensions resolve. Before the
    // bail-removal fix, reprojection-1 (triggered by setFacetRuntime#1)
    // was abandoned mid-flight when setFacetRuntime#2 replaced
    // _propertySchemas, and its names never got marked → the same scan
    // re-fired on every reload.
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // Stall reprojection-1's SELECT just long enough for setFacetRuntime#2
    // to land and bump _propertySchemas. The spy lets the SELECT resolve
    // only after we've forced the swap.
    const originalGetAll = env.h.db.getAll.bind(env.h.db)
    let releaseScan: (() => void) | null = null
    let intercepted = false
    // Resolves only once the scan callback has captured its release fn, so
    // the test can wait for `releaseScan` to be a function before calling
    // it. Gating on `intercepted` alone is racy: it flips true before the
    // `await originalGetAll` resolves, so under load the test could reach
    // `releaseScan!()` while it was still null.
    let scanParked!: () => void
    const scanParkedPromise = new Promise<void>(resolve => { scanParked = resolve })
    const getAllSpy = vi.spyOn(env.h.db, 'getAll').mockImplementation(async <T,>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      if (!intercepted && sql.includes('json_each(b.properties_json) prop')) {
        intercepted = true
        const rows = await originalGetAll<T>(sql, params)
        await new Promise<void>(resolve => {
          releaseScan = resolve
          scanParked()
        })
        return rows
      }
      return originalGetAll<T>(sql, params)
    })

    try {
      env.repo.setFacetRuntime(runtimeWithReviewer())
      // Wait for reprojection-1 to actually park inside its SELECT (release
      // fn captured), not merely to have entered the spy.
      await scanParkedPromise
      // Now race: drop another setFacetRuntime that adds approver.
      // Pre-fix, this would invalidate reprojection-1's snapshot and
      // cause the bail.
      env.repo.setFacetRuntime(runtimeWithReviewerAndApprover())
      // Release reprojection-1's SELECT.
      releaseScan!()

      // Both reviewer and approver should end up markered. Reviewer
      // would not have been markered before the fix.
      await vi.waitFor(async () => {
        const reviewerMarker = await env.h.db.getOptional(
          `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:${WS}:reviewer'`,
        )
        const approverMarker = await env.h.db.getOptional(
          `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:${WS}:approver'`,
        )
        expect(reviewerMarker).not.toBeNull()
        expect(approverMarker).not.toBeNull()
      })
    } finally {
      getAllSpy.mockRestore()
    }
  })

  it('persists the marker across Repo restarts so the cold-start scan is skipped', async () => {
    // First Repo: scan + project. Marker for `reviewer` lands in
    // client_schema_state during the trailing setReprojectionMarker
    // pass (after all per-workspace txs).
    env.repo.setFacetRuntime(runtimeWithReviewer())
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    // Wait for both the projection write AND the marker write to land.
    // The references-write happens before the marker write, so polling
    // on the marker is the strict-er gate.
    await vi.waitFor(async () => {
      const row = await env.h.db.getOptional<{1: number}>(
        `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:${WS}:reviewer'`,
      )
      expect(row).not.toBeNull()
    })

    // Second Repo over the same SQLite file: emulates a fresh app start.
    // The merged schema map is kernel→merged-with-reviewer, which would
    // normally re-scan every block. The persisted marker should make
    // this a no-op.
    const { repo: repo2 } = createTestRepo({
      db: env.h.db,
      user: {id: 'user-1'},
    })
    repo2.setActiveWorkspaceId(WS)
    repo2.setFacetRuntime(runtimeWithReviewer())
    // The reprojection short-circuit is async (it awaits
    // loadReprojectionMarkers). Wait for the bookkeeping to land.
    await vi.waitFor(() => {
      expect(repo2.metrics().reprojection.skippedByMarker).toBeGreaterThanOrEqual(1)
    })
    const m = repo2.metrics()
    expect(m.reprojection.calls).toBe(0)
    expect(m.reprojection.rowsScanned).toBe(0)
  })
})

describe('parseReferences — stale-plan guard covers references-only writers', () => {
  it('does not clobber a references-only write landing between plan build and apply', async () => {
    // The race (Codex review on PR #371): a parse plan is built from the
    // content edit's event row; before it applies, a references-ONLY
    // writer (the ref-backfill reprojection on schema load, simulated
    // here with a raw update) adds an entry the parse cannot re-derive
    // (absent schema) but must retain (value unchanged). Pre-fix the
    // plan's basis checked only content/properties, so the stale plan
    // applied and silently dropped the entry — and with `references`
    // unwatched, nothing ever re-derived it. The fix is both halves:
    // the plan carries a references basis (stale plan skipped) and the
    // processor watches `references` (the skipped work is rebuilt from
    // the fresh row, retention keeping the foreign entry).
    await env.repo.tx(async tx => {
      await tx.create({id: 'ref-target', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'target'})
      await tx.create({
        id: 'ref-src', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'plain',
        // Value present with NO schema loaded for the field — the shape
        // isRetainableAbsentRef protects (referenceProjection.ts:69-80).
        properties: {'fuzz:reviewer': 'ref-target'},
      })
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // Park the parse read phase at its alias lookup so the content
    // edit's plan is built but applies only after the concurrent
    // references-only write lands.
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    // `repo.query` is a name-dispatch Proxy (repo.ts), so spyOn can't
    // patch a method on it — swap the whole facade for a gating wrapper.
    const realQuery = env.repo.query
    const gatedQuery = new Proxy(realQuery, {
      get(target, prop, receiver) {
        if (prop !== 'aliasLookup') return Reflect.get(target, prop, receiver)
        return (args: {workspaceId: string; alias: string}) => {
          const handle = target.aliasLookup(args)
          return {
            ...handle,
            load: async () => {
              await gate
              return handle.load()
            },
          }
        }
      },
    })
    ;(env.repo as {query: typeof realQuery}).query = gatedQuery
    try {
      await env.repo.tx(
        tx => tx.update('ref-src', {content: 'see [[StaleGuardAlias]]'}),
        {scope: ChangeScope.BlockDefault},
      )
      // While the plan is parked: the references-only write.
      await env.repo.tx(
        tx => tx.update(
          'ref-src',
          {references: [{id: 'ref-target', alias: 'ref-target', sourceField: 'fuzz:reviewer'}]},
          {skipMetadata: true},
        ),
        {scope: ChangeScope.References},
      )
      release()
    } finally {
      ;(env.repo as {query: typeof realQuery}).query = realQuery
    }
    await flush()

    const row = await env.read('ref-src')
    const refs = JSON.parse(row!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.sourceField === 'fuzz:reviewer' && ref.id === 'ref-target'),
      `retained property entry survives the parse plan (refs: ${row!.references_json})`,
    ).toBe(true)
    expect(refs.some(ref => ref.alias === 'StaleGuardAlias'), 'content link parsed').toBe(true)
  })
})

describe('parseReferences — alias claimed between plan build and apply (write-phase lookup-first)', () => {
  // The race (found by referencesRecompute.fuzz.test.ts once its ops
  // batched before a flush): the read phase's aliasLookup misses, so the
  // plan predicts a fresh deterministic seat — but before the write
  // phase runs, an unrelated commit claims the alias on a different
  // block. The interfering write touches the CLAIMANT row, not the
  // source, so no watched field re-fires the source: the stale-plan
  // guard can't help here. Pre-fix the write phase minted the seat
  // anyway, tripped the alias-uniqueness trigger, and the processor tx
  // rolled back whole — leaving the source permanently carrying the
  // mark with no derived ref. The fix is lookup-first INSIDE the write
  // tx (ensureAliasTarget / ensureDailyNoteTarget) plus retargeting the
  // plan's predicted seat id to the claimant, converging to exactly
  // what a fresh re-parse would produce.
  const parkLookupOf = (alias: string) => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const realQuery = env.repo.query
    // `repo.query` is a name-dispatch Proxy (repo.ts), so spyOn can't
    // patch a method on it — swap the whole facade for a gating wrapper.
    const gatedQuery = new Proxy(realQuery, {
      get(target, prop, receiver) {
        if (prop !== 'aliasLookup') return Reflect.get(target, prop, receiver)
        return (args: {workspaceId: string; alias: string}) => {
          const handle = target.aliasLookup(args)
          if (args.alias !== alias) return handle
          return {
            ...handle,
            load: async () => {
              await gate
              return handle.load()
            },
          }
        }
      },
    })
    ;(env.repo as {query: typeof realQuery}).query = gatedQuery
    return {
      release,
      restore: () => { ;(env.repo as {query: typeof realQuery}).query = realQuery },
    }
  }

  it('binds a plain alias mark to the block that claimed the alias mid-plan instead of stripping', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'claimant', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'C'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    // The source's SECOND mark ([[ParkZ]]) parks the read phase after
    // [[RacedAlias]] has already been resolved (lookup miss → seat
    // prediction), so the claim below lands in the read→write gap.
    const park = parkLookupOf('ParkZ')
    try {
      await env.repo.tx(
        tx => tx.create({
          id: 'race-src', workspaceId: WS, parentId: null, orderKey: 'a1',
          content: 'see [[RacedAlias]] and [[ParkZ]]',
        }),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.tx(
        tx => tx.setProperty('claimant', aliasesProp, ['RacedAlias']),
        {scope: ChangeScope.BlockDefault},
      )
      park.release()
    } finally {
      park.restore()
    }
    await flush()

    const row = await env.read('race-src')
    const refs = JSON.parse(row!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.alias === 'RacedAlias' && ref.id === 'claimant'),
      `raced alias binds to the claimant, not stripped/dangling (refs: ${row!.references_json})`,
    ).toBe(true)
    expect(refs.some(ref => ref.alias === 'ParkZ'), 'unraced mark still derived').toBe(true)
    // The predicted seat must NOT have been minted — the claimant owns
    // the alias.
    const seat = await env.read(computeAliasSeatId('RacedAlias', WS))
    expect(seat, 'no seat row minted for a claimed alias').toBeNull()
  })

  it('binds a date mark to the block that claimed the ISO alias mid-plan instead of stripping', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'date-claimant', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'D'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    const park = parkLookupOf('ParkZ')
    try {
      await env.repo.tx(
        tx => tx.create({
          id: 'date-race-src', workspaceId: WS, parentId: null, orderKey: 'a1',
          content: 'due [[2026-02-03]] and [[ParkZ]]',
        }),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.tx(
        tx => tx.setProperty('date-claimant', aliasesProp, ['2026-02-03']),
        {scope: ChangeScope.BlockDefault},
      )
      park.release()
    } finally {
      park.restore()
    }
    await flush()

    const row = await env.read('date-race-src')
    const refs = JSON.parse(row!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.alias === '2026-02-03' && ref.id === 'date-claimant'),
      `raced date alias binds to the claimant (refs: ${row!.references_json})`,
    ).toBe(true)
    const seat = await env.read(dailyNoteBlockId(WS, '2026-02-03'))
    expect(seat, 'no daily seat minted for a claimed date alias').toBeNull()
  })

  it('binds a LONG-FORM date mark to the block that claimed the literal alias mid-plan', async () => {
    // ensureDailyNoteTarget's internal lookup-first only rechecks the
    // ISO; the mark's literal alias ("February 3rd, 2026") is a distinct
    // claimable name, so the write phase must recheck it per mark
    // (Codex review on PR #371). Pre-fix this didn't strip — the seat
    // mint doesn't collide — but the ref bound to the daily seat where
    // a fresh parse would bind the claimant, with nothing to re-fire.
    await env.repo.tx(async tx => {
      await tx.create({id: 'lf-claimant', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'LF'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    const park = parkLookupOf('ParkZ')
    try {
      await env.repo.tx(
        tx => tx.create({
          id: 'lf-race-src', workspaceId: WS, parentId: null, orderKey: 'a1',
          content: 'due [[February 3rd, 2026]] and [[ParkZ]]',
        }),
        {scope: ChangeScope.BlockDefault},
      )
      await env.repo.tx(
        tx => tx.setProperty('lf-claimant', aliasesProp, ['February 3rd, 2026']),
        {scope: ChangeScope.BlockDefault},
      )
      park.release()
    } finally {
      park.restore()
    }
    await flush()

    const row = await env.read('lf-race-src')
    const refs = JSON.parse(row!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.alias === 'February 3rd, 2026' && ref.id === 'lf-claimant'),
      `long-form date mark binds to the claimant (refs: ${row!.references_json})`,
    ).toBe(true)
    const seat = await env.read(dailyNoteBlockId(WS, '2026-02-03'))
    expect(seat, 'no daily seat minted when the literal alias is claimed').toBeNull()
  })

  it('restores a merged-away daily seat whose tombstone carries a stale alias claim', async () => {
    // A tombstoned seat's stored bag can hold an alias that now belongs
    // to someone else: overwrite the seat's alias, merge the seat away
    // (merge hands the alias to the target and tombstones the seat with
    // its bag intact), then re-reference the date. Pre-fix the restore
    // resurrected the stale claim, tripped the alias-uniqueness trigger
    // against the merge target, and rolled back the whole parse tx —
    // permanently stripped refs for the new source (found by
    // referencesRecompute.fuzz.test.ts, seed -453708417). The restore
    // now strips the aliases key in the same UPDATE and the callback
    // re-writes the correct one.
    const seatId = dailyNoteBlockId(WS, '2026-01-05')
    await env.repo.tx(async tx => {
      await tx.create({id: 'src-a', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'on [[2026-01-05]]'})
      await tx.create({id: 'absorber', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'B'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()
    expect(await env.read(seatId), 'daily seat materialized').not.toBeNull()

    await env.repo.tx(
      tx => tx.setProperty(seatId, aliasesProp, ['zz-stale']),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    await env.repo.mutate.merge({intoId: 'absorber', fromId: seatId})
    await flush()

    await env.repo.tx(
      tx => tx.create({id: 'src-b', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'also [[2026-01-05]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const row = await env.read('src-b')
    const refs = JSON.parse(row!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.alias === '2026-01-05' && ref.id === seatId),
      `date ref derived, not stripped (refs: ${row!.references_json})`,
    ).toBe(true)
    const seat = await env.read(seatId)
    expect(seat!.deleted).toBe(0)
    expect(JSON.parse(seat!.properties_json)[aliasesProp.name]).toEqual(['2026-01-05'])
    const absorber = await env.read('absorber')
    expect(JSON.parse(absorber!.properties_json)[aliasesProp.name]).toEqual(['zz-stale'])
  })

  it('date-ensure divergence must not hijack a lookup-bound entry sharing the seat id', async () => {
    // Static state, no race: the daily seat was renamed (claims only
    // "Foo") and another page claims the freed ISO. A source citing
    // BOTH [[Foo]] and the long-form date binds Foo→seat by lookup and
    // routes the date through the ensure, which resolves to the ISO
    // claimant. Pre-fix the ensure's retarget was NOT alias-filtered,
    // so it rewrote every entry carrying the seat id — hijacking the
    // Foo binding — and the wrong state was STABLE (every re-parse
    // recomputed and re-retargeted identically, so referencesChanged
    // saw no delta). Round-2 adversarial review, verified repro.
    const seatId = dailyNoteBlockId(WS, '2026-05-20')
    await env.repo.tx(async tx => {
      await tx.create({id: 'seed-src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[2026-05-20]]'})
      await tx.create({id: 'iso-claimant', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'C'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()
    expect(await env.read(seatId), 'daily seat materialized').not.toBeNull()

    await env.repo.tx(async tx => {
      await tx.setProperty(seatId, aliasesProp, ['Foo'])
      await tx.setProperty('iso-claimant', aliasesProp, ['2026-05-20'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    await env.repo.tx(
      tx => tx.create({
        id: 'hijack-src', workspaceId: WS, parentId: null, orderKey: 'a2',
        content: 'see [[Foo]] and [[May 20th, 2026]]',
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const row = await env.read('hijack-src')
    const refs = JSON.parse(row!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.alias === 'Foo' && ref.id === seatId),
      `lookup-bound [[Foo]] stays on the renamed seat (refs: ${row!.references_json})`,
    ).toBe(true)
    expect(
      refs.some(ref => ref.alias === 'May 20th, 2026' && ref.id === 'iso-claimant'),
      'date mark binds to the ISO claimant via the ensure',
    ).toBe(true)
  })

  it('claiming a long-form literal on the target is a bookkeeping write (no user-edit stamp)', async () => {
    // claimLiteralDateAliases appends the literal spelling to the
    // target's alias list from a background re-parse of some OTHER
    // block. That write must ride skipMetadata like the processor's
    // references write: bumping userUpdatedAt/updatedBy here would make
    // the target page float to the top of last-edited views because a
    // different block mentioned it (Codex review on PR #384).
    await env.repo.tx(async tx => {
      await tx.create({id: 'iso-claimant', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'C'})
      await tx.setProperty('iso-claimant', aliasesProp, ['2026-06-10'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()
    const before = await env.h.db.getOptional<{user_updated_at: number | null; updated_by: string | null}>(
      'SELECT user_updated_at, updated_by FROM blocks WHERE id = ?', ['iso-claimant'],
    )

    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'see [[June 10th, 2026]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const claimant = await env.read('iso-claimant')
    expect(
      JSON.parse(claimant!.properties_json)[aliasesProp.name],
      'literal spelling claimed alongside the ISO',
    ).toEqual(['2026-06-10', 'June 10th, 2026'])
    const after = await env.h.db.getOptional<{user_updated_at: number | null; updated_by: string | null}>(
      'SELECT user_updated_at, updated_by FROM blocks WHERE id = ?', ['iso-claimant'],
    )
    expect(after, 'claim write must not stamp user-edit metadata').toEqual(before)
  })

  it('skips the literal claim when the target alias property cannot be decoded', async () => {
    // Legacy/raw data can hold a malformed alias array (e.g.
    // ["2026-06-11", 1]) whose STRING entries the block_aliases trigger
    // still indexes — so the ISO keeps resolving to this block. The
    // claim's append is decode→rewrite; on decode failure it must skip
    // rather than replace the list with just the literal, which would
    // un-claim the ISO and re-point future [[2026-06-11]] links (Codex
    // review on PR #384).
    await env.repo.tx(
      tx => tx.create({id: 'legacy', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'L'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    // Malformed shape can't be written through the codec — plant it raw.
    // The UPDATE fires blocks_alias_update, which indexes the string
    // entry and skips the number (typeof(je.value) = 'text' guard).
    await env.h.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$.alias', json('["2026-06-11", 1]')) WHERE id = ?`,
      ['legacy'],
    )

    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'see [[June 11th, 2026]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const refs = JSON.parse((await env.read('src'))!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.alias === 'June 11th, 2026' && ref.id === 'legacy'),
      'long-form still binds to the indexed ISO claimant',
    ).toBe(true)
    expect(
      JSON.parse((await env.read('legacy'))!.properties_json)[aliasesProp.name],
      'undecodable alias list left untouched — ISO claim preserved',
    ).toEqual(['2026-06-11', 1])
  })

  it('a latent duplicate alias on the target must not abort the parse batch via the claim', async () => {
    // Cross-client dupes are a standing V1 condition: sync-apply skips
    // the uniqueness trigger (tx_context.source IS NULL), so two devices
    // claiming the same alias offline both keep it. The claim write
    // re-inserts ALL of the target's aliases (blocks_alias_update
    // deletes+re-inserts), so the PRE-EXISTING duped alias would RAISE —
    // pre-fix that rolled back the whole parse tx: references for the
    // source were permanently dropped and re-aborted on every re-edit
    // (adversarial review on PR #384).
    await env.repo.tx(async tx => {
      await tx.create({id: 'older', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'O'})
      await tx.setProperty('older', aliasesProp, ['2026-06-12'])
      await tx.create({id: 'newer', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'N'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()
    // Plant the dupe the way sync-apply would: raw write outside a repo
    // tx, so tx_context.source is NULL and the uniqueness trigger skips.
    await env.h.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$.alias', json('["2026-06-12"]')) WHERE id = ?`,
      ['newer'],
    )

    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a2', content: 'see [[June 12th, 2026]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // The batch survived: the source's references landed (bound to the
    // oldest claimant per lookup semantics)...
    const refs = JSON.parse((await env.read('src'))!.references_json) as BlockReference[]
    expect(
      refs.some(ref => ref.alias === 'June 12th, 2026' && ref.id === 'older'),
      `references written despite the latent dupe (refs: ${JSON.stringify(refs)})`,
    ).toBe(true)
    // ...and the claim itself was skipped, leaving the target untouched.
    expect(
      JSON.parse((await env.read('older'))!.properties_json)[aliasesProp.name],
      'claim skipped on the dupe-carrying target',
    ).toEqual(['2026-06-12'])
  })
})

describe('parseReferences — idempotent comparison', () => {
  it('skips the references write when stored refs canonical-equal the parse output despite differing array order', async () => {
    // Simulate what a sync-applied row looks like locally after the
    // normalize-on-write change has landed everywhere: the writer
    // supplied refs in content-position order; tx.create canonicalised
    // them on the way to disk; the processor's re-parse produces the
    // same set in (possibly different) build order and the compare
    // step normalises both sides before equality. No second write
    // fires — the 16k-uploads-on-cold-resync bug.
    await env.repo.tx(
      tx => tx.create({
        id: 'src',
        workspaceId: WS,
        parentId: null,
        orderKey: 'a0',
        content: '[[2026-04-28]] then [[Foo]]',
        references: [
          // Content-position order: date first, alias second. tx.create
          // normalises on write so what lands on disk is canonical-sorted,
          // and the processor's re-parse must compare canonical-equal.
          {id: dailyId('2026-04-28'), alias: '2026-04-28'},
          {id: aliasId('Foo'), alias: 'Foo'},
        ],
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    // No second write fires for src — the processor's re-parse compared
    // canonical-equal, so it issued no reprojection update (the
    // 16k-uploads-on-cold-resync bug). Only the create PUT reaches the upload
    // queue; no follow-up PATCH for src. (Other rows in this tx involve the
    // alias-target ensure path, which still runs.)
    const srcOps = (await env.h.db.getAll<{data: string}>('SELECT data FROM ps_crud ORDER BY id'))
      .map(r => JSON.parse(r.data) as {op: string; id: string})
      .filter(e => e.id === 'src')
    expect(srcOps.map(e => e.op)).toEqual(['PUT'])

    // Stored refs are canonical-sorted regardless of writer order. Sort
    // key is (sourceField, id, alias); both refs have empty sourceField
    // so id breaks the tie. `2026-04-28` resolves to a daily-note id
    // whose UUIDv5 string ordering relative to `aliasId('Foo')` is
    // data-dependent — assert the set rather than a fixed order.
    const refs = JSON.parse((await env.read('src'))!.references_json) as BlockReference[]
    expect(new Set(refs.map(r => `${r.id}|${r.alias}`))).toEqual(new Set([
      `${dailyId('2026-04-28')}|2026-04-28`,
      `${aliasId('Foo')}|Foo`,
    ]))
  })
})

describe('parseReferences — daily-note routing (§7.6)', () => {
  it('[[YYYY-MM-DD]] produces a daily-note target with the daily-note deterministic id', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'today: [[2026-04-28]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const dn = await env.read(dailyId('2026-04-28'))
    expect(dn).not.toBeNull()
    expect(JSON.parse(dn!.properties_json).alias).toEqual(['2026-04-28'])
    // The non-date alias target is NOT created (no alias-namespace row).
    expect(await env.read(aliasId('2026-04-28'))).toBeNull()
  })

  it('[[Roam long-form date]] resolves to the canonical daily-note target while preserving the source alias', async () => {
    const longForm = 'May 20th, 2026'
    const iso = '2026-05-20'

    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: `today: [[${longForm}]]`}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const dn = await env.read(dailyId(iso))
    expect(dn).not.toBeNull()

    const refs = JSON.parse((await env.read('src'))!.references_json) as BlockReference[]
    expect(refs).toEqual([{id: dailyId(iso), alias: longForm}])
    expect(await env.read(aliasId(longForm))).toBeNull()
  })

  // Regression (found by referencesRecompute.fuzz.test.ts): when a live
  // NON-seat block already owns the date-shaped alias, minting the
  // deterministic seat would set the same alias on it, trip the
  // alias-uniqueness trigger, and roll back the whole processor tx —
  // permanently stripped references for the source. The daily branch now
  // does lookup-first like the non-date branch (§7.5).
  it('[[YYYY-MM-DD]] binds to an existing live owner of that alias instead of minting a colliding seat', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'owner', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'my imported daily page'})
      await tx.setProperty('owner', aliasesProp, ['2026-03-15'])
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'see [[2026-03-15]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const refs = JSON.parse((await env.read('src'))!.references_json) as BlockReference[]
    expect(refs).toEqual([{id: 'owner', alias: '2026-03-15'}])
    // No seat was minted alongside the owner.
    expect(await env.read(dailyId('2026-03-15'))).toBeNull()
  })

  it('[[today]] stays an ordinary alias page, not a daily-note reference', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'see [[today]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const target = await env.read(aliasId('today'))
    expect(target).not.toBeNull()
    expect(JSON.parse(target!.properties_json).alias).toEqual(['today'])

    const refs = JSON.parse((await env.read('src'))!.references_json) as BlockReference[]
    expect(refs).toEqual([{id: aliasId('today'), alias: 'today'}])
  })

  it('two concurrent [[YYYY-MM-DD]] writes converge on the same daily-note row', async () => {
    // Sequenced (writeTransaction serializes them) but same ISO date —
    // exercises the createOrGet "live row hit" path on the second.
    await env.repo.tx(
      tx => tx.create({id: 's1', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[2026-05-01]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(
      tx => tx.create({id: 's2', workspaceId: WS, parentId: null, orderKey: 'a1', content: '[[2026-05-01]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    // Both source blocks resolve to the same daily-note row.
    const id = dailyId('2026-05-01')
    const refs1 = JSON.parse((await env.read('s1'))!.references_json)
    const refs2 = JSON.parse((await env.read('s2'))!.references_json)
    expect(refs1).toEqual([{id, alias: '2026-05-01'}])
    expect(refs2).toEqual([{id, alias: '2026-05-01'}])
  })

  it("daily note is kept after typing [[YYYY-MM-DD]] then deleting the text within 4s", async () => {
    // Type [[2026-06-01]] then clear the text immediately. cleanup
    // would fire after 4s — but date results never enter the cleanup
    // list (§7.6), so the daily note persists regardless.
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[2026-06-01]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(5000)  // run any cleanup that would have fired
    const dn = await env.read(dailyId('2026-06-01'))
    expect(dn).not.toBeNull()
    expect(dn!.deleted).toBe(0)
  })
})

describe('references.reapOrphanAliasSeats — reference-drop reaping (#402)', () => {
  it('a rewrite (not a clear) that drops the last mark reaps the seat — the rename-window shape', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'see [[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect((await env.read(aliasId('foo')))!.deleted).toBe(0)

    // The reference-dropping rewrite (what renameBacklinks produces for a
    // source bound under the removed name): the mint-time 4s check already
    // ran and skipped, so only the drop transition can collect this seat.
    await env.repo.mutate.setContent({id: 'src', content: 'see nothing now'})
    await flush()
    expect((await env.read(aliasId('foo')))!.deleted).toBe(1)
  })

  it('soft-deleting the last referrer releases its refs and reaps the seat', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[bar]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect((await env.read(aliasId('bar')))!.deleted).toBe(0)

    await env.repo.tx(tx => tx.delete('src'), {scope: ChangeScope.BlockDefault})
    await flush()
    expect((await env.read(aliasId('bar')))!.deleted).toBe(1)
  })

  it('NEVER collects a user-created page, even one byte-identical to the seat seed shape', async () => {
    // quick-find's create-page writes exactly the seat seed shape
    // (content + alias + PAGE_TYPE) — at a RANDOM id. The seat-slot id
    // gate is the machine-mint discriminator, so build the strongest
    // possible impostor: the literal seed shape on a non-slot id.
    const seed = aliasSeatSeed('realpage')
    await env.repo.tx(
      tx => tx.create({
        id: 'user-made-page', workspaceId: WS, parentId: null, orderKey: 'a0',
        content: seed.content, properties: {...seed.properties},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a1', content: '[[realpage]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const refs = JSON.parse((await env.read('src'))!.references_json)
    expect(refs).toEqual([{id: 'user-made-page', alias: 'realpage'}])

    // Drop the page's last backlink — the reaper must skip it.
    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(5000)
    expect((await env.read('user-made-page'))!.deleted).toBe(0)
  })

  it('keeps a seat with ANY live child in an un-flipped workspace (generated-row tolerance is flip-gated)', async () => {
    // In an un-flipped workspace nothing generates property children, so
    // a child under a seat is user-authored by construction — even one
    // whose content block-refs the alias field DEFINITION id (the
    // impostor shape). reapSeatsInTx wouldn't sweep it (flip-gated), so
    // collecting the seat would strand the child live under a tombstone
    // (Codex review on PR #428).
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[kid]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const seatId = aliasId('kid')
    expect((await env.read(seatId))!.deleted).toBe(0)
    await env.repo.tx(
      tx => tx.create({
        id: 'user-child', workspaceId: WS, parentId: seatId, orderKey: 'a0',
        content: 'a note the user wrote under the page',
      }),
      {scope: ChangeScope.BlockDefault},
    )

    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(5000)
    expect((await env.read(seatId))!.deleted).toBe(0)
    expect((await env.read('user-child'))!.deleted).toBe(0)
  })

  it('reaps a seat in a child-backed workspace, sweeping its generated field rows', async () => {
    // In a flipped workspace every seat has GENERATED property children
    // (alias / types field rows) from the moment it is minted — the
    // reaper's children gate must tolerate exactly those and nothing
    // else, or it could never collect a seat there.
    await sharedDb.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'test ws', 'user-1'],
    )
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[qux]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const seatId = aliasId('qux')
    expect((await env.read(seatId))!.deleted).toBe(0)
    // Sanity: the seat's properties materialized as live generated children.
    const childrenBefore = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [seatId],
    )
    expect(childrenBefore.length).toBeGreaterThan(0)

    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush()
    expect((await env.read(seatId))!.deleted).toBe(1)
    // The generated field rows went with it — nothing dangles live under
    // the tombstone.
    const childrenAfter = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [seatId],
    )
    expect(childrenAfter).toEqual([])
  })

  it('keeps a seat that a concurrent re-reference rescues (still referenced at check time)', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[baz]]'})
      await tx.create({id: 'other', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'also [[baz]]'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()

    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(5000)
    expect((await env.read(aliasId('baz')))!.deleted).toBe(0)
  })

  it('keeps a seat the user ADOPTED between the orphan check and the reap tx (in-tx shape re-check)', async () => {
    // The reap gates run on committed state OUTSIDE the write tx; a user
    // tx that adopts the seat can land in between (PR #428 adversarial
    // review). Deterministic stand-in for that race: the MINT-TIME
    // cleanup's read phase probes only referrers — no shape gates — so a
    // seat renamed before its 4s check reaches `reapSeatsInTx` exactly
    // like a seat adopted mid-race, and only the in-tx re-check
    // (seed shape + slot id against the row's CURRENT content) stands
    // between the rename and a wrong tombstone of the user's page.
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[adoptme]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const seatId = aliasId('adoptme')
    expect((await env.read(seatId))!.deleted).toBe(0)

    // The user adopts the page: rename moves its content off the slot-id
    // namespace (alias.sync keeps the alias in step, so the shape stays
    // byte-identical to `aliasSeatSeed('My Real Page')` — the slot-id
    // check is what must catch this).
    await env.repo.mutate.setContent({id: seatId, content: 'My Real Page'})
    // Drop the reference so the pending 4s mint check sees an orphan.
    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(5000)

    const seat = await env.read(seatId)
    expect(seat!.deleted).toBe(0)
    expect(seat!.content).toBe('My Real Page')
  })

  it('keeps a child-backed seat when user content is nested INSIDE a generated field row subtree', async () => {
    // §9 keeps value children visible, so a comment thread under a
    // property VALUE child is reachable user content. The direct-children
    // gate sees only generated field rows and passes — the deep guard in
    // `reapSeatsInTx` must catch the nested comment, or the
    // deleteSubtreeInTx sweep takes it with the machinery (PR #428
    // adversarial review).
    await sharedDb.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, ?, ?, 1, 1, 'none', NULL, 'children')`,
      [WS, 'test ws', 'user-1'],
    )
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[nest]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const seatId = aliasId('nest')
    const [fieldRow] = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [seatId],
    )
    expect(fieldRow).toBeDefined()
    const [valueChild] = await sharedDb.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0', [fieldRow!.id],
    )
    expect(valueChild).toBeDefined()
    await env.repo.tx(
      tx => tx.create({
        id: 'nested-comment', workspaceId: WS, parentId: valueChild!.id, orderKey: 'a0',
        content: 'a comment the user nested under the value',
      }),
      {scope: ChangeScope.BlockDefault},
    )

    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(5000)
    expect((await env.read(seatId))!.deleted).toBe(0)
    expect((await env.read('nested-comment'))!.deleted).toBe(0)
  })
})

describe('parseReferences — orphan cleanup (§7.5)', () => {
  it('typing [[foo]] then deleting the text → the reference drop reaps the orphan seat', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect((await env.read(aliasId('foo')))!.deleted).toBe(0)
    // Clear the text — references go to []; foo's target now has no
    // referrer. references.reapOrphanAliasSeats (#402) observes the drop
    // in the parse tx's own dispatch and reaps promptly — no reliance on
    // the mint-time 4s check, which ran while `src` still referenced the
    // seat, skipped it, and would never have re-enqueued it.
    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush()
    expect((await env.read(aliasId('foo')))!.deleted).toBe(1)
  })

  it('typing [[foo]] then linking from another block within 4s → kept', async () => {
    await env.repo.tx(async tx => {
      await tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[foo]]'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()
    // A second block also references foo, before cleanup fires.
    await env.repo.tx(async tx => {
      await tx.create({id: 'other', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'also [[foo]]'})
    }, {scope: ChangeScope.BlockDefault})
    await flush()
    // Now src clears its text — but `other` still references foo.
    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(4000)
    expect((await env.read(aliasId('foo')))!.deleted).toBe(0)  // kept
  })

  it('§7.5 race: typing [[Inbox]] when Inbox pre-existed (not via this typing) → kept', async () => {
    // Pre-seed an Inbox alias target via a tx that didn't insert it
    // through ensureAliasTarget. Use the deterministic id directly so
    // the lookup-then-live-hit path applies.
    await env.repo.tx(async tx => {
      await tx.create({id: aliasId('Inbox'), workspaceId: WS, parentId: null, orderKey: 'b0', content: ''})
      await tx.update(aliasId('Inbox'), {properties: {alias: ['Inbox']}})
    }, {scope: ChangeScope.BlockDefault})

    // User types [[Inbox]] in another block.
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'see [[Inbox]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    // ensureAliasTarget short-circuits via lookup → inserted: false → not in cleanup list.
    expect((await env.read(aliasId('Inbox')))!.deleted).toBe(0)
    // Even after deleting and waiting 4s, Inbox stays.
    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush(4000)
    expect((await env.read(aliasId('Inbox')))!.deleted).toBe(0)
  })

  it('re-typing [[foo]] after a create-and-cleanup cycle → restores slot 0 in place', async () => {
    // Indexed-deterministic seat probe restores pristine cleanup
    // tombstones in place: a transient seat (content === alias, seed
    // properties, no children) that cleanup tombstoned is by definition
    // never-touched, so re-typing [[foo]] reuses the same id rather
    // than burning slot 1. Keeps the slot space compact for hot names
    // that get retyped many times (e.g. "browser em…" en route to
    // "browser emacs"). User-touched tombstones — content drifted,
    // extra props, live children — stay skipped, so an explicit page
    // delete is not undone by a [[…]] retype.
    await env.repo.tx(
      tx => tx.create({id: 's1', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const slot0Id = aliasId('foo')
    await env.repo.mutate.setContent({id: 's1', content: ''})
    await flush(4000)
    expect((await env.read(slot0Id))!.deleted).toBe(1)

    await env.repo.tx(
      tx => tx.create({id: 's2', workspaceId: WS, parentId: null, orderKey: 'a1', content: '[[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    // Slot 0 restored — same id, deleted flag flipped back, content
    // reset to the alias text.
    const target = await env.read(slot0Id)
    expect(target).not.toBeNull()
    expect(target!.deleted).toBe(0)
    expect(target!.content).toBe('foo')
    const aliases = JSON.parse(target!.properties_json).alias as string[]
    expect(aliases).toEqual(['foo'])
    // s2 references the restored slot 0 — no probe-past to slot 1.
    const refs = JSON.parse((await env.read('s2'))!.references_json)
    expect(refs).toEqual([{id: slot0Id, alias: 'foo'}])
  })
})

describe('parseReferences — bookkeeping', () => {
  it('processor txs use scope=block-default:references and update references with skipMetadata', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[ref-test]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    // The processor opened its own tx with scope='block-default:references'.
    const cmds = await env.h.db.getAll<{scope: string; description: string | null}>(
      "SELECT scope, description FROM command_events ORDER BY created_at",
    )
    expect(cmds.some(c => c.scope === 'block-default:references' && c.description?.startsWith(`processor: ${PARSE_REFERENCES_PROCESSOR}`))).toBe(true)
    // The references reprojection wrote src again (skipMetadata, so
    // updated_by stays the user) — it surfaces as a follow-up PATCH upload
    // after the create PUT.
    const srcOps = (await env.h.db.getAll<{data: string}>('SELECT data FROM ps_crud ORDER BY id'))
      .map(r => JSON.parse(r.data) as {op: string; id: string})
      .filter(e => e.id === 'src')
    expect(srcOps.map(e => e.op)).toEqual(['PUT', 'PATCH'])
  })

  it('an empty content insert still fires the processor but produces no references and no cleanup', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'empty', workspaceId: WS, parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush(4000)
    const refs = JSON.parse((await env.read('empty'))!.references_json)
    expect(refs).toEqual([])
    // No alias targets created.
    const aliasRows = await env.h.db.getAll(
      "SELECT id FROM blocks WHERE id != ? AND id != ?",
      ['empty', 'placeholder-no-such-id'],
    )
    expect(aliasRows).toEqual([])
  })
})

describe('cleanupOrphanAliases — schema validation at enqueue', () => {
  it('rejects malformed scheduledArgs at enqueue time, rolling back the originating tx', async () => {
    // Open a raw repo.tx that calls afterCommit with bad args.
    await expect(env.repo.tx(async tx => {
      await tx.create({id: 'src-bad', workspaceId: WS, parentId: null, orderKey: 'a0'})
      // Wrong shape — newlyInsertedAliasTargetIds should be string[].
      tx.afterCommit(CLEANUP_ORPHAN_ALIASES_PROCESSOR, {
        workspaceId: WS,
        newlyInsertedAliasTargetIds: 42 as unknown as string[],
      })
    }, {scope: ChangeScope.BlockDefault})).rejects.toThrow()
    // The tx rolled back — src-bad doesn't exist.
    expect(await env.read('src-bad')).toBeNull()
  })
})

describe('parseReferences — workspace-switch reprojection', () => {
  const reviewerProp = refTestSeed('reviewer', 'ref')

  beforeEach(async () => {
    await env.h.cleanup()
    // `reviewer` is a seed contributed to the runtime → ref-typed in EVERY
    // workspace, so switching between two workspaces produces an empty
    // ref-ness diff.
    env = await setup([definitionSeedsFacet.of(reviewerProp, {source: 'test'})])
  })

  it('backfills a newly-opened workspace sharing a ref-typed name with the prior one', async () => {
    // `ws-1` (the setup default) is the previously-active workspace. Create a
    // `ws-b` row with a ref value while `ws-b` is inactive, then blank its
    // derived references to model a row synced from another device that never
    // ran this client's per-write references processor.
    await env.repo.tx(
      tx => tx.create({
        id: 'srcB',
        workspaceId: 'ws-b',
        parentId: null,
        orderKey: 'a0',
        properties: {reviewer: 'target-a'},
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    await env.h.db.execute(`UPDATE blocks SET references_json = '[]' WHERE id = ?`, ['srcB'])
    expect(JSON.parse((await env.read('srcB'))!.references_json)).toEqual([])

    // Open `ws-b`: bootstrap pins it, then schedules the once-per-workspace ref
    // backfill. `reviewer` is ref-typed in both `ws-1` and `ws-b`, so the
    // prev-vs-new diff is empty — only this workspace-open scan reaches srcB.
    env.repo.setActiveWorkspaceId('ws-b')
    env.repo.scheduleWorkspaceRefBackfill('ws-b')
    await flush()

    expect(JSON.parse((await env.read('srcB'))!.references_json)).toEqual([
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
    ])
  })
})

describe('parseReferences — property field rows reference their definition, never mint a phantom page (§9, PR #386 review)', () => {
  // A flipped (child-backed) workspace: `setProperty` dual-writes a field row
  // whose content is `((fieldId))` — a by-id ref to the property DEFINITION.
  // It parses like any other block ref, so the field row carries a reference
  // to its definition: the "used by" edge (a definition's backlinks become
  // every block that uses the property — desirable, and it keeps field rows
  // in `block_references` so definition merge/rename retarget reaches them).
  // Because the content is `((id))`, not `[[name]]`, it can never mint a
  // user-visible alias page — that guarantee is the id-addressing FORM, not
  // any parse-level suppression. (The former `isPropertyMachineryRow` was
  // dropped: recognition-based suppression is unnecessary here and its
  // per-workspace resolver failed closed in background workspaces — #389 B.)
  // A real fieldId is the definition block's UUID; `((uuid))` is what
  // parseBlockRefs recognizes (a non-UUID synthetic id would never parse into
  // a block ref, masking the un-suppressed behavior this test asserts).
  const FIELD_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
  const statusSchema = defineProperty('status', {
    codec: codecs.string,
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })

  beforeEach(async () => {
    await sharedDb.db.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
       VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
      [WS],
    )
    env.repo.setRuntimeContributions(
      projectedPropertyDefinitionsFacet,
      'test-status-definition',
      [{
        metadata: {
          fieldId: FIELD_ID,
          workspaceId: WS,
          createdAt: 1,
          name: statusSchema.name,
          changeScope: statusSchema.changeScope,
          hidden: false,
          origin: 'user' as const,
        },
        schema: statusSchema,
      }],
      {workspaceId: WS},
    )
  })

  it('setProperty creates a field row that references its definition; no phantom alias page is minted', async () => {
    // Guard against a swallowed `[processorRunner] processor "..." failed`
    // making this pass vacuously: spy on console.error so a processor crash
    // fails the test loudly instead.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await env.repo.tx(async tx => {
      await tx.create({id: 'host', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'host'})
    }, {scope: ChangeScope.BlockDefault})
    await env.repo.tx(
      tx => tx.setProperty('host', statusSchema, 'done'),
      {scope: ChangeScope.BlockDefault},
    )
    await flush(4000)

    expect(errorSpy, `processor crashed: ${errorSpy.mock.calls.map(c => c.join(' ')).join('; ')}`)
      .not.toHaveBeenCalled()
    errorSpy.mockRestore()

    // No alias-target page named "status" — the `((fieldId))` content is a
    // by-id ref, so it can never mint a page (the guarantee is the addressing
    // form, not parse suppression).
    expect(await env.read(aliasId('status'))).toBeNull()

    // The field row now carries a reference to its definition — the "used by"
    // edge (under the dropped isPropertyMachineryRow this was suppressed to []).
    const field = await env.h.db.getOptional<{id: string; references_json: string}>(
      `SELECT id, references_json FROM blocks
        WHERE parent_id = 'host' AND reference_target_id = ? AND deleted = 0`,
      [FIELD_ID],
    )
    expect(field).not.toBeNull()
    const refs = JSON.parse(field!.references_json) as Array<{id: string}>
    expect(refs.map(r => r.id)).toEqual([FIELD_ID])
  })

  it('a ROOT row with content [[status]] is parsed as a normal wikilink (user content, not machinery)', async () => {
    // A workspace-root row (parentId === null) is never a field row (§9 root
    // half), so its `[[status]]` content is ordinary user content: a normal
    // alias target IS minted and the row gets a normal alias backlink — even
    // though "status" is a property schema name in this flipped workspace.
    // (Held under the dropped isPropertyMachineryRow via its root exemption,
    // and still holds now that parse suppression is gone entirely.)
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await env.repo.tx(
      tx => tx.create({id: 'root-status', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[status]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush(4000)

    expect(errorSpy, `processor crashed: ${errorSpy.mock.calls.map(c => c.join(' ')).join('; ')}`)
      .not.toHaveBeenCalled()
    errorSpy.mockRestore()

    // A normal alias-target page named "status" WAS created — root position
    // exempts the row from isPropertyMachineryRow's suppression even though
    // "status" is a property schema name in this flipped workspace.
    const target = await env.read(aliasId('status'))
    expect(target).not.toBeNull()
    expect(target!.deleted).toBe(0)
    const aliases = JSON.parse(target!.properties_json).alias as string[]
    expect(aliases).toEqual(['status'])

    // ...and the root row carries a normal alias backlink/reference to it.
    const refs = JSON.parse((await env.read('root-status'))!.references_json)
    expect(refs).toEqual([{id: aliasId('status'), alias: 'status'}])
  })
})
