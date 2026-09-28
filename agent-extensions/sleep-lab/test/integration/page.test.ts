/** Integration tier for `src/km/page.ts` — the lab page's bootstrap
 *  (`getOrCreateLabPage`) and defensive lookup (`findLabPage`) against a
 *  real `Repo`. Harness mirrors `nights.test.ts`/`experiment.test.ts` in
 *  this directory (itself mirroring the Strength Tracker's own).
 *
 *  `{timeout: 30_000}` is headroom, not a measured need — see those files'
 *  own doc comments for the load-multiplier note this follows.
 */
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'

import {ChangeScope, DeterministicIdCrossWorkspaceError} from '@/data/api'
import {definitionSeedsFacet, typeSeedsFacet} from '@/data/facets'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {statusProp as todoStatusProp, todoType} from '@/plugins/todo/schema'

import {findLabPage, getOrCreateLabPage} from '../../src/km/page'
import {SLEEPLAB_PROPS, SLEEPLAB_TYPES} from '../../src/km/schema'

const WORKSPACE_ID = 'ws-1'
const OTHER_WORKSPACE_ID = 'other-ws'

let sharedDb: TestDb
let repo: Repo

/** Fresh `Repo` over the shared db, with the extension's own types/props
 *  registered and workspace A active — same registration `nights.test.ts`/
 *  `experiment.test.ts` use, needed here because `getOrCreateLabPage`
 *  tags `LAB_TYPE` (`addTypeInTx` rejects an unregistered type id). */
const setUp = (): Repo => {
  const {repo: created} = createTestRepo({
    db: sharedDb.db,
    user: {id: 'sleeper'},
    extensions: [
      ...SLEEPLAB_PROPS.map(prop => definitionSeedsFacet.of(prop, {source: 'test'})),
      ...SLEEPLAB_TYPES.map(type => typeSeedsFacet.of(type, {source: 'test'})),
      definitionSeedsFacet.of(todoStatusProp, {source: 'test'}),
      typeSeedsFacet.of(todoType, {source: 'test'}),
    ],
  })
  created.setActiveWorkspaceId(WORKSPACE_ID)
  return created
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = setUp()
})

describe('findLabPage — a row at the derived id belonging to another workspace', {timeout: 30_000}, () => {
  it('is null, never that other workspace\'s row — and getOrCreateLabPage refuses the same occupant', async () => {
    // The kernel page id is `derivedBlockId({namespace: LAB_NS, key:
    // workspaceId})` (`@/data/kernelPage`'s `kernelPageBlockId`) — `LAB_NS`
    // is a private constant in `page.ts`, so the only way to learn the real
    // id from this file is to create the page once and read its id back.
    const page = await getOrCreateLabPage(repo, WORKSPACE_ID)
    const id = page.id

    // Wipe the db and reseat a row at that SAME id, under a DIFFERENT
    // workspace. The id depends only on (workspace, namespace) — not on
    // anything the reset clears — so it still names the row `findLabPage`
    // will look up next.
    await resetTestDb(sharedDb.db)
    repo = setUp()
    await repo.tx(tx => tx.create({
      id, workspaceId: OTHER_WORKSPACE_ID, parentId: null, orderKey: 'a0', content: 'someone else\'s lab',
    }), {scope: ChangeScope.BlockDefault, description: 'seed a foreign occupant'})

    // `findLabPage` reads by id alone (`repo.load` is not workspace-scoped),
    // so without its own workspace check it would hand back another
    // workspace's page — the defence-in-depth its own doc comment names.
    expect(await findLabPage(repo, WORKSPACE_ID)).toBeNull()

    // `getOrCreateLabPage` hits the same foreign row through
    // `getOrCreateKernelPage`'s `refuseForeign` and throws rather than
    // repairing, adopting, or handing back the wrong workspace's block —
    // pinned here too so a relaxation there can't silently start letting a
    // caller of either function see someone else's page.
    await expect(getOrCreateLabPage(repo, WORKSPACE_ID)).rejects.toThrow(DeterministicIdCrossWorkspaceError)
  })
})
