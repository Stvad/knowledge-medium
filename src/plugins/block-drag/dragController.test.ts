// @vitest-environment happy-dom
/**
 * The drag session: when a bullet press becomes a drag, what the drop
 * moves, and what happens to the click that follows. The move, the
 * ui-state reads and the target geometry are stubbed — `moveBlocksTo` and
 * `resolveDropTarget` have their own tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo.js'
import type { DropContext, DropTarget } from './dropTarget.ts'

const mocks = vi.hoisted(() => ({
  moveBlocksTo: vi.fn(async (_repo: unknown, ids: readonly string[]) => ({movedIds: ids})),
  unselectMovedBlocks: vi.fn(async () => {}),
  focusBlock: vi.fn(async () => {}),
  resolveDropTarget: vi.fn(),
  activatePanelRow: vi.fn(async () => true),
  isWithinSubtreeOfAny: vi.fn(async () => false),
  selected: {current: [] as string[]},
}))

vi.mock('@/plugins/move-blocks', () => ({
  moveBlocksTo: mocks.moveBlocksTo,
  unselectMovedBlocks: mocks.unselectMovedBlocks,
  isWithinSubtreeOfAny: mocks.isWithinSubtreeOfAny,
}))
vi.mock('@/utils/panelLayoutProjection.js', () => ({activatePanelRow: mocks.activatePanelRow}))
vi.mock('@/data/stateBlocks.js', () => ({
  getUIStateBlock: vi.fn(async (_repo: unknown, _ws: unknown, _user: unknown, context: {panelId?: string}) =>
    ({id: `ui:${context.panelId ?? 'root'}`})),
  getSelectionStateSnapshot: () => ({selectedBlockIds: mocks.selected.current, anchorBlockId: null}),
}))
vi.mock('@/data/properties.js', () => ({focusBlock: mocks.focusBlock}))
vi.mock('@/utils/toast.js', () => ({showError: vi.fn()}))
vi.mock('./dropTarget.ts', async importOriginal => ({
  ...await importOriginal<typeof import('./dropTarget.ts')>(),
  resolveDropTarget: mocks.resolveDropTarget,
}))

const {
  createBlockDragController,
  DRAGGING_ROW_ATTRIBUTE,
} = await import('./dragController.ts')
const {TOUCH_HOLD_MS, TOUCH_SLOP_PX} = await import('@/extensions/continuousGestures.js')

const TARGET: DropTarget = {
  move: {parentId: 'dest', position: {kind: 'first'}},
  line: {x: 0, y: 0, width: 100},
  renderScopeId: 'panel:p2:dest',
  panelId: 'p2',
}

const repo = {isReadOnly: false, activeWorkspaceId: 'ws', user: {id: 'u'}} as unknown as Repo
let uninstall: () => void

/** A panel rendering rows `ids` in this order, each with its bullet. */
const renderRow = (parent: HTMLElement, id: string, scope: string): HTMLElement => {
  const row = document.createElement('div')
  row.setAttribute('data-block-shell', 'true')
  row.dataset.blockId = id
  row.dataset.renderScopeId = scope
  const bullet = document.createElement('a')
  bullet.setAttribute('data-block-bullet', 'true')
  if (scope.startsWith('panel:')) bullet.dataset.testBullet = id
  row.append(bullet)
  parent.append(row)
  return row
}
const renderPanel = (ids: readonly string[]) => {
  document.body.innerHTML = ''
  const session = document.createElement('div')
  session.dataset.layoutSessionId = 'session-1'
  const panel = document.createElement('div')
  panel.dataset.panelId = 'p1'
  for (const id of ids) renderRow(panel, id, 'panel:p1:root')
  session.append(panel)
  document.body.append(session)
}
const bullet = (id: string) => document.querySelector<HTMLElement>(`[data-test-bullet="${id}"]`)!

/** A pointer event as a mouse with the primary button down sends it, unless
 *  `buttons` says otherwise (a release reports none). */
const pointer = (
  type: string, target: EventTarget, x: number, y: number,
  pointerType = 'mouse', buttons = type === 'pointerup' ? 0 : 1,
) =>
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType, button: 0, buttons, clientX: x, clientY: y,
  }))

/** Animation frames, run on demand. */
let frames: FrameRequestCallback[] = []
const runFrames = () => {
  const due = frames
  frames = []
  for (const frame of due) frame(0)
}

/** Click the bullet the way the browser does after a release; true when
 *  the click reached the page (was not swallowed). */
const clickReaches = (id: string): boolean => {
  const reached = vi.fn()
  document.body.addEventListener('click', reached, {once: true})
  bullet(id).dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}))
  document.body.removeEventListener('click', reached)
  return reached.mock.calls.length > 0
}

/** Every promise chain the stubs start settles within microtasks, so one
 *  macrotask boundary is enough for a drop that was going to happen. */
