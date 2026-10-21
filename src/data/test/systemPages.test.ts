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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { aliasesProp } from '@/data/properties'
import { systemPagesFacet } from '@/data/facets'
import type { AppExtension } from '@/facets/facet'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
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

const setup = async (extras: readonly AppExtension[] = []): Promise<Harness> => {
  await resetTestDb(sharedDb.db)
  const h = sharedDb
  // Install the data extensions that own system pages — exactly the data-layer
  // surface production gives the repo at construction (src/context/repo.tsx).
  const { repo } = createTestRepo({
    db: h.db,
    user: { id: 'user-1' },
    extensions: [dailyNotesDataExtension, geoDataExtension, ...extras],
  })
  return { h, repo }
}

let sharedDb: TestDb
let env: Harness
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { env = await setup() })
afterEach(() => { vi.restoreAllMocks() })

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

  /** One page's failure must not take the workspace down with it:
   *  `bootstrapWorkspace` awaits this on the critical path with no catch, so an
   *  unisolated rejection stops the app coming up rather than degrading one
   *  page's feature. */
  describe('when one page cannot be created', () => {
    it('survives an owner whose ensure throws something that is not a rejection', async () => {
      // A plugin bug, not a data condition — an extension is transpiled, not
      // typechecked, so its `ensure` can throw anything at all.
      env = await setup([
        systemPagesFacet.of(
          {id: 'test:broken', ensure: () => Promise.reject(new Error('plugin bug'))},
          {source: 'test'},
        ),
      ])
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(env.repo.ensureSystemPages(WS)).resolves.toBeUndefined()

      const aliases = await aliasesInWorkspace(env.h, env.repo)
      for (const expected of EXPECTED_ALIASES) expect(aliases.has(expected)).toBe(true)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test:broken'))
    })

    /**
     * ...but on a FRESHLY CREATED workspace the same failure stays fatal, and
     * the reason is data safety rather than severity. A new workspace has no
     * blocks, so no alias can be taken and the failure is transient or a bug —
     * while the first-run seed immediately after publishes `[[Properties]]`,
     * `[[Types]]`, `[[Locations]]` and `[[Journal]]` into the tutorial. With no
     * page holding those names the references processor mints a rival at an
     * alias-seat id for each, and the canonical page can never be created
     * afterwards. Throwing leaves the workspace unseeded and lets the retry
     * work; swallowing makes a transient failure permanent.
     */
    it('survives an owner that throws SYNCHRONOUSLY, before returning a promise', async () => {
      // An extension is transpiled, not typechecked, so an ordinary bug on the
      // first line of `ensure` throws before any promise exists — and TS accepts
      // it, because `never` satisfies the declared `Promise` return. The current
      // shape catches it structurally rather than by a clause; this guards a
      // refactor that lifts the try/catch back out of the callback.
      env = await setup([
        systemPagesFacet.of(
          {id: 'test:sync-throw', ensure: (): Promise<unknown> => { throw new Error('sync bug') }},
          {source: 'test'},
        ),
      ])
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(env.repo.ensureSystemPages(WS)).resolves.toBeUndefined()

      const aliases = await aliasesInWorkspace(env.h, env.repo)
      for (const expected of EXPECTED_ALIASES) expect(aliases.has(expected)).toBe(true)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('test:sync-throw'))
    })

  })

  it('is idempotent — a second run creates no new rows', async () => {
    // Compares the row SET, not a count: a count that moves says only "one
    // more", where the ids name which page appeared late and whether the
    // newcomer is even a system page.
    const liveRows = async (): Promise<string[]> => (
      await env.h.db.getAll<{ id: string; content: string }>(
        'SELECT id, content FROM blocks WHERE deleted = 0 ORDER BY id',
      )
    ).map(r => `${r.content} (${r.id})`)

    await env.repo.ensureSystemPages(WS)
    const before = await liveRows()
    await env.repo.ensureSystemPages(WS)

    expect(await liveRows()).toEqual(before)
    expect(before).toHaveLength(EXPECTED_ALIASES.length)
  })
})
