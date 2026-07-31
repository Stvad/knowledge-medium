// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ChangeScope, type User } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { makeBlockData } from '@/data/test/factories.js'
import { BlockContextProvider, useBlockContext } from '@/context/block'
import type { BlockLayoutSlots } from '@/extensions/blockInteraction.js'
import type { BlockRendererProps } from '@/types'

const repoRef = vi.hoisted(() => ({current: undefined as Repo | undefined}))
const uiStateBlockRef = vi.hoisted(() => ({current: undefined as Block | undefined}))
const registerSpy = vi.hoisted(() => vi.fn(() => () => {}))

// Captures the latest props the content renderer passed to ReactPlayer so
// tests can both inspect the controlled `playing` prop and fire the
// onPlay/onPause handlers (the mock renders no real <video>, so native media
// events can't be dispatched — invoking the handler props is the seam).
const playerPropsRef = vi.hoisted(() => ({current: null as Record<string, unknown> | null}))

vi.mock('react-player', () => {
  const MockPlayer = (props: Record<string, unknown>) => {
    // eslint-disable-next-line react-hooks/immutability -- test-only mock: exposing render props to assertions, not component state
    playerPropsRef.current = props
    return <div data-testid="react-player"/>
  }
  MockPlayer.canPlay = (url: string) => url.endsWith('.mp4')
  return {default: MockPlayer}
})

vi.mock('../registry.ts', async () => {
  const actual = await vi.importActual<typeof import('../registry.ts')>('../registry.ts')
  return {...actual, registerVideoPlayer: registerSpy}
})

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => {
    if (!repoRef.current) throw new Error('test repo not initialised')
    return repoRef.current
  },
}))

vi.mock('@/data/globalState.ts', async () => {
  const actual = await vi.importActual<typeof import('@/data/globalState.js')>('@/data/globalState.ts')
  return {
    ...actual,
    useUIStateBlock: () => {
      if (!uiStateBlockRef.current) throw new Error('test UI state block not initialised')
      return uiStateBlockRef.current
    },
  }
})

import { VideoNotesLayout, VideoNotesRenderer, videoNotesLayoutContribution } from '../VideoNotesRenderer.tsx'
import { VideoPlayerContentRenderer, VideoPlayerRenderer } from '../VideoPlayerRenderer.tsx'
import { VIDEO_NOTES_VIEW_MODE } from '../view.ts'
import { editorFocusRequestProp, focusedBlockLocationProp, panelViewModeProp, topLevelBlockIdProp } from '@/data/properties'
import { panelRenderScopeId } from '@/utils/renderScope'

const WS = 'ws-1'
const USER: User = {id: 'user-1', name: 'Alice'}
const VIDEO = 'video-1'
const PANEL = 'panel-1'
const PANE_SCOPE = panelRenderScopeId(PANEL, VIDEO)

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