const settled = () => new Promise(resolve => setTimeout(resolve, 0))

const drag = (id: string, {to = [40, 60] as const, release = true} = {}) => {
  pointer('pointerdown', bullet(id), 10, 10)
  pointer('pointermove', window, to[0], to[1])
  if (release) pointer('pointerup', window, to[0], to[1])
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.selected.current = []
  mocks.resolveDropTarget.mockReturnValue(TARGET)
  frames = []
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) => frames.push(frame))
  vi.stubGlobal('cancelAnimationFrame', () => {})
  document.elementFromPoint = () => null
  renderPanel(['a', 'b', 'c'])
  uninstall = createBlockDragController(repo).install()
})

afterEach(() => {
  uninstall()
  // A drag arms a one-shot click swallow that disarms on a timer; spend it
  // here so it can't eat the next test's click.
  document.documentElement.dispatchEvent(new MouseEvent('click'))
  vi.unstubAllGlobals()
})

describe('block drag controller', () => {
  it('a press that moves less than the threshold stays a click', async () => {
    pointer('pointerdown', bullet('a'), 10, 10)
    pointer('pointermove', window, 12, 11)
    pointer('pointerup', window, 12, 11)

    expect(clickReaches('a')).toBe(true)
    expect(mocks.resolveDropTarget).not.toHaveBeenCalled()
    expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
  })

  it('drops once, at the target under the release point, and swallows the click', async () => {
    drag('b', {to: [40, 60]})

    expect(clickReaches('b')).toBe(false)
    await vi.waitFor(() => expect(mocks.focusBlock).toHaveBeenCalled())
    const [, x, y] = mocks.resolveDropTarget.mock.calls.at(-1)!
    expect([x, y]).toEqual([40, 60])
    expect(mocks.moveBlocksTo).toHaveBeenCalledTimes(1)
    expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['b'], TARGET.move)
    // The moved block leaves the SOURCE panel's selection and takes focus
    // in the panel it landed in.
    expect(mocks.unselectMovedBlocks).toHaveBeenCalledWith(repo, {id: 'ui:p1'}, ['b'])
    expect(mocks.focusBlock).toHaveBeenCalledWith({id: 'ui:p2'}, 'b', {renderScopeId: TARGET.renderScopeId})
    // …and that panel becomes the active one, so its focus highlight and
    // keyboard routing follow the moved block.
    expect(mocks.activatePanelRow).toHaveBeenCalledWith(repo, 'session-1', 'p2')
    expect(mocks.activatePanelRow.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.focusBlock.mock.invocationCallOrder[0])
  })

  describe('a release before any hover frame ran', () => {
    // The stubbed rAF never runs, so the release is the first lookup: the
    // surface's data check hasn't answered and the selection may not have
    // resolved yet.
    beforeEach(() => {
      mocks.resolveDropTarget.mockImplementation((_hit, _x, _y, context: DropContext) =>
        context.isSurfaceAllowed('root') ? TARGET : null)
    })

    it('waits for the surface check, then drops', async () => {
      drag('b')
      await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['b'], TARGET.move))
    })

    it('still refuses a surface inside a dragged block', async () => {
      mocks.isWithinSubtreeOfAny.mockResolvedValueOnce(true)
      drag('b')
      await vi.waitFor(() => expect(mocks.isWithinSubtreeOfAny).toHaveBeenCalled())
      await settled()
      expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
    })

    it('excludes the whole selection, not just the grabbed block', async () => {
      mocks.selected.current = ['a', 'c']
      drag('a')
      await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalled())
      const [, , , context] = mocks.resolveDropTarget.mock.calls.at(-1)! as [unknown, number, number, DropContext]
      expect([...context.draggedIds].sort()).toEqual(['a', 'c'])
    })
  })

  it('dragging a selected bullet moves the whole selection, in document order', async () => {
    mocks.selected.current = ['c', 'a']
    drag('c')
    await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalled())
    expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['a', 'c'], TARGET.move)
  })

  it('orders the selection by rows, not by a block reference rendered above them', async () => {
    const ref = document.createElement('a')
    ref.dataset.blockId = 'c'
    document.querySelector('[data-panel-id]')!.prepend(ref)
    mocks.selected.current = ['a', 'c']
    drag('a')
    await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalled())
    expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['a', 'c'], TARGET.move)
  })

  it('orders the selection by the dragged outline, not by an embed of one of its blocks', async () => {
    // a embeds c, so c's first occurrence in the panel is inside a.
    renderRow(document.querySelector<HTMLElement>('[data-block-id="a"]')!, 'c', 'embed:a:occ:c:panel:p1:root')
    mocks.selected.current = ['b', 'c']
    drag('b')
    await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalled())
    expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['b', 'c'], TARGET.move)
  })

  it('dragging an unselected bullet moves just that block', async () => {
    mocks.selected.current = ['a', 'c']
    drag('b')
    await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalled())
    expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['b'], TARGET.move)
  })

  it('a mouse drag clears the text selection its press may have started', () => {
    window.getSelection()!.selectAllChildren(document.querySelector('[data-block-id="b"]')!)
    drag('a', {release: false})
    expect(window.getSelection()!.rangeCount).toBe(0)
    pointer('pointerup', window, 40, 60)
  })

  it('dims the dragged rows while the drag runs', () => {
    drag('a', {release: false})
    expect(document.querySelector(`[data-block-id="a"]`)!.hasAttribute(DRAGGING_ROW_ATTRIBUTE)).toBe(true)
    pointer('pointerup', window, 40, 60)
    expect(document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)).toHaveLength(0)
  })

  it('dims every selected row when the drag carries the selection', async () => {
    mocks.selected.current = ['a', 'c']
    drag('a', {release: false})
    await vi.waitFor(() =>
      expect(document.querySelector(`[data-block-id="c"]`)!.hasAttribute(DRAGGING_ROW_ATTRIBUTE)).toBe(true))
    expect(document.querySelector(`[data-block-id="b"]`)!.hasAttribute(DRAGGING_ROW_ATTRIBUTE)).toBe(false)
    pointer('pointerup', window, 40, 60)
  })

  it('a release with no target moves nothing', async () => {
    mocks.resolveDropTarget.mockReturnValue(null)
    drag('a')
    expect(clickReaches('a')).toBe(false)
    await settled()
    expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
  })

  it('Escape cancels: nothing moves, and the release does not click the bullet', async () => {
    drag('a', {release: false})
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}))
    expect(document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)).toHaveLength(0)
    pointer('pointerup', window, 40, 60)

    expect(clickReaches('a')).toBe(false)
    await settled()
    expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
  })

  it('Escape before the selection resolves leaves no row dimmed once it does', async () => {
    mocks.selected.current = ['a', 'c']
    drag('a', {release: false})
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true}))
    await settled()
    expect(document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)).toHaveLength(0)
    pointer('pointerup', window, 40, 60)
  })

  it('a drag whose release was lost ends at the next press, without dropping', async () => {
    drag('a', {release: false}) // let go outside the window
    pointer('pointerdown', document.body, 300, 300)
    pointer('pointerup', document.body, 300, 300)
    await settled()
    expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
    expect(document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)).toHaveLength(0)
  })

  it('refreshes the target when the page scrolls under a still pointer', () => {
    drag('a', {release: false})
    runFrames()
    mocks.resolveDropTarget.mockClear()
    document.querySelector('[data-panel-id]')!.dispatchEvent(new Event('scroll'))
    runFrames()
    expect(mocks.resolveDropTarget).toHaveBeenCalledTimes(1)
    pointer('pointerup', window, 40, 60)
  })

  it('ends, without dropping, at the first move with the button no longer down', async () => {
    drag('a', {release: false}) // let go outside the window
    pointer('pointermove', window, 50, 70, 'mouse', 0)
    expect(document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)).toHaveLength(0)
    pointer('pointerup', window, 50, 70)
    await settled()
    expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
  })

  it('losing window focus cancels the drag but still swallows its release click', async () => {
    drag('a', {release: false})
    window.dispatchEvent(new Event('blur'))
    expect(document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)).toHaveLength(0)
    pointer('pointerup', window, 40, 60)
    expect(clickReaches('a')).toBe(false)
    await settled()
    expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
  })

  it('a touch on the screen does not end a mouse drag', async () => {
    drag('a', {release: false})
    pointer('pointerdown', document.body, 300, 300, 'touch')
    pointer('pointerup', window, 40, 60)
    await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['a'], TARGET.move))
  })

  describe('touch: a hold on the bullet picks the block up', () => {
    beforeEach(() => {
      vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']})
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    const touch = (type: string, target: EventTarget, x: number, y: number) =>
      pointer(type, target, x, y, 'touch')
    const isDimmed = (id: string) =>
      document.querySelector(`[data-block-id="${id}"]`)!.hasAttribute(DRAGGING_ROW_ATTRIBUTE)
    /** Past the hold: let a release's drop, if any, run to the end. */
    const settle = () => {
      vi.useRealTimers()
      return settled()
    }
    /** Every `contextmenu` event that reaches the page. */
    const contextMenus = () => {
      const seen: MouseEvent[] = []
      document.body.addEventListener('contextmenu', event => seen.push(event))
      return seen
    }

    it('a tap stays a click that opens the block', () => {
      const menus = contextMenus()
      touch('pointerdown', bullet('a'), 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS - 100)
      touch('pointerup', window, 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)

      expect(isDimmed('a')).toBe(false)
      expect(clickReaches('a')).toBe(true)
      expect(menus).toHaveLength(0)
    })

    it('held, then moved, drags and drops at the release point', async () => {
      touch('pointerdown', bullet('b'), 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      expect(isDimmed('b')).toBe(true)
      touch('pointermove', window, 40, 60)
      touch('pointerup', window, 40, 60)

      expect(clickReaches('b')).toBe(false)
      await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['b'], TARGET.move))
      const [, x, y] = mocks.resolveDropTarget.mock.calls.at(-1)!
      expect([x, y]).toEqual([40, 60])
    })

    it('a hold on a selected bullet lifts the whole selection', async () => {
      mocks.selected.current = ['a', 'c']
      touch('pointerdown', bullet('a'), 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      await vi.waitFor(() => expect(isDimmed('c')).toBe(true))
      expect(isDimmed('b')).toBe(false)
      touch('pointerup', window, 10, 10)
    })

    it('a touch that moves before the hold is not a drag, and its click does not open the block', async () => {
      touch('pointerdown', bullet('a'), 10, 10)
      vi.advanceTimersByTime(100)
      touch('pointermove', window, 10, 10 + TOUCH_SLOP_PX + 1)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      touch('pointermove', window, 40, 60)
      expect(isDimmed('a')).toBe(false)
      touch('pointerup', window, 40, 60)

      // iOS still clicks the bullet after a short flick.
      expect(clickReaches('a')).toBe(false)
      await settle()
      expect(mocks.resolveDropTarget).not.toHaveBeenCalled()
      expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
    })

    it('keeps the page\'s text selection, so a focused editor keeps its caret', () => {
      const text = document.createElement('p')
      text.textContent = 'being edited'
      document.body.append(text)
      window.getSelection()!.selectAllChildren(text)
      touch('pointerdown', bullet('a'), 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      touch('pointermove', window, 40, 60)
      expect(window.getSelection()!.rangeCount).toBe(1)
      touch('pointerup', window, 40, 60)
    })

    it('jitter within the slop neither cancels the hold nor starts the drag', () => {
      touch('pointerdown', bullet('a'), 10, 10)
      touch('pointermove', window, 14, 16)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      expect(isDimmed('a')).toBe(true)
      touch('pointermove', window, 16, 14)
      runFrames()
      expect(mocks.resolveDropTarget).not.toHaveBeenCalled()
      touch('pointerup', window, 16, 14)
    })

    it('held and let go in place opens the context menu at the press, not the block', async () => {
      const menus = contextMenus()
      touch('pointerdown', bullet('a'), 10, 12)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      touch('pointerup', window, 13, 14)

      expect(menus).toHaveLength(1)
      expect(menus[0].target).toBe(bullet('a'))
      expect([menus[0].clientX, menus[0].clientY]).toEqual([10, 12])
      expect(isDimmed('a')).toBe(false)
      expect(clickReaches('a')).toBe(false)
      await settle()
      expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
    })

    it('a native context menu during the hold is held back for the release to decide', () => {
      const menus = contextMenus()
      touch('pointerdown', bullet('a'), 10, 10)
      const notPrevented = bullet('a').dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true}))
      expect(notPrevented).toBe(false)
      expect(menus).toHaveLength(0)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      touch('pointermove', window, 40, 60)
      touch('pointerup', window, 40, 60)
      expect(menus).toHaveLength(0)
    })

    it('losing window focus while held cancels, and swallows the release click', () => {
      const menus = contextMenus()
      touch('pointerdown', bullet('a'), 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      window.dispatchEvent(new Event('blur'))
      expect(isDimmed('a')).toBe(false)
      touch('pointerup', window, 10, 10)
      expect(clickReaches('a')).toBe(false)
      expect(menus).toHaveLength(0)
    })

    it('a fresh press recovers a hold cancelled by blur whose release never came', async () => {
      touch('pointerdown', bullet('a'), 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      window.dispatchEvent(new Event('blur')) // let go while the window was away
      bullet('b').dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 2, pointerType: 'touch', button: 0, buttons: 1,
        clientX: 10, clientY: 10,
      }))
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      expect(isDimmed('b')).toBe(true)
    })

    it('a pointercancel during the hold ends it', () => {
      touch('pointerdown', bullet('a'), 10, 10)
      touch('pointercancel', window, 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      expect(isDimmed('a')).toBe(false)
    })

    it('a second finger does not end a touch drag', async () => {
      touch('pointerdown', bullet('a'), 10, 10)
      vi.advanceTimersByTime(TOUCH_HOLD_MS)
      touch('pointermove', window, 40, 60)
      document.body.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerId: 2, pointerType: 'touch', button: 0, buttons: 1, clientX: 300, clientY: 300,
      }))
      touch('pointerup', window, 40, 60)
      await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['a'], TARGET.move))
    })
  })
})
