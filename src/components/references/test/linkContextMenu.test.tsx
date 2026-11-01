// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { Block } from '@/data/block'
import { BlockContextProvider } from '@/context/block'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import { ReferenceLink } from '../ReferenceLink'
import { Wikilink } from '@/plugins/references/markdown/wikilinks/Wikilink'

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

  it('opens on a touch long-press on link text but leaves reference media alone', async () => {
    renderLinks(<img alt="Embedded image" src="image.png"/>)
    vi.useFakeTimers()
    await act(async () => {
      fireEvent.pointerDown(screen.getByText('Page link'), {pointerType: 'touch'})
      vi.advanceTimersByTime(750)
    })
    expect(screen.getByRole('menu')).toBeTruthy()
    fireEvent.keyDown(screen.getByRole('menu'), {key: 'Escape'})
    expect(screen.queryByRole('menu')).toBeNull()

    await act(async () => {
      fireEvent.pointerDown(screen.getByAltText('Embedded image'), {pointerType: 'touch'})
      vi.advanceTimersByTime(750)
    })
    expect(screen.queryByRole('menu')).toBeNull()
  })
})
