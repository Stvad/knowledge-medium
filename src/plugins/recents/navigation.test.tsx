// @vitest-environment happy-dom
/** Both recents entry points open a page that is created on demand: the
 *  derived `recentsPageBlockId` names an id, not a row. These drive the real
 *  action and the real button against a real Repo, and assert on where the
 *  layout landed — not on which block id was requested. */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo, isBlockDeleted } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import { RepoContext } from '@/context/repo.tsx'
import { BlockContextProvider } from '@/context/block.tsx'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { allPanelRowsInLayoutOrder, panelBlockId } from '@/utils/panelLayoutProjection'
import { __resetLayoutSessionIdForTesting } from '@/utils/layoutSessionId'
import { getOrCreateRecentsPage, recentsPageBlockId } from '@/data/recentsPage.ts'
import { goTo, navigationIntentVerb, type NavigationDecision } from '@/utils/navigation.ts'
import { RecentsHeaderItem } from './HeaderItem.tsx'
import { openRecentsAction } from './index.ts'

const WS = 'ws-recents'
const USER: User = {id: 'user-1', name: 'Alice'}

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
afterEach(() => { cleanup() })

/** Where the navigator target (the main panel on desktop) points, read off the
 *  same layout projection `navigate()` writes through — so this observes where
 *  the gesture actually landed. */
const currentMainPanelBlockId = async (): Promise<string | undefined> => {
  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSession = await getLayoutSessionBlock(uiState, repo.activeLayoutSessionId)
  const rows = await repo.query.subtree({id: layoutSession.id}).load()
  const panel = allPanelRowsInLayoutOrder(layoutSession.id, rows)[0]
  return panel ? panelBlockId(panel) : undefined
}

const clickHeaderButton = () => {
  render(
    <RepoContext value={repo}>
      <BlockContextProvider initialValue={{}}>
        <RecentsHeaderItem/>
      </BlockContextProvider>
    </RepoContext>,
  )
  fireEvent.click(screen.getByRole('button', {name: 'Open recents'}))
}

/** The command, through the wiring the palette and the shortcut use. */
const openRecents = () => openRecentsAction(repo)
  .handler({uiStateBlock: {} as never}, new CustomEvent('test')) as Promise<void>

const redirectNavigationTo = (blockId: string) => {
  repo.setRuntimeContributions(navigationIntentVerb.decoratorsFacet, 'test-policy', [
    next => gesture => {
      const decision = next(gesture) as NavigationDecision
      return decision.kind === 'navigate' ? goTo({...decision.input, blockId}) : decision
    },
  ])
}

describe('the open-recents command', () => {
  it('creates the Recents page on first use rather than navigating to an id with no row', async () => {
    expect(await repo.load(recentsPageBlockId(WS))).toBeNull()

    await openRecents()

    expect(await currentMainPanelBlockId()).toBe(recentsPageBlockId(WS))
    expect(await repo.load(recentsPageBlockId(WS))).not.toBeNull()
  })

  it('restores a deleted Recents page instead of landing on the tombstone', async () => {
    const id = (await getOrCreateRecentsPage(repo, WS)).id
    await repo.tx(async tx => { await tx.delete(id) }, {scope: ChangeScope.BlockDefault})
    expect(await isBlockDeleted(repo, id)).toBe(true)

    await openRecents()

    expect(await currentMainPanelBlockId()).toBe(id)
    expect(await isBlockDeleted(repo, id)).toBe(false)
  })

  it('creates the page without touching undo history', async () => {
    // The user asked to navigate, not to create. A lone entry on the stack
    // makes their next cmd-Z delete the page they are looking at — and
    // `UndoManager.record` clears the redo branch on every push, so it would
    // also discard a redo they still wanted.
    await repo.tx(async tx => {
      await tx.create({id: 'note', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1'})
    }, {scope: ChangeScope.BlockDefault})
    await repo.tx(async tx => { await tx.update('note', {content: 'v2'}) },
      {scope: ChangeScope.BlockDefault})
    expect(await repo.undo()).toBe(true)
    expect((await repo.load('note'))?.content).toBe('v1')

    await openRecents()
    expect(await repo.load(recentsPageBlockId(WS))).not.toBeNull()

    // The redo branch survived the create, and cmd-Z still targets the edit.
    expect(await repo.redo()).toBe(true)
    expect((await repo.load('note'))?.content).toBe('v2')
    expect(await repo.undo()).toBe(true)
    expect((await repo.load('note'))?.content).toBe('v1')
    expect(await isBlockDeleted(repo, recentsPageBlockId(WS))).toBe(false)
  })

  it('lets an intent policy redirect it without creating Recents', async () => {
    // The policy decides first. A redirected command must not pay for — or be
    // blocked by — a page it is not going to open.
    redirectNavigationTo('b-policy-target')

    await openRecents()

    expect(await currentMainPanelBlockId()).toBe('b-policy-target')
    expect(await repo.load(recentsPageBlockId(WS))).toBeNull()
  })
})

describe('the recents header button', () => {
  it('creates the Recents page and navigates to it', async () => {
    clickHeaderButton()

    await vi.waitFor(async () => {
      expect(await currentMainPanelBlockId()).toBe(recentsPageBlockId(WS))
    })
    expect(await repo.load(recentsPageBlockId(WS))).not.toBeNull()
  })
})
