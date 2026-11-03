// @vitest-environment node
/**
 * `[[links]]` on an END-TO-END ENCRYPTED workspace (#719): a new page's id must
 * not be a hash of its name that an untrusted server can recompute, and a
 * workspace converted in place must not grow a second page for a name it
 * already has.
 *
 * Node with a stubbed localStorage, because an `e2ee` mode pin needs a durable
 * store and `K_id` lives in the key store — process-wide state the plaintext
 * suites must not inherit. The derived namespace is cached per workspace for
 * the life of the module, so each test takes a fresh workspace id.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { resolveAliasSeatNamespaces } from '@/data/aliasSeatNamespace'
import { PLAINTEXT_ALIAS_SEATS } from '@/data/test/plaintextAliasSeats'
import type { Repo } from '@/data/repo'
import {
  ALIAS_SEAT_PROBE_SLOTS,
  computeAliasSeatId,
  ensureAliasTarget,
} from '@/data/targets'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  seedWorkspaceRow as seedWorkspaceRowIn, storeWorkspaceKey, stubLocalStorage,
} from '@/data/test/e2eeFixtures'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin, upgradeModePinToE2ee } from '@/sync/keys/modePin'
import { onWorkspaceKeyUnavailable } from '@/sync/keys/openWorkspaceKeys'
import { referencesDataExtension } from '../dataExtension.ts'

const USER = 'user-seats-e2ee'

let sharedDb: TestDb
let repo: Repo
let workspaceCounter = 0
let WS = ''

const seedWorkspaceRow = (encryptionMode: 'none' | 'e2ee') =>
  seedWorkspaceRowIn(sharedDb.db, WS, USER, encryptionMode)
const storeContentKey = () => storeWorkspaceKey(USER, WS)

const openEncrypted = async () => {
  await seedWorkspaceRow('e2ee')
  setModePin(USER, WS, 'e2ee')
  await storeContentKey()
}

const openPlaintext = async () => {
  await seedWorkspaceRow('none')
  setModePin(USER, WS, 'plaintext')
}

/** The in-place conversion as this device sees it: the synced row flips, the
 *  key arrives, the pin upgrades — with the app still running. */
const convertInPlace = async () => {
  await seedWorkspaceRow('e2ee')
  await storeContentKey()
  upgradeModePinToE2ee(USER, WS)
}

/** A page that claims `alias` at an id no seat probe produces. */
const createPage = async (id: string, alias: string) => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: `p-${id}`, content: alias})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault, description: 'create page'})
  await repo.awaitProcessors()
}

const write = async (id: string, content: string) => {
  await repo.tx(async tx => {
    if (await tx.get(id)) await tx.update(id, {content})
    else await tx.create({id, workspaceId: WS, parentId: null, orderKey: `k-${id}`, content})
  }, {scope: ChangeScope.BlockDefault, description: 'write'})
  await repo.awaitProcessors()
}

/** The id `source`'s stored reference for `[[alias]]` points at. */
const targetOf = async (source: string, alias: string): Promise<string> => {
  const row = await sharedDb.db.get<{references_json: string}>(
    'SELECT references_json FROM blocks WHERE id = ?', [source])
  const ref = (JSON.parse(row.references_json) as Array<{id: string; alias: string}>)
    .find(candidate => candidate.alias === alias)
  if (!ref) throw new Error(`${source} has no reference for [[${alias}]]`)
  return ref.id
}

const row = (id: string) => sharedDb.db.getOptional<{deleted: 0 | 1; content: string}>(
  'SELECT deleted, content FROM blocks WHERE id = ?', [id])

const publicSlotIds = (alias: string) => Array.from({length: ALIAS_SEAT_PROBE_SLOTS},
  (_, index) => computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, alias, WS, index))

const liveClaimants = async (alias: string) => (await sharedDb.db.getAll<{id: string}>(
  `SELECT b.id FROM block_aliases a JOIN blocks b ON b.id = a.block_id
    WHERE a.workspace_id = ? AND a.alias = ? AND b.deleted = 0`,
  [WS, alias])).map(r => r.id)

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  await getWorkspaceKeyStore().delete(USER, WS)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  stubLocalStorage()
  WS = `ws-seats-e2ee-${++workspaceCounter}`
  repo = createTestRepo({
    db: sharedDb.db,
    user: {id: USER},
    extensions: [dailyNotesDataExtension, referencesDataExtension],
  }).repo
  repo.setActiveWorkspaceId(WS)
})

