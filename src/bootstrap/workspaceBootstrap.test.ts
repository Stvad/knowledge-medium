// @vitest-environment happy-dom
/**
 * Bootstrap-level pin for the one contract this module owes the user above all
 * others: the workspace OPENS.
 *
 * `bootstrapWorkspace` awaits `repo.ensureSystemPages` on the critical path
 * with no catch, so anything that rejects there is fatal to workspace open —
 * no error surface, no partial degradation, the app simply does not come up.
 */

import * as kernelPage from '@/data/kernelPage'
import {migrationsPageBlockId} from '@/data/migrationsPage'
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
import { PLAINTEXT_ALIAS_SEATS } from '@/data/test/plaintextAliasSeats'
import { ALIAS_SEAT_PROBE_SLOTS, computeAliasSeatId, ensureAliasTarget } from '@/data/targets'
import { storeWorkspaceKey } from '@/data/test/e2eeFixtures'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import { propertyChildNamespaceInTx } from '@/data/internals/propertyChildMint'
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
      {spec: {namespace: '22222222-2222-4222-8222-222222222222', alias: 'Broken page', markerType: null}, eager: true},
    ])
    const original = kernelPage.getOrCreateKernelPage
    const create = vi.spyOn(kernelPage, 'getOrCreateKernelPage').mockImplementation((repo, ws, spec, options) =>
      spec.alias === 'Broken page' ? Promise.reject(new Error('transient')) : original(repo, ws, spec, options))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const layoutSession = await open()

    create.mockRestore()
    expect(layoutSession.id).toBeTruthy()
    expect(await repo.load(migrationsPageBlockId(WS))).toBeNull()
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
    await storeWorkspaceKey('user-1', encrypted)
    try {
      await open(encrypted)

      // The resolve is not awaited by `open`, so the first attempt can beat it.
      let minted = ''
      await vi.waitFor(() => repo.tx(async tx => {
        minted = (await ensureAliasTarget(tx, repo, 'Private page', encrypted)).id
      }, {scope: ChangeScope.BlockDefault, description: 'create page'}))
      const publicSlots = Array.from({length: ALIAS_SEAT_PROBE_SLOTS},
        (_, index) => computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, 'Private page', encrypted, index))
      expect(publicSlots).not.toContain(minted)
    } finally {
      localStorage.clear()
      await getWorkspaceKeyStore().delete('user-1', encrypted)
    }
  })

  it('resolves an encrypted workspace\'s property-child namespace on open', async () => {
    // A property write inside a transaction cannot read `K_id` either; without
    // this it would mint every field row at a random id.
    const encrypted = 'ws-bootstrap-e2ee-props'
    repo.setActiveWorkspaceId(encrypted)
    await sharedDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
        encryption_mode, properties_migration) VALUES (?, 'test', 'user-1', 1, 1, 'e2ee', 'cell')`,
      [encrypted],
    )
    setModePin('user-1', encrypted, 'e2ee')
    await storeWorkspaceKey('user-1', encrypted)
    try {
      await open(encrypted)

      // Not awaited by `open`, so poll for it.
      await vi.waitFor(async () => {
        let namespace: string | null = null
        await repo.tx(async tx => { namespace = await propertyChildNamespaceInTx(tx, encrypted) },
          {scope: ChangeScope.BlockDefault, description: 'probe'})
        // HMAC(K_id, 'km/property-child-ns/v1') for `storeWorkspaceKey`'s default key.
        expect(namespace).toBe('096acf4c-89fd-4e56-8595-c23d6801e6da')
      })
    } finally {
      localStorage.clear()
      await getWorkspaceKeyStore().delete('user-1', encrypted)
    }
  })

  it('opens an encrypted workspace even when its key store never answers', async () => {
    // IndexedDB can hang rather than fail, and the alias-seat namespace is
    // the one key read on this path.
    const encrypted = 'ws-bootstrap-e2ee-hung'
    repo.setActiveWorkspaceId(encrypted)
    await sharedDb.db.execute(
      `INSERT INTO workspaces (id, name, owner_user_id, create_time, update_time,
        encryption_mode, properties_migration) VALUES (?, 'test', 'user-1', 1, 1, 'e2ee', 'cell')`,
      [encrypted],
    )
    setModePin('user-1', encrypted, 'e2ee')
    const hung = vi.spyOn(getWorkspaceKeyStore(), 'get').mockReturnValue(new Promise(() => {}))
    try {
      expect((await open(encrypted)).id).toBeTruthy()
      expect(hung).toHaveBeenCalled()
    } finally {
      localStorage.clear()
    }
  })
})
