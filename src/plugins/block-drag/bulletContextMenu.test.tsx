// @vitest-environment happy-dom
/**
 * A touch hold against the bullet's real context menu (Radix), which arms
 * a touch long-press of its own: the drag takes the press from it, and
 * opens it when a hold is let go in place.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo.js'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuPortal,
  ContextMenuTrigger,
} from '@/components/ui/context-menu.js'
import { createBlockDragController } from './dragController.ts'

/** Longer than the menu's own touch long-press (700ms). */
const LONG_HOLD_MS = 1_000

const repo = {isReadOnly: false, activeWorkspaceId: 'ws', user: {id: 'u'}} as unknown as Repo

const renderBullet = () => render(
  <div data-block-shell="true" data-block-id="a" data-render-scope-id="panel:p1:root">
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <a href="#a" data-block-bullet="true" data-testid="bullet">•</a>
      </ContextMenuTrigger>
      <ContextMenuPortal>
        <ContextMenuContent>
          <ContextMenuItem>Copy ID</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuPortal>
    </ContextMenu>
  </div>,
)

const touch = (type: string, target: EventTarget) => act(() => {
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', button: 0,
    buttons: type === 'pointerup' ? 0 : 1, clientX: 10, clientY: 10,
  }))
})
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))
const menuIsOpen = () => screen.queryByText('Copy ID') !== null

beforeEach(() => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('the bullet context menu under a touch hold', () => {
  it('without the drag, its own long-press opens it', () => {
    renderBullet()
    touch('pointerdown', screen.getByTestId('bullet'))
    wait(LONG_HOLD_MS)
    expect(menuIsOpen()).toBe(true)
  })

  describe('with the drag installed', () => {
    let uninstall: () => void
    beforeEach(() => {
      uninstall = createBlockDragController(repo).install()
    })
    afterEach(() => uninstall())

    it('a hold opens nothing until it is let go, then opens the menu', () => {
      renderBullet()
      touch('pointerdown', screen.getByTestId('bullet'))
      wait(LONG_HOLD_MS)
      expect(menuIsOpen()).toBe(false)
      touch('pointerup', window)
      expect(menuIsOpen()).toBe(true)
    })
  })
})
