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
afterEach(() => { vi.restoreAllMocks() })

const open = () => bootstrapWorkspace({
  repo,
  workspaceId: WS,
  freshlyCreated: false,
  requestedHash: `#${WS}`,
  requestedWorkspaceId: WS,
})

describe('bootstrapWorkspace', () => {
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
