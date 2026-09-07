// @vitest-environment happy-dom
/**
 * `useUIStateBlock()` inside a panel context is `use(getUIStateBlock(…))` —
 * a promise memoized PER PANE. For a pane that already has its row cached
 * (every freshly split pane, the moment the split tx resolves) the hook must
 * read synchronously: a promise `use()` has never seen suspends once even
 * when already resolved, and React 19 then holds the pane behind the Suspense
 * fallback for its 300ms reveal throttle — a visible lag on every split.
 *
 * Pins that the fallback NEVER mounts for a cached pane, not merely that the
 * content eventually appears (it always does — the delay is the bug).
 */
import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { RepoContext } from '@/context/repo.tsx'
import { BlockContextProvider } from '@/context/block'
import { useUIStateBlock } from '@/data/globalState.ts'
import { getUIStateBlock } from '@/data/stateBlocks.ts'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { Repo } from '@/data/repo'

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
})
afterEach(() => { repo.stopSyncObserver() })

const Probe = () => <div data-testid="ui-state">{useUIStateBlock().id}</div>

const renderInPanel = (panelId: string, onFallback: () => void) => render(
  <RepoContext value={repo}>
    <BlockContextProvider initialValue={{panelId}}>
      <Suspense fallback={<Fallback onMount={onFallback}/>}>
        <Probe/>
      </Suspense>
    </BlockContextProvider>
  </RepoContext>,
)

const Fallback = ({onMount}: {onMount: () => void}) => {
  onMount()
  return <div data-testid="fallback"/>
}

describe('useUIStateBlock in a panel context', () => {
  it('renders a cached pane on the first pass without ever showing the fallback', async () => {
    const panelId = await repo.tx(tx => tx.create({
      workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page-a',
    }), {scope: ChangeScope.UiState})
    expect(repo.block(panelId).peek()).toBeDefined()

    const fallbackRendered = vi.fn()
    renderInPanel(panelId, fallbackRendered)

    expect(await screen.findByTestId('ui-state')).toHaveTextContent(panelId)
    expect(fallbackRendered).not.toHaveBeenCalled()
  })

  it('shows the fallback for a pane whose row is not cached yet (the control)', async () => {
    const panelId = await repo.tx(tx => tx.create({
      workspaceId: WS, parentId: null, orderKey: 'a0', content: 'page-a',
    }), {scope: ChangeScope.UiState})
    // A second Repo over the same DB starts with an empty cache.
    let txSeq = Date.now()
    const cold = createTestRepo({db: sharedDb.db, user: ALICE, newId: uuidv4, newTxSeq: () => ++txSeq}).repo
    cold.setActiveWorkspaceId(WS)
    repo.stopSyncObserver()
    repo = cold
    expect(repo.block(panelId).peek()).toBeUndefined()

    const fallbackRendered = vi.fn()
    renderInPanel(panelId, fallbackRendered)
    expect(fallbackRendered).toHaveBeenCalled()
    expect(screen.queryByTestId('ui-state')).toBeNull()

    // The row still arrives — only through a load. (This harness never flushes
    // a Suspense retry scheduled by `use()`, verified with a plain timer
    // promise, so the resolved content cannot be asserted through the DOM
    // here; that is also why the cached case above pins "fallback never
    // mounted" rather than "content eventually shows".)
    expect(await getUIStateBlock(repo, WS, ALICE, {panelId})).toBe(repo.block(panelId))
    expect(repo.block(panelId).peek()?.content).toBe('page-a')
  })
})
