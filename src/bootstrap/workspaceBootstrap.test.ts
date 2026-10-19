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
import { ChangeScope } from '@/data/api'
import { PLAINTEXT_ALIAS_SEATS } from '@/data/aliasSeatNamespace'
import { ALIAS_SEAT_PROBE_SLOTS, computeAliasSeatId, ensureAliasTarget } from '@/data/targets'
import { deriveContentKeyHmac } from '@/sync/crypto/contentKey'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
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

const open = (workspaceId = WS) => bootstrapWorkspace({
  repo,
  workspaceId,
  freshlyCreated: false,
  requestedHash: `#${workspaceId}`,
  requestedWorkspaceId: workspaceId,
})

describe('bootstrapWorkspace', () => {
  it('opens a children-backed workspace with definition readiness before its writes', async () => {
    await sharedDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
        encryption_mode, properties_migration) VALUES (?, 'test', 'user-1', 1, 1, 'none', 'children')`,
      [WS],
    )

    const session = await open()

    expect(await repo.load(session.id)).toBeTruthy()
    const propertiesPage = await repo.load(propertiesPageBlockId(WS))
    expect(propertiesPage?.content).toBe('Properties')
    const fields = await sharedDb.db.getAll<{reference_target_id: string}>(
      'SELECT reference_target_id FROM blocks WHERE parent_id = ? AND is_field_form = 1 AND deleted = 0',
      [propertiesPage!.id],
    )
    const names = Object.keys(propertiesPage!.properties)
    expect(names.length).toBeGreaterThan(0)
    for (const name of names) {
      const definition = repo.propertySchemaResolverFor(WS).resolve(name)
      expect(definition.status).toBe('resolved')
      if (definition.status !== 'resolved') throw new Error(`missing definition for ${name}`)
      expect(fields).toContainEqual({reference_target_id: definition.schema.fieldId})
    }
  })

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

  it('leaves an encrypted workspace ready for a page created inside a transaction', async () => {
    // Such a writer cannot read `K_id` under the write lock, so it depends on
    // the workspace's alias-seat namespace having been resolved on open.
    const encrypted = 'ws-bootstrap-e2ee'
    repo.setActiveWorkspaceId(encrypted)
    await sharedDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
        encryption_mode, properties_migration) VALUES (?, 'test', 'user-1', 1, 1, 'e2ee', 'cell')`,
      [encrypted],
    )
    setModePin('user-1', encrypted, 'e2ee')
    const wk = await crypto.subtle.generateKey(
      {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
    await getWorkspaceKeyStore().put('user-1', encrypted, {
      wk, contentKeyHmac: await deriveContentKeyHmac(new Uint8Array(32).fill(3)),
    })
    try {
      await open(encrypted)

      let minted = ''
      await repo.tx(async tx => {
        minted = (await ensureAliasTarget(tx, repo, 'Private page', encrypted)).id
      }, {scope: ChangeScope.BlockDefault, description: 'create page'})
      const publicSlots = Array.from({length: ALIAS_SEAT_PROBE_SLOTS},
        (_, index) => computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, 'Private page', encrypted, index))
      expect(publicSlots).not.toContain(minted)
    } finally {
      localStorage.clear()
      await getWorkspaceKeyStore().delete('user-1', encrypted)
    }
  })
})
