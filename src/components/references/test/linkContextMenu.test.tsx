// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { useEffect, useRef, type ReactNode } from 'react'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ReferenceLink } from '../ReferenceLink'
import { Wikilink } from '@/plugins/references/markdown/wikilinks/Wikilink'
import { continuousGestureRecognizersFacet, useContinuousGestures } from '@/extensions/continuousGestures'
import type { BlockResolveContext } from '@/extensions/blockInteraction'
import { setGestureActionDispatcher } from '@/shortcuts/gestureAction'
import { blockHoldRecognizer, BLOCK_HOLD_GESTURE } from '@/plugins/touch-selection/holdRecognizer'
import { actionContextsFacet, actionsFacet } from '@/extensions/core'
import { ActiveContextsProvider, useActiveContextsDispatch } from '@/shortcuts/ActiveContexts'
import { HotkeyReconciler } from '@/shortcuts/HotkeyReconciler'
import { ActionContextTypes, type BaseShortcutDependencies } from '@/shortcuts/types'

const {navigate, openBlock, outerPointerDown, repo} = vi.hoisted(() => ({
  navigate: vi.fn(),
  openBlock: vi.fn(),
  outerPointerDown: vi.fn(),
  repo: {activeWorkspaceId: 'active-workspace'},
}))
vi.mock('@/context/repo', () => ({useRepo: () => repo}))
vi.mock('@/hooks/block', () => ({useWorkspaceId: () => 'link-workspace'}))
vi.mock('@/utils/navigation', async importOriginal => ({
  ...await importOriginal<typeof import('@/utils/navigation')>(),
  navigate,
  useOpenBlock: () => openBlock,
}))

const runtime = resolveFacetRuntimeSync([])
const holdContext = {
  block: {id: 'holding-block'},
  uiStateBlock: {
    id: 'source-panel', repo: {isReadOnly: false},
    peek: () => ({properties: {}}), peekProperty: () => undefined,
  },
  scopeRootId: 'source-root', blockContext: {},
} as unknown as BlockResolveContext

const HoldSurface = ({children}: {children: ReactNode}) => {
  const elementRef = useRef<HTMLElement | null>(null)
  const gestureRef = useContinuousGestures(holdContext, elementRef)
  return <div className="block-content" ref={gestureRef}>{children}</div>
}

const BackgroundShortcuts = () => {
  const dispatch = useActiveContextsDispatch()
  useEffect(() => {
    const claim = dispatch.claim(ActionContextTypes.NORMAL_MODE, {} as BaseShortcutDependencies)
    return () => dispatch.release(claim)
  }, [dispatch])
  return <HotkeyReconciler/>
}

const renderLinks = (children?: ReactNode) => render(
  <AppRuntimeContextProvider value={runtime}>
    <BlockContextProvider initialValue={{panelId: 'source-panel'}}>
      <div onPointerDown={outerPointerDown}>
        <Wikilink alias="Page" blockId="page-target" workspaceId="link-workspace">Page link</Wikilink>
        <ReferenceLink block={{id: 'ref-target'} as Block}>{children ?? 'Block reference'}</ReferenceLink>
      </div>
    </BlockContextProvider>
  </AppRuntimeContextProvider>,
)

