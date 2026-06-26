// @vitest-environment node
/**
 * Tests for `Repo.ensureSystemPages` + the `systemPagesFacet` seam.
 *
 * Singleton pages with reserved aliases (Properties/Types/Recents/Journal/
 * Locations) must exist BEFORE the workspace's landing/seed runs — otherwise a
 * `[[reserved alias]]` wiki-link auto-creates a rival page at a different id and
 * the alias sync processor raises `alias.collision`. `ensureSystemPages` reads
 * every owner's `systemPagesFacet` contribution off the repo's runtime and
 * get-or-creates each (idempotent, deterministic id).
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { aliasesProp } from '@/data/properties'
import { BlockCache } from '@/data/blockCache'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { Repo } from '@/data/repo'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { geoDataExtension } from '@/plugins/geo/dataExtension'

const WS = 'ws-1'

// The reserved aliases each owner declares via systemPagesFacet. These are the
// names that collide if a wiki-link auto-creates a rival before bootstrap runs.
const EXPECTED_ALIASES = ['Properties', 'Types', 'Recents', 'Journal', 'Locations']

interface Harness {
  h: TestDb
  repo: Repo
}

const setup = async (): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  const cache = new BlockCache()
  let timeCursor = 1700_000_000_000
  let idCursor = 0
  const repo = new Repo({
    db: h.db,
    cache,
    user: { id: 'user-1' },
    now: () => ++timeCursor,
    newId: () => `gen-${++idCursor}`,
  })
  // Install the data extensions that own system pages — exactly the data-layer
  // surface production gives the repo at construction (src/context/repo.tsx).
  repo.setFacetRuntime(
    resolveFacetRuntimeSync([kernelDataExtension, dailyNotesDataExtension, geoDataExtension]),
  )
  return { h, repo }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { env.repo.stopSyncObserver() })

const aliasesInWorkspace = async (h: TestDb, repo: Repo): Promise<Set<string>> => {
  const rows = await h.db.getAll<{ id: string }>('SELECT id FROM blocks WHERE deleted = 0')
  const out = new Set<string>()
  for (const { id } of rows) {
    await repo.load(id)
    const aliases = repo.block(id).peekProperty(aliasesProp)
    if (Array.isArray(aliases)) for (const a of aliases) out.add(a)
  }
  return out
}

describe('Repo.ensureSystemPages', () => {
  it('creates every owner-declared system page with its reserved alias', async () => {
    await env.repo.ensureSystemPages(WS)
    const aliases = await aliasesInWorkspace(env.h, env.repo)
    for (const expected of EXPECTED_ALIASES) {
      expect(aliases.has(expected)).toBe(true)
    }
  })

  it('is idempotent — a second run creates no new rows', async () => {
    await env.repo.ensureSystemPages(WS)
    const before = (await env.h.db.getAll<{ c: number }>(
      'SELECT COUNT(*) AS c FROM blocks WHERE deleted = 0',
    ))[0]?.c
    await env.repo.ensureSystemPages(WS)
    const after = (await env.h.db.getAll<{ c: number }>(
      'SELECT COUNT(*) AS c FROM blocks WHERE deleted = 0',
    ))[0]?.c
    expect(after).toBe(before)
  })
})