const setup = async ({videoChildren = [] as string[]} = {}) => {
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
    await tx.create({
      id: PANEL,
      workspaceId: WS,
      parentId: null,
      orderKey: 'z0',
      content: VIDEO,
      properties: {
        [topLevelBlockIdProp.name]: topLevelBlockIdProp.codec.encode(VIDEO),
        [panelViewModeProp.name]: panelViewModeProp.codec.encode(VIDEO_NOTES_VIEW_MODE),
      },
    })
    for (const [index, childId] of videoChildren.entries()) {
      await tx.create({
        id: childId,
        workspaceId: WS,
        parentId: VIDEO,
        orderKey: `b${index}`,
        content: childId,
      })
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed video notes fixture'})
  await repo.load(VIDEO)
  await repo.load(PANEL)
  repoRef.current = repo
  uiStateBlockRef.current = repo.block(PANEL)
}

afterEach(() => {
  cleanup()
  registerSpy.mockClear()
  playerPropsRef.current = null
  repoRef.current = undefined
  uiStateBlockRef.current = undefined
})

beforeEach(async () => { await setup() })

const ChildrenProbe = () => {
  const context = useBlockContext()
  return (
    <div
      data-testid="children-slot"
      data-view-mode={typeof context.panelViewMode === 'string' ? context.panelViewMode : ''}
      data-scope={typeof context.renderScopeId === 'string' ? context.renderScopeId : ''}
    />
  )
}

const renderLayout = (contextOverrides: object = {}) => {
  const slots = {
    block: repo.block(VIDEO),
    Children: ChildrenProbe,
    Shell: ({children}: {children: (props?: object) => React.ReactNode}) => <>{children()}</>,
  } as unknown as BlockLayoutSlots
  return render(
    <BlockContextProvider
      initialValue={{
        panelId: PANEL,
        panelViewMode: VIDEO_NOTES_VIEW_MODE,
        renderScopeId: PANE_SCOPE,
        scopeRootId: VIDEO,
        videoPlayerBlockId: VIDEO,
        ...contextOverrides,
      }}
    >
      <VideoNotesLayout {...slots}/>
    </BlockContextProvider>,
  )
}

describe('VideoNotesRenderer.canRender', () => {
  const playable = {
    id: VIDEO,
    peek: () => makeBlockData({id: VIDEO, workspaceId: WS, content: 'https://example.com/video.mp4'}),
  } as unknown as Block
  const nonVideo = {
    id: 'text-1',
    peek: () => makeBlockData({id: 'text-1', workspaceId: WS, content: 'just text'}),
  } as unknown as Block

  const paneTopContext = {panelViewMode: VIDEO_NOTES_VIEW_MODE, scopeRootId: VIDEO}

  it('selects for a playable pane top-level in video-notes mode, above videoPlayer', () => {
    const props = {block: playable, context: paneTopContext} as BlockRendererProps
    expect(VideoNotesRenderer.canRender?.(props)).toBe(true)
    expect((VideoNotesRenderer.priority?.(props) ?? 0) > (VideoPlayerRenderer.priority?.(props) ?? 0)).toBe(true)
  })

  it('does not select for a non-video block even in mode', () => {
    expect(VideoNotesRenderer.canRender?.({
      block: nonVideo,
      context: paneTopContext,
    } as BlockRendererProps)).toBe(false)
  })

  it('does not select without the mode (videoPlayer keeps winning)', () => {
    expect(VideoNotesRenderer.canRender?.({block: playable, context: {scopeRootId: VIDEO}} as BlockRendererProps)).toBe(false)
    expect(VideoPlayerRenderer.canRender?.({block: playable} as BlockRendererProps)).toBe(true)
  })

  it('does not let a NESTED playable block claim the mode (non-video top-level pane)', () => {
    // scopeRootId still points at the pane's (non-video) top-level.
    expect(VideoNotesRenderer.canRender?.({
      block: playable,
      context: {panelViewMode: VIDEO_NOTES_VIEW_MODE, scopeRootId: 'page-top'},
    } as BlockRendererProps)).toBe(false)
  })

  it('does not let an EMBED of the video claim the mode (scope root re-pointed + nested surface)', () => {
    expect(VideoNotesRenderer.canRender?.({
      block: playable,
      context: {panelViewMode: VIDEO_NOTES_VIEW_MODE, scopeRootId: VIDEO, isNestedSurface: true},
    } as BlockRendererProps)).toBe(false)
  })

  it('the layout gate applies the same top-level guard', () => {
    const base = {
      block: playable,
      blockContext: {
        panelViewMode: VIDEO_NOTES_VIEW_MODE,
        videoPlayerBlockId: VIDEO,
        scopeRootId: VIDEO,
      },
    } as unknown as Parameters<typeof videoNotesLayoutContribution>[0]
    expect(videoNotesLayoutContribution(base)).not.toBeNull()
    expect(videoNotesLayoutContribution({
      ...base,
      blockContext: {...base.blockContext, scopeRootId: 'page-top'},
    })).toBeNull()
    expect(videoNotesLayoutContribution({
      ...base,
      blockContext: {...base.blockContext, isNestedSurface: true},
    })).toBeNull()
  })
})

describe('VideoNotesLayout', () => {
  it('renders the split with the video region registered under the pane scope', async () => {
    await setup({videoChildren: ['note-1']})
    renderLayout()

    expect(screen.getByTestId('react-player')).toBeTruthy()
    expect(screen.getByTestId('children-slot')).toBeTruthy()
    expect(screen.getAllByTitle('Resize video notes panes').length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Close video notes view')).toBeTruthy()
    // The shared content renderer registered its player handle under the
    // SAME scope the shortcut activations will pass (deps.renderScopeId).
    expect(registerSpy).toHaveBeenCalledWith(VIDEO, PANE_SCOPE, expect.anything())
  })

  it('clears panelViewMode around the notes region so nested blocks cannot re-claim the mode', async () => {
    await setup({videoChildren: ['note-1']})
    renderLayout()

    const probe = screen.getByTestId('children-slot')
    expect(probe.getAttribute('data-view-mode')).toBe('') // cleared
    expect(probe.getAttribute('data-scope')).toBe(PANE_SCOPE) // scope still flows
  })

  it('zero children: renders the empty-state affordance; render alone creates nothing', async () => {
    renderLayout()

    const affordance = await screen.findByRole('button', {name: /add a note/i})
    expect(await videoBlockChildCount()).toBe(0) // the render path never writes
    expect(affordance).toBeTruthy()

    fireEvent.click(affordance)
    await vi.waitFor(async () => {
      expect(await videoBlockChildCount()).toBe(1)
    })
    // The click fire-and-forgets the full focus chain onto the panel:
    // focusBlock (focusedBlockLocationProp) → editorSelection →
    // requestEditorFocus (editorFocusRequestProp). We must fence on the LAST
    // write, not the first: focusedBlockLocationProp lands well before the
    // trailing two, and requestEditorFocus is an un-awaited `void set` that is
    // pending even after the chain's own promise resolves. Returning while any
    // of these is in-flight leaks a panel write past teardown — the next test's
    // resetTestDb wipes panel-1, the write lands on the missing block, and the
    // unhandled BlockNotFoundError { id: 'panel-1' } fails the run (flaky,
    // misattributed to whichever test is mid-flight). editorFocusRequestProp is
    // the chain's tail, so once it's visible every panel write has committed.
    await vi.waitFor(async () => {
      const childIds = await repo.block(VIDEO).childIds.load()
      const panel = repo.block(PANEL)
      expect(panel.peekProperty(focusedBlockLocationProp)?.blockId).toBe(childIds[0])
      expect(panel.peekProperty(editorFocusRequestProp)).toBeGreaterThanOrEqual(1)
    })
  })

  it('fills the pane absolutely in a full panel, but sizes itself in a stacked panel', async () => {
    await setup({videoChildren: ['note-1']})
    const full = renderLayout()
    const fullRoot = full.getByTestId('video-notes-root')
    expect(fullRoot.className).toContain('absolute')
    expect(fullRoot.className).toContain('inset-0')
    full.unmount()

    const stacked = renderLayout({stackedPanel: true})
    const stackedRoot = stacked.getByTestId('video-notes-root')
    expect(stackedRoot.className).not.toContain('absolute')
    expect(stackedRoot.className).toContain('relative')
    expect(stackedRoot.className).toContain('h-[70dvh]') // definite height for container-type:size
  })

  it('the split responds to the CONTAINER, not the viewport (@md variants)', async () => {
    await setup({videoChildren: ['note-1']})
    renderLayout()
    const separators = screen.getAllByTitle('Resize video notes panes')
    expect(separators).toHaveLength(2)
    for (const separator of separators) {
      expect(separator.className).toContain('@md:')
      // no viewport-width variant left on the split chrome
      expect(` ${separator.className} `).not.toMatch(/ md:/)
    }
  })

  it('with children: no empty-state affordance', async () => {
    await setup({videoChildren: ['note-1']})
    const {container} = renderLayout()
    await vi.waitFor(() => {
      expect(container.querySelector('[data-children-loaded="true"]')).toBeTruthy()
    })
    expect(screen.queryByRole('button', {name: /add a note/i})).toBeNull()
  })
})

const videoBlockChildCount = async () => (await repo.block(VIDEO).childIds.load()).length

describe('enter affordance gating', () => {
  const renderContent = () => render(
    <BlockContextProvider initialValue={{renderScopeId: 'outline:video-1', scopeRootId: VIDEO}}>
      <VideoPlayerContentRenderer block={repo.block(VIDEO)}/>
    </BlockContextProvider>,
  )

  it('shows the enter button when the ui-state block is a panel row', () => {
    renderContent()
    expect(screen.getByLabelText('Open video notes view')).toBeTruthy()
  })

  it('hides the enter button on non-panel surfaces where entering would silently no-op', async () => {
    await repo.tx(async tx => {
      await tx.create({id: 'root-ui', workspaceId: WS, parentId: null, orderKey: 'z9', content: 'ui'})
    }, {scope: ChangeScope.UiState, description: 'seed non-panel ui state'})
    await repo.load('root-ui')
    uiStateBlockRef.current = repo.block('root-ui') // no topLevelBlockIdProp

    renderContent()
    expect(screen.queryByLabelText('Open video notes view')).toBeNull()
  })
})

describe('playing-state sync with native playback', () => {
  const renderContent = () => render(
    <BlockContextProvider initialValue={{renderScopeId: 'outline:video-1', scopeRootId: VIDEO}}>
      <VideoPlayerContentRenderer block={repo.block(VIDEO)}/>
    </BlockContextProvider>,
  )

  it('mirrors onPlay/onPause into the controlled playing prop', () => {
    renderContent()
    // Controlled prop starts false; a native-controls play must flip it so
    // react-player's enforcement effect stays a no-op on later re-renders
    // (previously playing stayed false and any re-render would pause).
    expect(playerPropsRef.current?.playing).toBe(false)

    act(() => { (playerPropsRef.current?.onPlay as () => void)() })
    expect(playerPropsRef.current?.playing).toBe(true)

    act(() => { (playerPropsRef.current?.onPause as () => void)() })
    expect(playerPropsRef.current?.playing).toBe(false)
  })
})
