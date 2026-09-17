// @vitest-environment happy-dom
/** Both ways into the Recents page — the header button and the global command —
 *  against a real repo AND the real navigation layer.
 *
 *  `ensureSystemPages` reports a failing `ensure` and carries on, so this page's
 *  row is not guaranteed to be there when a consumer wants it (issue #931).
 *  Nothing here is stubbed: a stub that materializes the page on the consumer's
 *  behalf makes these pass for a consumer that never materializes it at all. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RepoContext } from '@/context/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { recentsPageBlockId } from '@/data/recentsPage'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import { panelBlockIds } from '@/utils/panelLayoutProjection'
import { buildAppHash } from '@/utils/routing'
import type { User } from '@/data/api'
import type { Repo } from '@/data/repo'
import { RecentsHeaderItem } from './HeaderItem.tsx'
import { openRecentsAction } from './index.ts'

const WS = 'ws-recents-open'
const SWITCHED_TO_WS = 'ws-recents-switched'
const USER: User = {id: 'user-1'}
/** Measured ~250ms for the file; budgeted for the gate's ~6x p99.9 stretch. */
const TIMEOUT_MS = 20_000

let sharedDb: TestDb
let repo: Repo
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  __resetLayoutSessionIdForTesting()
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
})

afterEach(() => {
  cleanup()
  window.location.hash = ''
})

/** The Recents row as the DB holds it — `null` while the page has never been
 *  created, which is what `ensureSystemPages` leaves behind when it skips it. */
const recentsRow = (workspaceId = WS) => repo.load(recentsPageBlockId(workspaceId))

/** Which blocks the layout actually shows — the navigation's real effect, read
 *  the same way `panelLayoutProjection` does. */
const shownBlockIds = async (): Promise<readonly string[]> => {
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSession = getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)
  return panelBlockIds(await (await layoutSession).children.load())
}

const runCommand = () => openRecentsAction(repo).handler({} as never, {} as never)

describe('opening Recents when bootstrap skipped the page', () => {
  it('the header button materializes the page, then opens it', async () => {
    expect(await recentsRow()).toBeNull()

    render(<RepoContext value={repo}><RecentsHeaderItem/></RepoContext>)
    fireEvent.click(screen.getByLabelText('Open recents'))

    await vi.waitFor(async () => {
      expect(await shownBlockIds()).toContain(recentsPageBlockId(WS))
    })
    expect((await recentsRow())?.content).toBe('Recents')
  }, TIMEOUT_MS)

  it('the global command materializes the page, then opens it', async () => {
    expect(await recentsRow()).toBeNull()

    await runCommand()

    expect((await recentsRow())?.content).toBe('Recents')
    expect(await shownBlockIds()).toEqual([recentsPageBlockId(WS)])
  }, TIMEOUT_MS)

  it('writes to the pinned workspace, never to one the hash alone names', async () => {
    // Mid-switch: the hash already names the workspace being moved to while the
    // pin still names the current one. The write follows the PIN, because the
    // read-only gate it is checked against moves with the pin.
    window.location.hash = buildAppHash(SWITCHED_TO_WS)

    await runCommand()

    expect(await recentsRow(SWITCHED_TO_WS)).toBeNull()
    expect((await recentsRow())?.content).toBe('Recents')
  }, TIMEOUT_MS)
})
