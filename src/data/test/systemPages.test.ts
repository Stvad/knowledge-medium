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
import { ChangeScope, ProcessorRejection } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { systemPagesFacet } from '@/data/facets'
import type { AppExtension } from '@/facets/facet'
import { propertiesPageBlockId } from '@/data/propertiesPage'
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

/** Park `alias` on an ordinary user block, the way a user who happened to name
 *  a page "Properties" leaves the workspace. `aliasesProp` is unique per
 *  workspace, so the kernel page's own claim is then refused. */
const seatAlias = async (repo: Repo, id: string, alias: string): Promise<void> => {
  await repo.tx(async tx => {
    await tx.create({id, workspaceId: WS, parentId: null, orderKey: 'a9', content: alias})
    await tx.setProperty(id, aliasesProp, [alias])
  }, {scope: ChangeScope.BlockDefault})
}

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

  /**
   * One page's failure must not take the workspace down with it.
   *
   * `bootstrapWorkspace` awaits this on the critical path with no catch, so a
   * bare `Promise.all` makes any single `ensure` rejection fatal to workspace
   * OPEN — and the realistic cause is an alias a user's own block already
   * holds, whose remedy (rename that block) needs the app to be open.
   */
  describe('when one page cannot be created', () => {
    it('resolves rather than rejecting, and still creates every other page', async () => {
      await seatAlias(env.repo, 'user-page', 'Properties')

      await expect(env.repo.ensureSystemPages(WS)).resolves.toBeUndefined()

      const aliases = await aliasesInWorkspace(env.h, env.repo)
      for (const expected of EXPECTED_ALIASES.filter(a => a !== 'Properties')) {
        expect(aliases.has(expected)).toBe(true)
      }
      // The one that failed is genuinely absent — degraded, not silently faked.
      expect(await env.repo.load(propertiesPageBlockId(WS))).toBeNull()
    })

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

    it('tells the user, for a failure nothing else reported', async () => {
      env = await setup([
        systemPagesFacet.of(
          {id: 'test:broken', ensure: () => Promise.reject(new Error('plugin bug'))},
          {source: 'test'},
        ),
      ])
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const errors: ProcessorRejection[] = []
      env.repo.onUserError(e => errors.push(e))

      await env.repo.ensureSystemPages(WS)

      expect(errors).toHaveLength(1)
      expect(errors[0].code).toBe('systemPage.unavailable')
      expect(errors[0].meta).toMatchObject({pageId: 'test:broken', workspaceId: WS})
    })

    it('re-reports the actionable rejection itself, never a vaguer wrapper', async () => {
      // `alias.collision` names the conflicting block and offers to open it —
      // that IS the remedy. Wrapping it in a generic `systemPage.unavailable`
      // notice would replace the one thing the user can act on. Two land here
      // (repo.tx fires one on its way out, this fires the second); collapsing
      // them belongs to the toast layer, which keys a slot on (code, message).
      await seatAlias(env.repo, 'user-page', 'Properties')
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const errors: ProcessorRejection[] = []
      env.repo.onUserError(e => errors.push(e))

      await env.repo.ensureSystemPages(WS)

      expect(errors.map(e => e.code)).toEqual(['alias.collision', 'alias.collision'])
      // Logged all the same: that rejection names the conflicting block but not
      // which system page was lost to it, and only this line says so.
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('kernel:properties'))
    })

    it('surfaces a rejection an owner threw without ever opening a tx', async () => {
      // `SystemPage.ensure` is any async function, so a contributor can build a
      // ProcessorRejection from its own validation and reject with it directly.
      // Nothing fanned that one out, so treating "is a ProcessorRejection" as
      // "someone already told the user" would leave this failure silent.
      const ownRejection = new ProcessorRejection('bad spec', 'test.badSpec', {})
      env = await setup([
        systemPagesFacet.of(
          {id: 'test:preflight', ensure: () => Promise.reject(ownRejection)},
          {source: 'test'},
        ),
      ])
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const errors: ProcessorRejection[] = []
      env.repo.onUserError(e => errors.push(e))

      await env.repo.ensureSystemPages(WS)

      expect(errors).toEqual([ownRejection])
    })
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
