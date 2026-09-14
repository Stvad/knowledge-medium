// @vitest-environment happy-dom
/**
 * Bootstrap-level pin for the one contract this module owes the user above all
 * others: the workspace OPENS.
 *
 * `bootstrapWorkspace` awaits `repo.ensureSystemPages` on the critical path
 * with no catch, so anything that rejects there is fatal to workspace open —
 * no error surface, no partial degradation, the app simply does not come up.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

// The deferred work `bootstrapWorkspace` schedules is released by the global
// `testRepoScope` hooks, which unpin and drain every Repo built during a test.

const open = () => bootstrapWorkspace({
  repo,
  workspaceId: WS,
  freshlyCreated: false,
  requestedHash: `#${WS}`,
  requestedWorkspaceId: WS,
})

describe('bootstrapWorkspace', () => {
  it('opens the workspace even when a system page cannot be materialized', async () => {
    // What still reaches here now that a contested alias is yielded rather than
    // thrown: a foreign row at the derived id, or an ordinary bug in a
    // transpiled extension. Either one, uncaught, stops the app coming up.
    repo.setRuntimeContributions(systemPagesFacet, 'test-pages', [
      {id: 'test:broken', ensure: () => Promise.reject(new Error('transient'))},
    ])
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const layoutSession = await open()

    expect(layoutSession.id).toBeTruthy()
    // Its siblings materialized alongside the failure, rather than being
    // stranded by it.
    expect((await repo.load(propertiesPageBlockId(WS)))?.content).toBe('Properties')
    expect((await repo.load(typesPageBlockId(WS)))?.content).toBe('Types')
    expect((await repo.load(recentsPageBlockId(WS)))?.content).toBe('Recents')
  })
})
