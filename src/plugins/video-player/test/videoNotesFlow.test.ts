// @vitest-environment node
/**
 * Write-side integration for the video-notes view mode: entering
 * rides navigateInPanel (same-block = mode-only tx, nested = navigate+mode
 * in ONE tx with a viewModeEnter-stamped history entry), and closing either
 * goes BACK (marker present — restores the pre-enter content) or clears the
 * mode in place (no marker).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, type User } from '@/data/api'
import { getLayoutSessionBlock, getUIStateBlock } from '@/data/stateBlocks'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'
import {
  focusedBlockLocationProp,
  panelMaximizedProp,
  panelViewModeProp,
  topLevelBlockIdProp,
} from '@/data/properties'
import { panelRenderScopeId } from '@/utils/renderScope'
import { insertPanelRow } from '@/utils/panelLayoutProjection'
import { panelHistory } from '@/utils/panelHistory'
import { closeVideoNotesView, enterVideoNotesView } from '../notes.ts'
import { videoPlayerActions } from '../actions.ts'
import { VIDEO_NOTES_VIEW_MODE } from '../view.ts'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
const VIDEO = 'video-1'
const PAGE = 'page-x'

let sharedDb: TestDb
let repo: Repo
let panelId: string
/** Ids of the extra panes `setup({panes})` opened alongside `panelId`. */
let siblingPanelIds: string[]

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