describe('alias seats on an encrypted workspace', () => {
  it('mints a new page under the workspace\'s own namespace, never at a public slot', async () => {
    await openEncrypted()

    await write('src', 'see [[Secret plans]]')

    const target = await targetOf('src', 'Secret plans')
    const sealed = await resolveAliasSeatNamespaces(repo, WS)
    expect(target).toBe(computeAliasSeatId(sealed, 'Secret plans', WS))
    expect(publicSlotIds('Secret plans')).not.toContain(target)
    expect(await row(target)).toEqual({deleted: 0, content: 'Secret plans'})
  })

  it('reaps the page once its last [[link]] is gone, like any seat', async () => {
    await openEncrypted()
    await write('src', '[[Fleeting]]')
    const seat = await targetOf('src', 'Fleeting')

    await write('src', 'no link any more')

    expect((await row(seat))?.deleted).toBe(1)
  })

  it('mints nothing without a key and reports the workspace locked, still deriving the links that need no new page',
    async () => {
      await seedWorkspaceRow('e2ee')
      setModePin(USER, WS, 'e2ee')
      await createPage('known', 'Known')
      const locked = vi.fn()
      const unsubscribe = onWorkspaceKeyUnavailable(locked)
      vi.spyOn(console, 'warn').mockImplementation(() => {})

      try {
        await write('src', '[[Known]] and [[Secret plans]]')
      } finally {
        unsubscribe()
      }

      expect(locked).toHaveBeenCalledWith(USER, WS)
      expect(await liveClaimants('Secret plans')).toEqual([])
      expect(await targetOf('src', 'Known')).toBe('known')
    })

  it('keeps the rest of the write when the workspace turns sealed under the lock', async () => {
    // The read phase planned under plaintext; by the time the write phase
    // holds the lock, the row has flipped and nothing has resolved the
    // derived namespace yet.
    await openPlaintext()
    await createPage('known', 'Known')
    // Every write, the processor's included, funnels through `transact`.
    type Transact = (fn: unknown, options: {description?: string}, runtime?: unknown) => Promise<unknown>
    const internals = repo as unknown as {transact: Transact}
    const transact = internals.transact.bind(repo)
    vi.spyOn(internals, 'transact').mockImplementation(async (fn, options, runtime) => {
      if (options.description?.includes('parseReferences')) await seedWorkspaceRow('e2ee')
      return transact(fn, options, runtime)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await write('src', '[[Known]] and [[Racing]]')

    expect(await targetOf('src', 'Known')).toBe('known')
    expect(await liveClaimants('Racing')).toEqual([])
    // Not a reference to a page that was never minted.
    await expect(targetOf('src', 'Racing')).rejects.toThrow(/no reference/)
  })

  it('refuses an in-transaction mint nothing resolved before the lock, writing nothing', async () => {
    await openEncrypted()

    await expect(repo.tx(async tx => {
      await ensureAliasTarget(tx, repo, 'Cold', WS)
    }, {scope: ChangeScope.BlockDefault, description: 'mint'})).rejects.toThrow(/before the write lock/)
    expect(await liveClaimants('Cold')).toEqual([])
  })
})

describe('alias seats across an in-place conversion', () => {
  it('binds a new [[link]] to the page the plaintext workspace already had', async () => {
    await openPlaintext()
    await write('a', '[[Foo]]')
    const legacy = await targetOf('a', 'Foo')
    expect(legacy).toBe(computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, 'Foo', WS))

    await convertInPlace()
    await write('b', '[[Foo]] and [[Bar]]')

    expect(await targetOf('b', 'Foo')).toBe(legacy)
    expect(await liveClaimants('Foo')).toEqual([legacy])
    expect(publicSlotIds('Bar')).not.toContain(await targetOf('b', 'Bar'))
  })

  it('leaves a pristine public-namespace tombstone dead and mints the page afresh', async () => {
    // Restoring it would write at an id that names the page; by the
    // restorable predicate it holds nothing worth keeping.
    await openPlaintext()
    await write('a', '[[Foo]]')
    const legacy = await targetOf('a', 'Foo')
    await repo.tx(async tx => { await tx.delete(legacy) },
      {scope: ChangeScope.BlockDefault, description: 'delete page'})

    await convertInPlace()
    await write('b', '[[Foo]]')

    const fresh = await targetOf('b', 'Foo')
    expect(publicSlotIds('Foo')).not.toContain(fresh)
    expect((await row(legacy))?.deleted).toBe(1)
    expect(await liveClaimants('Foo')).toEqual([fresh])
  })

  it('still reaps an orphaned seat minted before the conversion', async () => {
    await openPlaintext()
    await write('a', '[[Foo]]')
    const legacy = await targetOf('a', 'Foo')

    await convertInPlace()
    await write('a', 'no link any more')

    expect((await row(legacy))?.deleted).toBe(1)
  })
})
