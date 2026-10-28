// @vitest-environment happy-dom
/**
 * The drag session: when a bullet press becomes a drag, what the drop
 * moves, and what happens to the click that follows. The move, the
 * ui-state reads and the target geometry are stubbed — `moveBlocksTo` and
 * `resolveDropTarget` have their own tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '@/data/repo.js'
import type { DropTarget } from './dropTarget.ts'

const mocks = vi.hoisted(() => ({
  moveBlocksTo: vi.fn(async (_repo: unknown, ids: readonly string[]) => ({moved: ids.length, movedIds: ids})),
  unselectMovedBlocks: vi.fn(async () => {}),
  focusBlock: vi.fn(async () => {}),
  resolveDropTarget: vi.fn(),
  selected: {current: [] as string[]},
}))

vi.mock('@/plugins/move-blocks', () => ({
  moveBlocksTo: mocks.moveBlocksTo,
  unselectMovedBlocks: mocks.unselectMovedBlocks,
  isWithinSubtreeOfAny: vi.fn(async () => false),
}))
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

const { createBlockDragController, DRAGGING_ROW_ATTRIBUTE } = await import('./dragController.ts')

const TARGET: DropTarget = {
  move: {parentId: 'dest', position: {kind: 'first'}},
  line: {x: 0, y: 0, width: 100},
  renderScopeId: 'panel:p2:dest',
  panelId: 'p2',
}

const repo = {isReadOnly: false, activeWorkspaceId: 'ws', user: {id: 'u'}} as unknown as Repo
let uninstall: () => void

/** A panel rendering rows `ids` in this order, each with its bullet. */
const renderPanel = (ids: readonly string[]) => {
  document.body.innerHTML = ''
  const panel = document.createElement('div')
  panel.dataset.panelId = 'p1'
  for (const id of ids) {
    const row = document.createElement('div')
    row.setAttribute('data-block-shell', 'true')
    row.dataset.blockId = id
    row.dataset.renderScopeId = 'panel:p1:root'
    const bullet = document.createElement('a')
    bullet.setAttribute('data-block-bullet', 'true')
    bullet.dataset.testBullet = id
    row.append(bullet)
    panel.append(row)
  }
  document.body.append(panel)
}
const bullet = (id: string) => document.querySelector<HTMLElement>(`[data-test-bullet="${id}"]`)!

const pointer = (type: string, target: EventTarget, x: number, y: number, pointerType = 'mouse') =>
  target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType, button: 0, clientX: x, clientY: y,
  }))

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
  vi.stubGlobal('requestAnimationFrame', () => 0)
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

  it('dragging an unselected bullet moves just that block', async () => {
    mocks.selected.current = ['a', 'c']
    drag('b')
    await vi.waitFor(() => expect(mocks.moveBlocksTo).toHaveBeenCalled())
    expect(mocks.moveBlocksTo).toHaveBeenCalledWith(repo, ['b'], TARGET.move)
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

  it('a drag whose release was lost ends at the next press, without dropping', async () => {
    drag('a', {release: false}) // let go outside the window
    pointer('pointerdown', document.body, 300, 300)
    pointer('pointerup', document.body, 300, 300)
    await settled()
    expect(mocks.moveBlocksTo).not.toHaveBeenCalled()
    expect(document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)).toHaveLength(0)
  })

  it('a touch press does not start a drag (v1 is mouse only)', () => {
    pointer('pointerdown', bullet('a'), 10, 10, 'touch')
    pointer('pointermove', window, 40, 60, 'touch')
    pointer('pointerup', window, 40, 60, 'touch')
    expect(mocks.resolveDropTarget).not.toHaveBeenCalled()
    expect(clickReaches('a')).toBe(true)
  })
})
