// @vitest-environment happy-dom
/**
 * Bootstrap-level pin for the one contract this module owes the user above all
 * others: the workspace OPENS.
 *
 * `bootstrapWorkspace` awaits `repo.ensureSystemPages` on the critical path
 * with no catch, so anything that rejects there is fatal to workspace open —
 * no error surface, no partial degradation, the app simply does not come up.
 * The realistic trigger is a reserved alias a user's own block already holds
 * ("Properties" is an ordinary English word), and its remedy is renaming a
 * block that can only be reached from inside the app that won't start.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { propertiesPageBlockId } from '@/data/propertiesPage'
import { typesPageBlockId } from '@/data/typesPage'
import { recentsPageBlockId } from '@/data/recentsPage'
import { systemPagesFacet } from '@/data/facets'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { bootstrapWorkspace } from './workspaceBootstrap.ts'

const WS = 'ws-bootstrap'

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [dailyNotesDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(async () => {
  vi.restoreAllMocks()
  // `bootstrapWorkspace` schedules real deferred work — seed materialization,
  // backfills, reprojection, reference-target derive, reconcile rescan. Left
  // running, those callbacks resume against the next test's freshly reset
  // database, or a closed one after `afterAll`. Unpinning the workspace is the
  // production cancel path rather than a test-only hatch: it aborts the parked
  // access waits and disposes the backfill gate, which is also what lets the
  // drains below finish — a `freshlyCreated: false` seed pass parks on a
  // membership row that never arrives in a bare test database, so draining
  // without the unpin hangs instead of settling.
  repo.setActiveWorkspaceId(null)
  await Promise.all([
    repo.awaitSeedMaterialization(),
    repo.awaitWorkspaceBackfills(),
    repo.awaitReprojections(),
    repo.awaitReferenceTargetDerive(),
    repo.awaitReconcileRescans(),
  ])
})

const open = (freshlyCreated = false) => bootstrapWorkspace({
  repo,
  workspaceId: WS,
  freshlyCreated,
  requestedHash: `#${WS}`,
  requestedWorkspaceId: WS,
})

describe('bootstrapWorkspace', () => {
  /**
   * The other half of the same rule: on a workspace this run just created, a
   * system page that cannot be materialized must STOP bootstrap. Nothing has
   * claimed the reserved aliases yet, and the landing resolver immediately
   * after seeds a tutorial containing `[[Properties]]`, `[[Types]]`,
   * `[[Locations]]` and `[[Journal]]` — each of which the references processor
   * would auto-create a rival for, permanently taking the name. Throwing here
   * leaves the workspace unseeded and the retry able to succeed.
   */
  it('does NOT open a freshly created workspace whose system page failed', async () => {
    repo.setRuntimeContributions(systemPagesFacet, 'test-pages', [
      {id: 'test:broken', ensure: () => Promise.reject(new Error('transient'))},
    ])

    await expect(open(true)).rejects.toThrow('transient')

    // Nothing was seeded, so no rival holds a reserved alias: the retry is clean.
    const seatedAliases = await sharedDb.db.getAll<{alias: string}>(
      'SELECT alias FROM block_aliases WHERE workspace_id = ?', [WS],
    )
    expect(seatedAliases.map(r => r.alias)).not.toContain('Properties')
  })

  it('opens the workspace even when a user block already holds a system page alias', async () => {
    // Exactly the shape a user leaves behind by naming one of their own pages
    // "Properties": the alias is unique per workspace, so the kernel page's
    // claim is refused for a reason bootstrap cannot fix.
    await repo.tx(async tx => {
      await tx.create({id: 'user-page', workspaceId: WS, parentId: null, orderKey: 'a9', content: 'Properties'})
      await tx.setProperty('user-page', aliasesProp, ['Properties'])
    }, {scope: ChangeScope.BlockDefault})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const layoutSession = await open()

    expect(layoutSession.id).toBeTruthy()
    // The colliding page is the only casualty; its siblings still materialized.
    expect(await repo.load(propertiesPageBlockId(WS))).toBeNull()
    expect((await repo.load(typesPageBlockId(WS)))?.content).toBe('Types')
    expect((await repo.load(recentsPageBlockId(WS)))?.content).toBe('Recents')
    // And the user's own block kept the name it had.
    expect((await repo.load('user-page'))?.properties[aliasesProp.name]).toEqual(['Properties'])
  })
})
