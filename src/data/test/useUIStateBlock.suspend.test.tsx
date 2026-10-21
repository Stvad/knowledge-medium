// @vitest-environment happy-dom
/**
 * Pins that the Suspense fallback NEVER mounts for a pane whose row is already
 * cached — not merely that content eventually appears (it always does, late).
 * Why a fresh promise costs a fallback plus 300ms: `src/utils/resolvedThenable.ts`.
 */
import { Suspense } from 'react'
import { render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { v4 as uuidv4 } from 'uuid'
import { RepoContext } from '@/context/repo.tsx'
import { BlockContextProvider } from '@/context/block'
import { useUIStateBlock } from '@/data/globalState.ts'
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

    // Both synchronous: the content commits inside `render`'s act. Asserting
    // "eventually shows content" instead would prove nothing — this harness
    // never flushes a Suspense retry scheduled by `use()` (verified with a
    // plain timer promise), so a suspended probe simply never resolves.
    expect(fallbackRendered).not.toHaveBeenCalled()
    expect(screen.getByTestId('ui-state')).toHaveTextContent(panelId)
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

  })
})
