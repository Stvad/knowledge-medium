// @vitest-environment node
/**
 * Fuzz suite for issue #378: raw `tx.restore` call sites
 * (`getOrCreateKernelPage` src/data/kernelPage.ts,
 * `getOrCreateDailyNote` src/plugins/daily-notes/dailyNotes.ts) must not
 * resurrect a tombstone's stale alias claim. `getOrCreateJournalBlock` has
 * no raw restore call of its own — it's a thin wrapper over
 * `getOrCreateKernelPage` — but is driven here as its own scenario anyway,
 * since it's a distinct public entry point that shares the fix by
 * delegation rather than by construction.
 *
 * Mechanism under test (cited from the code): `blocks_alias_update`
 * (clientSchema.ts:778-788) fires on the `deleted` flip and re-inserts
 * every alias in the row's CURRENT `properties_json.alias` bag. A raw
 * `tx.restore(id, {content})` with no `properties` patch leaves that bag
 * untouched, so a tombstoned row whose bag still lists an alias a
 * DIFFERENT live block has since claimed trips
 * `block_aliases_workspace_alias_unique` (clientSchema.ts:837-846) and
 * aborts the WHOLE calling tx (repo.ts:2099-2130 →
 * `ProcessorRejection('alias.collision')`) — the row is stuck as an
 * unrestorable tombstone (exactly issue #378's "day is persistently
 * unopenable" repro). `restorePropertiesStrippingAliases` (targets.ts)
 * strips the bag's `aliases` key in the same restore UPDATE; each site's
 * own follow-up `tx.setProperty` then re-claims exactly its canonical
 * alias set. The three example regressions (kernelPage.test.ts,
 * dailyNotes.test.ts ×2) pin one hand-picked scenario per site each; this
 * suite is the general sweep — a RANDOM extra-alias bag on the tombstone,
 * a squatter claiming a random SUBSET of it, over all three call sites.
 *
 * Scope note: the squatter here only ever claims EXTRA aliases, never a
 * site's own canonical alias ('Foo' / 'Journal' / the daily-note's
 * ISO-or-long-form label) — a live block squatting the CANONICAL alias
 * itself is a genuine, separate, unresolved design question (issue #378's
 * body: "a bag-strip alone does NOT fully fix these entry points: their
 * follow-up setProperty(aliases, …) ... still unconditionally claim the
 * aliases and would collide with the squatter. Needs a domain decision
 * ... bind to the claimant / skip the contested alias / surface the
 * existing alias-collision-merge flow") that this fix deliberately leaves
 * alone — the follow-up setProperty in THAT case still throws today.
 *
 * Oracle: driving any of the three get-or-create flows against a
 * tombstoned target with a squatted extra alias must not throw, and the
 * restored block must never end up claiming an alias the squatter
 * currently holds — "a restore never resurrects an alias currently
 * claimed by a live block" — while its own canonical alias set is still
 * fully bound.
 *
 * Shared-DB discipline (docs/fuzzing.md §6): one `createTestDb()` for the
 * file, `resetTestDb` + a fresh `Repo` per case inside `runCase`.
 * `statefulFuzzGuard` protects the shared DB from a deep-tier interrupt's
 * abandoned case; `seed: null` because this property has no
 * Math.random-driven nondeterminism of its own to pin.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { seedType } from '@/data/api'
import { ChangeScope } from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { typeSeedsFacet } from '@/data/facets'
import { getOrCreateKernelPage } from '@/data/kernelPage'
import { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { dailyNotesDataExtension } from '@/plugins/daily-notes/dataExtension'
import { getOrCreateDailyNote, getOrCreateJournalBlock } from '@/plugins/daily-notes/dailyNotes'

const WS = 'ws-fuzz-378'
const FOO_PAGE_TYPE = 'panel:fuzz-378-foo'
const FOO_PAGE_NS = '2b7d6a5a-6b46-4c33-9c96-9e7fca9f9a10'
const ISO = '2026-04-28'

type SiteName = 'kernelPage' | 'journal' | 'dailyNote'
const SITE_NAMES: readonly SiteName[] = ['kernelPage', 'journal', 'dailyNote']

const materialize = (repo: Repo, site: SiteName): Promise<Block> => {
  switch (site) {
    case 'kernelPage':
      return getOrCreateKernelPage(repo, WS, {namespace: FOO_PAGE_NS, alias: 'Foo', markerType: FOO_PAGE_TYPE})
    case 'journal':
      return getOrCreateJournalBlock(repo, WS)
    case 'dailyNote':
      return getOrCreateDailyNote(repo, WS, ISO)
  }
}

// Namespaced away from every site's canonical alias ('Foo', 'Journal', the
// ISO date + its locale long-form) so the generated squatter below can
// never land on the (deliberately out-of-scope) canonical-alias-squatted
// case — see the docblock's scope note.
const extraAliasArb = fc.array(
  fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')),
  {minLength: 3, maxLength: 8},
).map(chars => `extra-${chars.join('')}`)

interface Case {
  site: SiteName
  // (alias, squattedByLiveBlock) pairs — a random extra-alias bag on the
  // tombstone, with a random subset claimed by a live squatter.
  entries: readonly (readonly [string, boolean])[]
}

const caseArb: fc.Arbitrary<Case> = fc.record({
  site: fc.constantFrom(...SITE_NAMES),
  entries: fc.uniqueArray(
    fc.tuple(extraAliasArb, fc.boolean()),
    {selector: ([alias]) => alias, maxLength: 4},
  ),
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => {
  await guard.barrier()
  await sharedDb.cleanup()
})

/** Interrupt-barrier for the shared DB (docs/fuzzing.md §6). `seed: null`
 *  below — nothing here reads `Math.random`. */