afterEach(() => {
  cleanup()
  navigate.mockClear()
  openBlock.mockClear()
  outerPointerDown.mockClear()
  setGestureActionDispatcher(null)
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('link context menus', () => {
  it.each([
    ['Page link', 'page-target'],
    ['Block reference', 'ref-target'],
  ])('opens %s in the main panel of the link workspace', async (text, blockId) => {
    renderLinks()
    fireEvent.contextMenu(screen.getByText(text))
    const menu = await screen.findByRole('menu')
    expect(within(menu).getByRole('menuitem', {name: /Open in sidebar stack/})).toBeTruthy()
    expect(within(menu).getByRole('menuitem', {name: /Open in new panel/})).toBeTruthy()
    fireEvent.click(within(menu).getByRole('menuitem', {name: /Open in main panel/}))
    expect(navigate).toHaveBeenCalledExactlyOnceWith(repo, {
      blockId, workspaceId: 'link-workspace', target: 'main', origin: 'follow-link',
    })
  })

  it.each([
    ['Open in sidebar stack', 'sidebar-stack'],
    ['Open in new panel', 'new-panel'],
  ])('anchors %s to the panel containing the link', async (label, target) => {
    renderLinks()
    fireEvent.contextMenu(screen.getByText('Page link'))
    fireEvent.click(await screen.findByRole('menuitem', {name: new RegExp(label)}))
    expect(navigate).toHaveBeenCalledExactlyOnceWith(repo, {
      blockId: 'page-target', workspaceId: 'link-workspace', target,
      sourcePanelId: 'source-panel', origin: 'follow-link',
    })
  })

  it.each([
    <a key="external" href="https://example.com">External link</a>,
    <img key="image" alt="Embedded image" src="image.png"/>,
  ])('keeps a reference descendant’s native menu', child => {
    renderLinks(child)
    const target = child.type === 'img' ? screen.getByAltText('Embedded image') : screen.getByText('External link')
    const event = createEvent.contextMenu(target, {bubbles: true, cancelable: true})
    fireEvent(target, event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('opens only the nested page link’s menu inside a reference', async () => {
    renderLinks(<Wikilink alias="Inner" blockId="inner-target" workspaceId="inner-workspace">Inner link</Wikilink>)
    fireEvent.contextMenu(screen.getByText('Inner link'))
    expect(await screen.findAllByRole('menu')).toHaveLength(1)
    const item = screen.getByRole('menuitem', {name: /Open in main panel/})
    fireEvent.pointerDown(item)
    fireEvent.click(item)
    expect(navigate).toHaveBeenCalledExactlyOnceWith(repo, {
      blockId: 'inner-target', workspaceId: 'inner-workspace', target: 'main', origin: 'follow-link',
    })
    expect(openBlock).not.toHaveBeenCalled()
    expect(outerPointerDown).not.toHaveBeenCalled()
  })

  it('leaves Shift-right-click available for the browser menu', () => {
    renderLinks()
    const link = screen.getByText('Page link')
    const event = createEvent.contextMenu(link, {bubbles: true, cancelable: true, shiftKey: true})
    fireEvent(link, event)
    expect(event.defaultPrevented).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('returns keyboard focus to the link when its menu is dismissed with Escape', async () => {
    renderLinks()
    const link = screen.getByText('Page link')
    link.focus()
    expect(document.activeElement).toBe(link)
    fireEvent.keyDown(link, {key: 'ContextMenu'})
    fireEvent.contextMenu(link)
    const menu = await screen.findByRole('menu')
    await vi.waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
    fireEvent.keyDown(document.activeElement!, {key: 'Escape'})
    await vi.waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    await vi.waitFor(() => expect(document.activeElement).toBe(link))
  })

  it('keeps focus that a navigation action moves outside the menu', async () => {
    renderLinks()
    render(<textarea aria-label="Navigation destination"/>)
    const destination = screen.getByRole('textbox', {name: 'Navigation destination'})
    const link = screen.getByText('Page link')
    link.focus()
    fireEvent.contextMenu(link)
    const menu = await screen.findByRole('menu')
    const closed = vi.fn()
    menu.addEventListener('focusScope.autoFocusOnUnmount', closed, {once: true})
    navigate.mockImplementationOnce(async () => {
      await Promise.resolve()
      destination.focus()
    })
    fireEvent.click(within(menu).getByRole('menuitem', {name: /Open in new panel/}))
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce())
    expect(document.activeElement).toBe(destination)
  })

  it.each(['keydown', 'keyup'] as const)('keeps menu %s events from background shortcuts', async phase => {
    const background = vi.fn()
    const keyboardRuntime = resolveFacetRuntimeSync([
      actionContextsFacet.of({
        type: ActionContextTypes.NORMAL_MODE,
        displayName: 'Normal mode',
        validateDependencies: (deps): deps is BaseShortcutDependencies => typeof deps === 'object' && deps !== null,
      }),
      actionsFacet.of({
        id: `background.${phase}`, context: ActionContextTypes.NORMAL_MODE,
        description: 'Background action', defaultBinding: {keys: 'ArrowDown', phase},
        handler: background,
      }),
    ])
    render(
      <AppRuntimeContextProvider value={keyboardRuntime}>
        <ActiveContextsProvider>
          <BackgroundShortcuts/>
          <Wikilink alias="Page" blockId="page-target" workspaceId="link-workspace">Keyboard link</Wikilink>
        </ActiveContextsProvider>
      </AppRuntimeContextProvider>,
    )
    const link = screen.getByText('Keyboard link')
    const press = phase === 'keydown' ? fireEvent.keyDown : fireEvent.keyUp
    press(link, {key: 'ArrowDown', code: 'ArrowDown'})
    expect(background).toHaveBeenCalledOnce()
    background.mockClear()

    fireEvent.contextMenu(link)
    const menu = await screen.findByRole('menu')
    await vi.waitFor(() => expect(menu.contains(document.activeElement)).toBe(true))
    press(document.activeElement!, {key: 'ArrowDown', code: 'ArrowDown'})
    expect(background).not.toHaveBeenCalled()
  })

  it('leaves a link hold with the existing block-hold recognizer', async () => {
    vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({matches: true}))
    vi.useFakeTimers()
    const dispatch = vi.fn(() => true)
    setGestureActionDispatcher(dispatch)
    const holdRuntime = resolveFacetRuntimeSync([
      continuousGestureRecognizersFacet.of(blockHoldRecognizer),
    ])
    render(
      <AppRuntimeContextProvider value={holdRuntime}>
        <HoldSurface>
          <Wikilink alias="Page" blockId="page-target" workspaceId="link-workspace">Held link</Wikilink>
        </HoldSurface>
      </AppRuntimeContextProvider>,
    )
    await act(async () => {
      fireEvent.pointerDown(screen.getByText('Held link'), {
        pointerType: 'touch', pointerId: 1, clientX: 10, clientY: 10,
      })
      vi.advanceTimersByTime(750)
    })
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      BLOCK_HOLD_GESTURE,
      expect.objectContaining({block: holdContext.block}),
      expect.anything(),
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
