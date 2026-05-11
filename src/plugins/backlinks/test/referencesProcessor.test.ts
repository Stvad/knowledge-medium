// @vitest-environment node
/**
 * Integration tests for the parseReferences + cleanupOrphanAliases
 * post-commit processors (spec §7.4). Runs the full pipeline:
 * `repo.tx` write of `content` → field-watch fires
 * backlinks.parseReferences → it ensures alias targets +  writes
 * `references` on source → optionally schedules backlinks.cleanupOrphanAliases
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty, type BlockReference } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { computeAliasSeatId } from '@/data/targets'
import { dailyNoteBlockId, dailyNotesDataExtension } from '@/plugins/daily-notes'
import { propertySchemasFacet } from '@/data/facets.ts'
import { resolveFacetRuntimeSync, type AppExtension } from '@/extensions/facet.ts'
import { kernelDataExtension } from '@/data/kernelDataExtension.ts'
import { backlinksDataExtension } from '../dataExtension.ts'
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
  const h = await createTestDb()
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: {id: 'user-1'},
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    backlinksDataExtension,
    ...extraExtensions,
  ]))
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

let env: Harness
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({shouldAdvanceTime: true})
})
afterEach(async () => {
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
  await env.repo.awaitProcessors()
  if (delayMs > 0) {
    await vi.advanceTimersByTimeAsync(delayMs)
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
})

describe('parseReferences — ref-typed properties', () => {
  const reviewerProp = defineProperty<string>('reviewer', {
    codec: codecs.ref(),
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })
  const relatedProp = defineProperty<readonly string[]>('related', {
    codec: codecs.refList(),
    defaultValue: [],
    changeScope: ChangeScope.BlockDefault,
  })
  const malformedProp = defineProperty<readonly string[]>('malformed-ref-list', {
    codec: codecs.refList(),
    defaultValue: [],
    changeScope: ChangeScope.BlockDefault,
  })
  const refSchemaExtension = [
    propertySchemasFacet.of(reviewerProp, {source: 'test'}),
    propertySchemasFacet.of(relatedProp, {source: 'test'}),
    propertySchemasFacet.of(malformedProp, {source: 'test'}),
  ]

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
          'malformed-ref-list': [42],
        },
      }),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()

    const refs = JSON.parse((await env.read('src'))!.references_json)
    expect(refs).toEqual([
      {id: 'target-a', alias: 'target-a', sourceField: 'reviewer'},
      {id: 'target-b', alias: 'target-b', sourceField: 'related'},
      {id: 'target-a', alias: 'target-a', sourceField: 'related'},
    ])
    expect(await env.read('target-a')).toBeNull()
    expect(await env.read('target-b')).toBeNull()
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
  const reviewerProp = defineProperty<string>('reviewer', {
    codec: codecs.ref(),
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })
  const approverProp = defineProperty<string>('approver', {
    codec: codecs.ref(),
    defaultValue: '',
    changeScope: ChangeScope.BlockDefault,
  })
  const runtimeWithReviewer = () => resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    backlinksDataExtension,
    propertySchemasFacet.of(reviewerProp, {source: 'test'}),
  ])
  const runtimeWithReviewerAndApprover = () => resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    backlinksDataExtension,
    propertySchemasFacet.of(reviewerProp, {source: 'test'}),
    propertySchemasFacet.of(approverProp, {source: 'test'}),
  ])
  const runtimeWithoutReviewer = () => resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    backlinksDataExtension,
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
    const liveReference: BlockReference = {id: 'live-content', alias: 'live-content'}
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

  it('removes stale field refs when a property stops being ref-typed', async () => {
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

    env.repo.setFacetRuntime(runtimeWithoutReviewer())
    await flush()

    await vi.waitFor(async () => {
      expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
        {id: aliasId('content-target'), alias: 'content-target'},
      ])
    })
  })

  it('does not let an older ref-typed reprojection re-add refs after schema removal', async () => {
    const originalGetAll = env.h.db.getAll.bind(env.h.db)
    const originalExecute = env.h.db.execute.bind(env.h.db)
    let releaseScan: (() => void) | null = null
    let intercepted = false
    let released = false
    let markerBeforeRelease = false
    let markerAfterRelease = false
    const getAllSpy = vi.spyOn(env.h.db, 'getAll').mockImplementation(async <T,>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      if (!intercepted && sql.includes('json_each(b.properties_json) prop')) {
        intercepted = true
        const rows = await originalGetAll<T>(sql, params)
        await new Promise<void>(resolve => { releaseScan = resolve })
        return rows
      }
      return originalGetAll<T>(sql, params)
    })
    const executeSpy = vi.spyOn(env.h.db, 'execute').mockImplementation(async (
      sql: string,
      params?: unknown[],
    ) => {
      const result = await originalExecute(sql, params)
      const isReviewerMarker = sql.includes('client_schema_state')
        && params?.[0] === 'reproject_ref:reviewer'
      if (isReviewerMarker) {
        if (released) {
          markerAfterRelease = true
        } else {
          markerBeforeRelease = true
        }
      }
      return result
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
      await vi.waitFor(() => { expect(intercepted).toBe(true) })

      env.repo.setFacetRuntime(runtimeWithoutReviewer())
      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(async () => {
        expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
          {id: aliasId('content-target'), alias: 'content-target'},
        ])
      })
      await vi.waitFor(() => { expect(markerBeforeRelease).toBe(true) })

      released = true
      releaseScan!()
      await vi.waitFor(() => { expect(markerAfterRelease).toBe(true) })

      expect(JSON.parse((await env.read('src'))!.references_json)).toEqual([
        {id: aliasId('content-target'), alias: 'content-target'},
      ])
    } finally {
      getAllSpy.mockRestore()
      executeSpy.mockRestore()
    }
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
    const getAllSpy = vi.spyOn(env.h.db, 'getAll').mockImplementation(async <T,>(
      sql: string,
      params?: unknown[],
    ): Promise<T[]> => {
      if (!intercepted && sql.includes('json_each(b.properties_json) prop')) {
        intercepted = true
        const rows = await originalGetAll<T>(sql, params)
        await new Promise<void>(resolve => { releaseScan = resolve })
        return rows
      }
      return originalGetAll<T>(sql, params)
    })

    try {
      env.repo.setFacetRuntime(runtimeWithReviewer())
      // Wait for reprojection-1 to enter its SELECT.
      await vi.waitFor(() => { expect(intercepted).toBe(true) })
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
          `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:reviewer'`,
        )
        const approverMarker = await env.h.db.getOptional(
          `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:approver'`,
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
        `SELECT 1 FROM client_schema_state WHERE key = 'reproject_ref:reviewer'`,
      )
      expect(row).not.toBeNull()
    })

    // Second Repo over the same SQLite file: emulates a fresh app start.
    // The merged schema map is kernel→merged-with-reviewer, which would
    // normally re-scan every block. The persisted marker should make
    // this a no-op.
    const cache2 = new BlockCache()
    const repo2 = new Repo({
      db: env.h.db,
      cache: cache2,
      user: {id: 'user-1'},
      registerKernelProcessors: false,
    })
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

describe('parseReferences — orphan cleanup (§7.5)', () => {
  it('typing [[foo]] then deleting the text within 4s → cleanup soft-deletes the orphan', async () => {
    await env.repo.tx(
      tx => tx.create({id: 'src', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    expect((await env.read(aliasId('foo')))!.deleted).toBe(0)
    // Clear the text — references go to []; foo's target now has no
    // referrer.
    await env.repo.mutate.setContent({id: 'src', content: ''})
    await flush()
    // Cleanup hasn't fired yet — still scheduled for 4s.
    expect((await env.read(aliasId('foo')))!.deleted).toBe(0)
    // Advance timers past the 4s mark.
    await flush(4000)
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

  it('re-typing [[foo]] after a create-and-cleanup cycle → restores the tombstoned target', async () => {
    // Cycle 1: create + cleanup.
    await env.repo.tx(
      tx => tx.create({id: 's1', workspaceId: WS, parentId: null, orderKey: 'a0', content: '[[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    await env.repo.mutate.setContent({id: 's1', content: ''})
    await flush(4000)
    expect((await env.read(aliasId('foo')))!.deleted).toBe(1)  // tombstoned

    // Cycle 2: re-type [[foo]] in a new block. createOrRestoreTargetBlock
    // catches DeletedConflictError and runs tx.restore.
    await env.repo.tx(
      tx => tx.create({id: 's2', workspaceId: WS, parentId: null, orderKey: 'a1', content: '[[foo]]'}),
      {scope: ChangeScope.BlockDefault},
    )
    await flush()
    const target = await env.read(aliasId('foo'))
    expect(target!.deleted).toBe(0)  // restored
    const refs = JSON.parse((await env.read('s2'))!.references_json)
    expect(refs).toEqual([{id: aliasId('foo'), alias: 'foo'}])
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
    // The references update used skipMetadata, so the source row's
    // updated_by stays at the user but the row_events still record
    // the change.
    const evt = await env.h.db.getAll<{kind: string; source: string}>(
      "SELECT kind, source FROM row_events WHERE block_id = ? ORDER BY id",
      ['src'],
    )
    // create (user) + update (references; user with References scope).
    expect(evt.map(e => e.kind)).toEqual(['create', 'update'])
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
