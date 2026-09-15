// @vitest-environment node
/**
 * Integration test for the system-pages collision fix.
 *
 * `[[Name]]` is auto-create: the references processor mints a page at an
 * alias-"seat" id when no page with that alias exists. The singleton system
 * pages (Journal/Properties/Types/Locations) live at their OWN deterministic
 * ids and claim a reserved alias, so a wiki-link that resolves before the
 * canonical page exists auto-creates a RIVAL claimant → two blocks, one alias →
 * `alias.collision`.
 *
 * `Repo.ensureSystemPages` (run at bootstrap before the seed) creates the
 * canonical pages first, so `aliasLookup` hits and no rival is minted. This
 * exercises the real references + alias processors — the unit tests for
 * `ensureSystemPages` don't.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { aliasesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { referencesDataExtension } from '@/plugins/references/dataExtension'
import { aliasDataExtension } from '@/plugins/alias/dataExtension'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { geoDataExtension } from '@/plugins/geo/dataExtension'
import { journalBlockId, getOrCreateJournalBlock } from '@/plugins/daily-notes/dailyNotes'
import { propertiesPageBlockId } from '@/data/propertiesPage'
import { typesPageBlockId } from '@/data/typesPage'
import { locationsPageBlockId } from '@/plugins/geo/locationsPage'

const WS = 'ws-1'

interface Harness { h: TestDb; repo: Repo }

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  // Full data surface needed for the bug: references (auto-create on `[[ ]]`),
  // alias (collision detection), plus the owners of the system pages.
  const { repo } = createTestRepo({
    db: h.db,
    user: { id: 'user-1' },
    extensions: [
      referencesDataExtension,
      aliasDataExtension,
      dailyNotesDataExtension,
      geoDataExtension,
    ],
  })
  repo.setActiveWorkspaceId(WS)
  return { h, repo }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  env = await setup()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

const flush = async () => {
  await vi.advanceTimersByTimeAsync(1)
  await env.repo.awaitProcessors()
}

const lookup = (alias: string) =>
  env.repo.query.aliasLookup({ workspaceId: WS, alias }).load()

const seedBlockLinking = async (content: string): Promise<void> => {
  await env.repo.tx(async tx => {
    await tx.create({ id: 'seed', workspaceId: WS, parentId: null, orderKey: 'a0', content })
  }, { scope: ChangeScope.BlockDefault })
  await flush()
}

describe('system-pages alias-collision fix', () => {
  it('wiki-links to system pages resolve to the canonical page when ensured first', async () => {
    await env.repo.ensureSystemPages(WS)
    await seedBlockLinking('[[Journal]] [[Properties]] [[Types]] [[Locations]]')

    // Each link resolved to the eager canonical page — no rival minted at a
    // different (alias-seat) id.
    expect((await lookup('Journal'))?.id).toBe(journalBlockId(WS))
    expect((await lookup('Properties'))?.id).toBe(propertiesPageBlockId(WS))
    expect((await lookup('Types'))?.id).toBe(typesPageBlockId(WS))
    expect((await lookup('Locations'))?.id).toBe(locationsPageBlockId(WS))
  })

  it('negative control: without the eager page, the rival keeps the alias', async () => {
    // No ensureSystemPages. The wiki-link auto-creates a rival "Journal" at a
    // seat id…
    await seedBlockLinking('[[Journal]]')
    const rival = await lookup('Journal')
    expect(rival?.id).not.toBe(journalBlockId(WS))

    // …so the canonical Journal comes up WITHOUT its own name: the rival holds
    // it, and `[[Journal]]` keeps resolving there until the two are merged.
    // This used to throw `alias.collision` instead, which killed the tx the
    // page was created in and left it permanently uncreatable — the reason
    // eager creation matters, and what the merge flow now resolves.
    const journal = await getOrCreateJournalBlock(env.repo, WS)
    expect(journal.id).toBe(journalBlockId(WS))
    expect(await env.repo.load(journal.id)).not.toBeNull()
    expect(journal.peekProperty(aliasesProp) ?? []).not.toContain('Journal')
    expect((await lookup('Journal'))?.id).toBe(rival?.id)
  })
})