const guard = statefulFuzzGuard()

const runCase = async ({site, entries}: Case): Promise<void> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [
      dailyNotesDataExtension,
      typeSeedsFacet.of(
        seedType({seedKey: 'test/type/fuzz-378-foo', revision: 1, id: FOO_PAGE_TYPE, label: 'Foo'}),
        {source: 'test'},
      ),
    ],
  })
  repo.setActiveWorkspaceId(WS)

  const block = await materialize(repo, site)
  const canonical = [...(block.peekProperty(aliasesProp) ?? [])]
  const extraAliases = entries.map(([alias]) => alias)
  const squattedAliases = entries.filter(([, squatted]) => squatted).map(([alias]) => alias)

  // Tombstone the target with its canonical alias PLUS the random extras
  // still in the bag — same shape as a page that picked up an extra alias
  // before being deleted.
  await repo.tx(async tx => {
    if (extraAliases.length > 0) {
      await tx.setProperty(block.id, aliasesProp, [...canonical, ...extraAliases])
    }
    await tx.delete(block.id)
  }, {scope: ChangeScope.BlockDefault})

  // A different live block claims a random subset of the freed extras
  // while the target is dead.
  if (squattedAliases.length > 0) {
    await repo.tx(async tx => {
      await tx.create({id: 'squatter', workspaceId: WS, parentId: null, orderKey: 'z0', content: 'Squatter'})
      await tx.setProperty('squatter', aliasesProp, squattedAliases)
    }, {scope: ChangeScope.BlockDefault})
  }

  // The guarded flow — must not throw (issue #378).
  const restored = await materialize(repo, site)

  expect(restored.peek()?.deleted, `${site}: restored, not still a tombstone`).toBe(false)
  const restoredAliases = restored.peekProperty(aliasesProp) ?? []
  for (const alias of squattedAliases) {
    expect(restoredAliases, `${site}: must not resurrect squatted alias "${alias}"`).not.toContain(alias)
  }
  for (const alias of canonical) {
    expect(restoredAliases, `${site}: own canonical alias "${alias}" still bound`).toContain(alias)
  }
  if (squattedAliases.length > 0) {
    expect(
      repo.block('squatter').peekProperty(aliasesProp),
      'squatter keeps what it claimed',
    ).toEqual(squattedAliases)
  }
}

describe('raw tx.restore call sites never resurrect a squatted alias (issue #378)', () => {
  it('kernelPage / journal / dailyNote restore is safe against a random squatted extra alias', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, ({site, entries}) => guard.run(null, () => runCase({site, entries}))),
      fuzzParams(12),
    )
  }, fuzzTestTimeout())
})