// `panes` is the TOTAL pane count. It matters because maximizing is refused
// when there is nothing to hide, so any test asserting on the flag has to say
// whether the pane has company.
const setup = async ({videoChildren = [] as string[], panelShows = VIDEO, panes = 1} = {}) => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: USER}).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await tx.create({
      id: VIDEO,
      workspaceId: WS,
      parentId: null,
      orderKey: 'a0',
      content: 'https://example.com/video.mp4',
    })
    await tx.create({id: PAGE, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Page X'})
    for (const [index, childId] of videoChildren.entries()) {
      await tx.create({
        id: childId,
        workspaceId: WS,
        parentId: VIDEO,
        orderKey: `b${index}`,
        content: childId,
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed video fixture'})

  const uiState = await getUIStateBlock(repo, WS, USER, {})
  const layoutSession = await getLayoutSessionBlock(uiState, 'layout-session-a')
  panelId = await insertPanelRow(repo, layoutSession, panelShows)
  siblingPanelIds = []
  for (let index = 1; index < panes; index++) {
    siblingPanelIds.push(await insertPanelRow(repo, layoutSession, `sibling-${index}`))
  }
  await repo.load(panelId)
  panelHistory.clear(panelId)
}

const panelBlock = () => repo.block(panelId)
const videoBlock = () => repo.block(VIDEO)
const isMaximized = (id: string) => repo.block(id).peekProperty(panelMaximizedProp) === true

describe('enterVideoNotesView', () => {
  beforeEach(async () => { await setup() })

  it('same-block enter: mode-only, no history entry, first note created and focused in the pane scope', async () => {
    await enterVideoNotesView(videoBlock(), panelBlock())

    expect(panelBlock().peekProperty(panelViewModeProp)).toBe(VIDEO_NOTES_VIEW_MODE)
    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO)
    expect(panelHistory.getSnapshot(panelId)).toStrictEqual({back: [], forward: []})

    const childIds = await videoBlock().childIds.load()
    expect(childIds).toHaveLength(1)
    expect(panelBlock().peekProperty(focusedBlockLocationProp)).toEqual({
      blockId: childIds[0],
      renderScopeId: panelRenderScopeId(panelId, VIDEO),
    })
  })

  it('nested enter: navigate+mode in one gesture, entry stamped viewModeEnter, existing notes untouched', async () => {
    await setup({videoChildren: ['existing-note'], panelShows: PAGE})

    await enterVideoNotesView(videoBlock(), panelBlock())

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO)
    expect(panelBlock().peekProperty(panelViewModeProp)).toBe(VIDEO_NOTES_VIEW_MODE)
    expect(panelHistory.getSnapshot(panelId).back).toEqual([
      {blockId: PAGE, viewModeEnter: VIDEO_NOTES_VIEW_MODE},
    ])
    expect(await videoBlock().childIds.load()).toEqual(['existing-note'])
  })

  it('is a no-op on a non-panel ui-state block', async () => {
    const plainUiState = await getUIStateBlock(repo, WS, USER, {})
    await enterVideoNotesView(videoBlock(), plainUiState)

    expect(plainUiState.peekProperty(topLevelBlockIdProp)).toBeUndefined()
    expect(plainUiState.peekProperty(panelViewModeProp)).toBeUndefined()
    expect(plainUiState.peekProperty(panelMaximizedProp)).not.toBe(true)
    expect(await videoBlock().childIds.load()).toEqual([])
  })

  // The immersion half of the gesture: without it, pane-scoping the notes view
  // leaves the video with only its column of a split.
  it('same-block enter maximizes the pane too', async () => {
    await setup({panes: 2})

    await enterVideoNotesView(videoBlock(), panelBlock())

    expect(isMaximized(panelId)).toBe(true)
  })

  it('nested enter maximizes in the SAME tx — one history entry, not two', async () => {
    await setup({videoChildren: ['existing-note'], panelShows: PAGE, panes: 2})

    await enterVideoNotesView(videoBlock(), panelBlock())

    expect(isMaximized(panelId)).toBe(true)
    expect(panelHistory.getSnapshot(panelId).back).toEqual([
      {blockId: PAGE, viewModeEnter: VIDEO_NOTES_VIEW_MODE},
    ])
  })

  // A lone pane renders identically maximized or not, offers no restore
  // button, and keeps the flag through an in-pane navigation away from the
  // notes view — so the flag would sit invisible until it swallowed the next
  // pane opened.
  it('declines to maximize a lone pane — nothing to hide', async () => {
    await enterVideoNotesView(videoBlock(), panelBlock())

    expect(panelBlock().peekProperty(panelViewModeProp)).toBe(VIDEO_NOTES_VIEW_MODE)
    expect(isMaximized(panelId)).toBe(false)
  })

  // Declining must be arrangement-NEUTRAL, not a clear: the flag it would drop
  // can be one the user deliberately set on a wide layout, and close can only
  // clear, never restore it.
  it('a declined enter leaves a maximize the pane already carried', async () => {
    await setup({panes: 2})
    await panelBlock().set(panelMaximizedProp, true)
    // A narrow viewport: the layout renders one pane and ignores the flag, so
    // the gesture has nothing to add and declines.
    vi.stubGlobal('window', {matchMedia: vi.fn().mockReturnValue({matches: true})})
    try {
      await enterVideoNotesView(videoBlock(), panelBlock())
    } finally {
      vi.unstubAllGlobals()
    }

    expect(panelBlock().peekProperty(panelViewModeProp)).toBe(VIDEO_NOTES_VIEW_MODE)
    expect(isMaximized(panelId)).toBe(true)
  })

  // The at-most-one rule for this writer: the flag itself is set from inside
  // navigateInPanel's tx, below the layer that can see a session's rows, so
  // the enter has to clear the others up front.
  it('clears another pane\'s stale flag rather than making a second maximized pane', async () => {
    await setup({panes: 2})
    await repo.block(siblingPanelIds[0]).set(panelMaximizedProp, true)

    await enterVideoNotesView(videoBlock(), panelBlock())

    expect(isMaximized(panelId)).toBe(true)
    expect(isMaximized(siblingPanelIds[0])).toBe(false)
  })
})

describe('closeVideoNotesView', () => {
  it('with the enter marker: goes BACK — pre-enter content restored, mode cleared', async () => {
    await setup({videoChildren: ['existing-note'], panelShows: PAGE})
    await enterVideoNotesView(videoBlock(), panelBlock())

    await closeVideoNotesView(panelBlock())

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(PAGE)
    expect(panelBlock().peekProperty(panelViewModeProp)).toBeUndefined()
    // Un-maximized in the same tx as the back: leaving the pane maximized
    // would keep every sibling pane hidden after the notes view is gone.
    expect(panelBlock().peekProperty(panelMaximizedProp)).not.toBe(true)
    expect(panelHistory.getSnapshot(panelId).forward.map(entry => entry.blockId)).toEqual([VIDEO])
  })

  it('marked, but the pre-enter page was deleted: clears the mode instead of stranding', async () => {
    // goBackInPanel prunes dead entries rather than landing on a tombstone, so
    // the marked target can disappear. Close must still get the pane out of
    // video-notes mode.
    await setup({videoChildren: ['existing-note'], panelShows: PAGE})
    await enterVideoNotesView(videoBlock(), panelBlock())
    await repo.block(PAGE).delete()

    await closeVideoNotesView(panelBlock())

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO)
    expect(panelBlock().peekProperty(panelViewModeProp)).toBeUndefined()
  })

  it('marked target deleted with older history below: clears instead of jumping past it', async () => {
    // goBackInPanel would prune the dead marked entry and happily land on the
    // older page — but that's not "close the notes view", it's a surprise jump
    // to something unrelated.
    await setup({videoChildren: ['existing-note'], panelShows: PAGE})
    panelHistory.push(panelId, {blockId: 'older-page'})
    await enterVideoNotesView(videoBlock(), panelBlock())
    await repo.block(PAGE).delete()

    await closeVideoNotesView(panelBlock())

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO)
    expect(panelBlock().peekProperty(panelViewModeProp)).toBeUndefined()
  })

  it('without the marker: clear-only, the video stays', async () => {
    await setup({videoChildren: ['existing-note']})
    await enterVideoNotesView(videoBlock(), panelBlock()) // same-block: no entry

    await closeVideoNotesView(panelBlock())

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO)
    expect(panelBlock().peekProperty(panelViewModeProp)).toBeUndefined()
    expect(panelBlock().peekProperty(panelMaximizedProp)).not.toBe(true)
    expect(panelHistory.getSnapshot(panelId)).toStrictEqual({back: [], forward: []})
  })

  it('a DIFFERENT view mode marker does not trigger back-navigation (marker value, not presence)', async () => {
    await setup({videoChildren: ['existing-note']})
    panelHistory.push(panelId, {blockId: PAGE, viewModeEnter: 'other-mode'})
    await enterVideoNotesView(videoBlock(), panelBlock()) // same-block: mode-only

    await closeVideoNotesView(panelBlock())

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO) // stayed
    expect(panelBlock().peekProperty(panelViewModeProp)).toBeUndefined()
    expect(panelHistory.getSnapshot(panelId).back.map(entry => entry.blockId)).toEqual([PAGE])
  })

  it('a concurrent double-close steps back exactly once', async () => {
    await setup({videoChildren: ['existing-note'], panelShows: PAGE})
    panelHistory.push(panelId, {blockId: 'earlier-page'}) // deeper history: a double goBack would land here
    await enterVideoNotesView(videoBlock(), panelBlock())

    await Promise.all([
      closeVideoNotesView(panelBlock()),
      closeVideoNotesView(panelBlock()),
    ])

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(PAGE) // one step, not two
    expect(panelHistory.getSnapshot(panelId).back.map(entry => entry.blockId)).toEqual(['earlier-page'])
  })

  it('an unrelated back entry does not trigger back-navigation on close', async () => {
    await setup({videoChildren: ['existing-note']})
    panelHistory.push(panelId, {blockId: PAGE}) // plain navigation entry, no marker
    await enterVideoNotesView(videoBlock(), panelBlock()) // same-block: mode-only

    await closeVideoNotesView(panelBlock())

    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO) // stayed
    expect(panelBlock().peekProperty(panelViewModeProp)).toBeUndefined()
    expect(panelHistory.getSnapshot(panelId).back.map(entry => entry.blockId)).toEqual([PAGE])
  })
})

describe('video.toggle_notes_view action', () => {
  it('toggles the pane mode on and off through the panel block', async () => {
    await setup({videoChildren: ['existing-note']})
    const action = videoPlayerActions.find(candidate => candidate.id === 'video.toggle_notes_view')
    if (!action) throw new Error('missing toggle action')
    const deps = {
      uiStateBlock: panelBlock(),
      block: videoBlock(),
      videoBlock: videoBlock(),
    }
    const trigger = new CustomEvent('test')

    await action.handler(deps, trigger)
    expect(panelBlock().peekProperty(panelViewModeProp)).toBe(VIDEO_NOTES_VIEW_MODE)

    await action.handler(deps, trigger)
    expect(panelBlock().peekProperty(panelViewModeProp)).toBeUndefined()
    expect(panelBlock().peekProperty(topLevelBlockIdProp)).toBe(VIDEO)
  })
})
