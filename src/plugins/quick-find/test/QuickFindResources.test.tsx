// @vitest-environment happy-dom
/**
 * Quick Find's resources come from core's memoized ensures, never from a
 * promise minted per mount: `QuickFind` unmounts its resources on close, and
 * `use()` suspends on any promise it has not seen — so a per-mount promise put
 * every open behind the Suspense fallback (and React's 300ms throttle) with
 * all three blocks already resolved. Pins that an open renders the dialog on
 * the FIRST pass once the ensures have settled, on the first open and again
 * after a close.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { RepoContext } from '@/context/repo.tsx'
import { getLayoutSessionBlock, getPluginUIStateBlock, getUIStateBlock } from '@/data/stateBlocks.ts'
import type { User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'
import { QuickFind } from '../QuickFind.tsx'
import { quickFindToggle } from '../toggleStore.ts'
import { quickFindUIStateType } from '../recents.ts'

const WS = 'ws-1'
const ALICE: User = {id: 'user-alice', name: 'Alice'}

vi.mock('@/components/Login.js', () => ({
  useUser: () => ALICE,
}))

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  let txSeq = Date.now()
  repo = createTestRepo({db: sharedDb.db, user: ALICE, newId: uuidv4, newTxSeq: () => ++txSeq}).repo
  repo.setActiveWorkspaceId(WS)
  Object.defineProperty(Element.prototype, 'scrollIntoView', {configurable: true, value: () => {}})
})
afterEach(() => {
  cleanup()
  quickFindToggle.set(false)
  repo.stopSyncObserver()
})

describe('QuickFind resources', () => {
  it('renders the dialog on the first pass of every open once the ensures have settled', async () => {
    const root = await getUIStateBlock(repo, WS, ALICE, {})
    await Promise.all([
      getPluginUIStateBlock(repo, WS, ALICE, quickFindUIStateType),
      getLayoutSessionBlock(root, repo.activeLayoutSessionId),
    ])
    render(<RepoContext value={repo}><QuickFind/></RepoContext>)

    act(() => quickFindToggle.set(true))
    // Synchronous on purpose: a suspended open would show nothing here, and
    // this harness never flushes a `use()` retry, so "eventually" proves nothing.
    expect(screen.getByRole('dialog', {name: 'Quick find'})).toBeInTheDocument()

    act(() => quickFindToggle.set(false))
    expect(screen.queryByRole('dialog', {name: 'Quick find'})).not.toBeInTheDocument()

    act(() => quickFindToggle.set(true))
    expect(screen.getByRole('dialog', {name: 'Quick find'})).toBeInTheDocument()
  })
})
