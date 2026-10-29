/**
 * One app-level drag-and-drop session at a time, started from a block's
 * bullet. Listens at the document, so rows carry no drag props and never
 * re-render while a drag is in flight: hover state lives in this
 * controller's store, read by the single overlay (`BlockDragLayer`), and
 * the dragged rows are dimmed through a DOM attribute.
 *
 * Not built on `continuousGestures.ts`: that loop attaches to a block's
 * CONTENT surface (the bullet sits outside it, in the controls column) and
 * classifies per-block gestures that commit as named actions, while a drag
 * spans rows and panels, tracks a live target and auto-scrolls. So the
 * content surface's swipe and date scrub never see a press on the bullet.
 *
 * Only the start differs by pointer. A mouse press becomes a drag once it
 * moves past a threshold. A touch (or pen) press must first rest on the
 * bullet for a hold; moving before it is not a drag, and the bullet's
 * `touch-action: none` (`BlockDragLayer`) keeps it from scrolling the page
 * either way. A held press that moves drags; one let go in place opens
 * the bullet's context menu, the touch long-press this takes over.
 */
import type { Repo } from '@/data/repo.js'
import type { Block } from '@/data/block'
import { BLOCK_BULLET_ATTRIBUTE } from '@/extensions/blockInteraction.js'
import { suppressNextClick } from '@/extensions/continuousGestures.js'
import { focusBlock } from '@/data/properties.js'
import { getSelectionStateSnapshot, getUIStateBlock } from '@/data/stateBlocks.js'
import { activeLayoutSessionElement } from '@/utils/layoutSessionDom.js'
import { activatePanelRow } from '@/utils/panelLayoutProjection.js'
import { showError } from '@/utils/toast.js'
import { CallbackSet } from '@/utils/callbackSet.js'
import { isWithinSubtreeOfAny, moveBlocksTo, unselectMovedBlocks } from '@/plugins/move-blocks'
import { PANEL_SELECTOR, resolveDropTarget, ROW_SELECTOR, type DropLine, type DropTarget } from './dropTarget.ts'

/** Movement before a mouse press on the bullet becomes a drag; below it
 *  the press stays a click that opens the block. */
const DRAG_THRESHOLD_PX = 4
/** How long a touch must rest on the bullet to pick its block up, and how
 *  far it may wander meanwhile (and after, before the drag starts):
 *  UIKit's long-press defaults. */
export const TOUCH_HOLD_MS = 500
export const TOUCH_SLOP_PX = 10
/** Distance from a scroll container's top/bottom edge where auto-scroll
 *  starts, and its speed at the very edge. */
const AUTO_SCROLL_EDGE_PX = 48
const AUTO_SCROLL_MAX_PX_PER_FRAME = 18

/** Set on every rendered row of a dragged block while the drag runs. */
export const DRAGGING_ROW_ATTRIBUTE = 'data-block-dragging'
/** Set on `<html>` while a drag runs (cursor, no text selection). */
export const DRAG_ACTIVE_ATTRIBUTE = 'data-block-drag-active'

export interface BlockDragSnapshot {
  readonly active: boolean
  readonly line: DropLine | null
}

const IDLE: BlockDragSnapshot = {active: false, line: null}

interface Payload {
  /** Roots to move, in document order (descendants pruned by the move). */
  readonly ids: readonly string[]
  /** The ui-state block the drag's selection lives on. */
  readonly uiStateBlock: Block
}

interface Session {
  readonly pointerId: number
  /** Touch or pen: the press starts with a hold, not a threshold. */
  readonly touch: boolean
  readonly bullet: Element
  readonly startX: number
  readonly startY: number
  readonly payload: Promise<Payload>
  /** `held`: a touch rested through the hold and the block is lifted, but
   *  it hasn't moved yet. */
  phase: 'pending' | 'held' | 'dragging' | 'cancelled'
  holdTimer: number | null
  x: number
  y: number
  /** The bullet's own block until the payload resolves. */
  draggedIds: Set<string>
  frame: number | null
  /** The container the last frame auto-scrolled, kept while the pointer
   *  overshoots its edge (onto a header, out of the window). */
  scroller: HTMLElement | null
  /** Data-ancestry checks per surface root — see `surfaceCheck`. */
  readonly surfaceChecks: Map<string, SurfaceCheck>
}

interface SurfaceCheck {
  readonly ready: Promise<boolean>
  /** Set once `ready` settles. */
  allowed?: boolean
}

export interface BlockDragController {
  install(): () => void
  subscribe(listener: () => void): () => void
  getSnapshot(): BlockDragSnapshot
}

export const createBlockDragController = (repo: Repo): BlockDragController => {
  let snapshot = IDLE
  const listeners = new CallbackSet('block-drag')
  const publish = (next: BlockDragSnapshot) => {
    if (next.active === snapshot.active && sameLine(next.line, snapshot.line)) return
    snapshot = next
    listeners.notify()
  }

  let session: Session | null = null

  const onPointerDown = (event: PointerEvent) => {
    const touch = event.pointerType !== 'mouse'
    // A second finger leaves the running session alone.
    if (touch && session) return
    // A mouse drag whose release never reached us (let go outside the
    // window) ends here; left live, the next click anywhere would drop it.
    end()
    if (event.button !== 0) return
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return
    if (repo.isReadOnly) return
    const bullet = (event.target as Element | null)?.closest?.(`[${BLOCK_BULLET_ATTRIBUTE}]`)
    const row = bullet?.closest<HTMLElement>(ROW_SELECTOR)
    const blockId = row?.dataset.blockId
    if (!bullet || !row || !blockId) return

    const payload = resolvePayload(repo, blockId, row)
    // Read only once the press becomes a drag; a click must not surface
    // its rejection as unhandled.
    payload.catch(() => {})
    const current: Session = {
      pointerId: event.pointerId,
      touch,
      bullet,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      payload,
      phase: 'pending',
      holdTimer: null,
      draggedIds: new Set([blockId]),
      frame: null,
      scroller: null,
      surfaceChecks: new Map(),
    }
    session = current
    if (touch) {
      current.holdTimer = window.setTimeout(() => onHold(current), TOUCH_HOLD_MS)
      // The bullet's context menu arms a touch long-press of its own,
      // which it skips for a prevented press; the release opens it instead.
      event.preventDefault()
      window.addEventListener('contextmenu', onContextMenu, true)
    }
    window.addEventListener('pointermove', onPointerMove, true)
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerCancel, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onWindowBlur)
    // Scroll events don't bubble; capture sees every container's.
    document.addEventListener('scroll', onScroll, {capture: true, passive: true})
  }

  /** Runs only for a live, still-pending press: `end` clears the timer, and
   *  a touch that moves before it fires ends the session. */
  const onHold = (current: Session) => {
    current.phase = 'held'
    lift(current)
  }

  const onPointerMove = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return
    // The button came up where we couldn't see it.
    if ((event.buttons & 1) === 0) {
      end()
      return
    }
    session.x = event.clientX
    session.y = event.clientY
    const distance = Math.hypot(session.x - session.startX, session.y - session.startY)
    if (session.phase === 'pending') {
      if (distance < (session.touch ? TOUCH_SLOP_PX : DRAG_THRESHOLD_PX)) return
      // A touch that moves before the hold is a swipe, not a drag.
      if (session.touch) {
        end()
        return
      }
      begin(session)
    } else if (session.phase === 'held') {
      if (distance < TOUCH_SLOP_PX) return
      begin(session)
    }
    if (session.phase === 'dragging') scheduleFrame(session)
  }

  const begin = (current: Session) => {
    const lifted = current.phase === 'held'
    current.phase = 'dragging'
    if (!lifted) lift(current)
  }

  /** Dim the dragged rows — the bullet's block at once, the whole
   *  selection once it resolves. */
  const lift = (current: Session) => {
    window.getSelection()?.removeAllRanges()
    document.documentElement.setAttribute(DRAG_ACTIVE_ATTRIBUTE, '')
    markDragged(current.draggedIds)
    publish({active: true, line: null})
    void current.payload.then(payload => {
      if (session !== current || current.phase === 'cancelled') return
      current.draggedIds = new Set(payload.ids)
      markDragged(current.draggedIds)
      scheduleFrame(current)
    }, () => {})
  }

  const scheduleFrame = (current: Session) => {
    if (current.frame !== null) return
    current.frame = requestAnimationFrame(() => {
      current.frame = null
      if (session !== current || current.phase !== 'dragging') return
      const scrolled = autoScroll(current)
      publish({active: true, line: targetAt(current)?.line ?? null})
      // Keep ticking while the edge auto-scroll runs: the pointer is still,
      // but the rows under it keep moving.
      if (scrolled) scheduleFrame(current)
    })
  }

  /** A hover frame's target: a surface whose check hasn't answered yet
   *  takes no drop, and the answer schedules another frame. */
  const targetAt = (current: Session): DropTarget | null =>
    resolveAt(current, rootId => surfaceCheck(current, rootId).allowed ?? false)

  const resolveAt = (current: Session, isSurfaceAllowed: (rootId: string) => boolean) =>
    resolveDropTarget(
      document.elementFromPoint(current.x, current.y),
      current.x,
      current.y,
      {draggedIds: current.draggedIds, isSurfaceAllowed},
    )

  /** The DOM check in `resolveDropTarget` sees only rows rendered inside a
   *  dragged row. A panel zoomed into a descendant of a dragged block
   *  renders none of them, so its root is checked against the data, once
   *  per drag. */
  const surfaceCheck = (current: Session, rootId: string): SurfaceCheck => {
    const known = current.surfaceChecks.get(rootId)
    if (known) return known
    const check: SurfaceCheck = {
      ready: current.payload
        .then(payload => isWithinSubtreeOfAny(repo, rootId, new Set(payload.ids)))
        .then(inside => !inside, () => false),
    }
    current.surfaceChecks.set(rootId, check)
    void check.ready.then(allowed => {
      check.allowed = allowed
      if (allowed) scheduleFrame(current)
    })
    return check
  }

  /** The target under the release point, once everything it depends on
   *  has resolved — a quick drag can end before the selection or the
   *  surface check has answered, and before any hover frame ran. */
  const releaseTarget = async (current: Session): Promise<DropTarget | null> => {
    const payload = await current.payload
    current.draggedIds = new Set(payload.ids)
    const pending: SurfaceCheck[] = []
    const target = resolveAt(current, rootId => {
      const check = surfaceCheck(current, rootId)
      if (check.allowed === undefined) pending.push(check)
      return check.allowed ?? false
    })
    if (target || pending.length === 0) return target
    // `allowed` is set by the check's own first reaction, so it is known here.
    await Promise.all(pending.map(check => check.ready))
    return targetAt(current)
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!session || event.pointerId !== session.pointerId) return
    const ended = session
    // A press that never lifted the block is a click: let it open the block.
    if (ended.phase !== 'pending') suppressNextClick(document.documentElement)
    const {phase} = ended
    ended.x = event.clientX
    ended.y = event.clientY
    end()
    if (phase === 'dragging') void drop(repo, ended, releaseTarget(ended))
    // After `end`, so `onContextMenu` no longer holds it back.
    else if (phase === 'held') openContextMenu(ended)
  }

  /** A native long-press menu (Android fires one mid-hold) would open over
   *  the lifted block: the release decides instead. */
  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const onPointerCancel = (event: PointerEvent) => {
    if (session && event.pointerId === session.pointerId) end()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (!session || session.phase !== 'dragging' || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    cancel(session)
  }

  /** The rows moved under a still pointer (a wheel scroll): refresh the
   *  line, which the release would otherwise contradict. */
  const onScroll = () => {
    if (session?.phase === 'dragging') scheduleFrame(session)
  }

  /** A lifted block cancels, so the release that may still reach us is
   *  swallowed; a press that never lifted one just ends. */
  const onWindowBlur = () => {
    if (session?.phase === 'dragging' || session?.phase === 'held') cancel(session)
    else end()
  }

  /** Escape: drop the visuals now, but keep listening until the button
   *  comes up so its click can be swallowed rather than open the block. */
  const cancel = (current: Session) => {
    current.phase = 'cancelled'
    clearVisuals()
  }

  const end = () => {
    if (!session) return
    if (session.frame !== null) cancelAnimationFrame(session.frame)
    if (session.holdTimer !== null) clearTimeout(session.holdTimer)
    session = null
    window.removeEventListener('contextmenu', onContextMenu, true)
    window.removeEventListener('pointermove', onPointerMove, true)
    window.removeEventListener('pointerup', onPointerUp, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('blur', onWindowBlur)
    document.removeEventListener('scroll', onScroll, {capture: true})
    clearVisuals()
  }

  const clearVisuals = () => {
    document.documentElement.removeAttribute(DRAG_ACTIVE_ATTRIBUTE)
    for (const el of document.querySelectorAll(`[${DRAGGING_ROW_ATTRIBUTE}]`)) {
      el.removeAttribute(DRAGGING_ROW_ATTRIBUTE)
    }
    publish(IDLE)
  }

  return {
    install() {
      document.addEventListener('pointerdown', onPointerDown, true)
      return () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        end()
      }
    },
    subscribe: listener => listeners.add(listener),
    getSnapshot: () => snapshot,
  }
}

/** The bullet's block alone, or the whole selection when the bullet's
 *  block is part of it — ordered as the source panel renders it, which is
 *  the order the move keeps. */
const resolvePayload = async (
  repo: Repo,
  blockId: string,
  sourceRow: HTMLElement,
): Promise<Payload> => {
  const sourcePanel = sourceRow.closest<HTMLElement>(PANEL_SELECTOR)
  const panelId = sourcePanel?.dataset.panelId
  const uiStateBlock = await getUIStateBlock(
    repo, repo.activeWorkspaceId!, repo.user, panelId ? {panelId} : {},
  )
  const selected = getSelectionStateSnapshot(uiStateBlock).selectedBlockIds
  const ids = selected.includes(blockId)
    ? inDocumentOrder(selected, sourcePanel ?? document, sourceRow.dataset.renderScopeId!)
    : [blockId]
  return {ids, uiStateBlock}
}

/** Sort by where each block renders in `container` (a deferred row's
 *  placeholder counts), preferring its occurrence in `renderScopeId` —
 *  the outline the drag started in — over an embed of it rendered
 *  earlier. Ids with nowhere to render keep their relative order at the
 *  end. */
const inDocumentOrder = (ids: readonly string[], container: ParentNode, renderScopeId: string): string[] => {
  const scope = CSS.escape(renderScopeId)
  // Rows only: a block reference to `id` carries `data-block-id` too.
  const occurrence = (id: string, scoped: boolean): Element | null => {
    const block = CSS.escape(id)
    return container.querySelector(scoped
      ? `${ROW_SELECTOR}[data-block-id="${block}"][data-render-scope-id="${scope}"], `
        + `[data-lazy-block-id="${block}"][data-lazy-render-scope-id="${scope}"]`
      : `${ROW_SELECTOR}[data-block-id="${block}"], [data-lazy-block-id="${block}"]`)
  }
  const located = ids.map((id, index) => ({
    id,
    index,
    element: occurrence(id, true) ?? occurrence(id, false),
  }))
  return located
    .sort((a, b) => {
      if (!a.element || !b.element) return a.element ? -1 : b.element ? 1 : a.index - b.index
      if (a.element === b.element) return a.index - b.index
      return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })
    .map(entry => entry.id)
}

/** One `moveBlocksTo` (one transaction, one undo entry); then the moved
 *  blocks leave the selection and the first one takes focus in the panel
 *  it landed in, which becomes the active one — a release doesn't
 *  activate a panel the way a press does. Accepted: a click landing in
 *  the few ms between the move and the focus write loses its focus. */
const drop = async (repo: Repo, session: Session, resolvedTarget: Promise<DropTarget | null>): Promise<void> => {
  try {
    const target = await resolvedTarget
    if (!target) return
    const payload = await session.payload
    const result = await moveBlocksTo(repo, payload.ids, target.move)
    await unselectMovedBlocks(repo, payload.uiStateBlock, result.movedIds)
    const layoutSessionId = activeLayoutSessionElement()?.dataset.layoutSessionId
    if (target.panelId && layoutSessionId) await activatePanelRow(repo, layoutSessionId, target.panelId)
    const targetUiState = await getUIStateBlock(
      repo, repo.activeWorkspaceId!, repo.user, target.panelId ? {panelId: target.panelId} : {},
    )
    await focusBlock(targetUiState, result.movedIds[0], {renderScopeId: target.renderScopeId})
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Failed to move blocks')
  }
}

/** The standard event for "open the context menu here", so the bullet's
 *  menu opens at the press as it would for a right click. */
const openContextMenu = (session: Session) => {
  session.bullet.dispatchEvent(new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: session.startX,
    clientY: session.startY,
  }))
}

const markDragged = (ids: ReadonlySet<string>) => {
  for (const id of ids) {
    for (const row of document.querySelectorAll(`${ROW_SELECTOR}[data-block-id="${CSS.escape(id)}"]`)) {
      row.setAttribute(DRAGGING_ROW_ATTRIBUTE, '')
    }
  }
}

/** Scroll the container under the pointer when the pointer is near, or
 *  past, its top or bottom edge. Returns whether it moved. */
const autoScroll = (current: Session): boolean => {
  const {x, y} = current
  const hit = scrollContainerAt(document.elementFromPoint(x, y))
  const last = current.scroller?.isConnected ? current.scroller : null
  const scroller = hit ?? (last && withinColumn(last, x) ? last : null)
  current.scroller = scroller
  if (!scroller) return false
  const rect = scroller.getBoundingClientRect()
  const speed = (distance: number) =>
    Math.ceil(AUTO_SCROLL_MAX_PX_PER_FRAME * (1 - Math.max(0, distance) / AUTO_SCROLL_EDGE_PX))
  let delta = 0
  if (y < rect.top + AUTO_SCROLL_EDGE_PX) delta = -speed(y - rect.top)
  else if (y > rect.bottom - AUTO_SCROLL_EDGE_PX) delta = speed(rect.bottom - y)
  if (delta === 0) return false
  const before = scroller.scrollTop
  scroller.scrollTop = before + delta
  return scroller.scrollTop !== before
}

const withinColumn = (el: HTMLElement, x: number): boolean => {
  const rect = el.getBoundingClientRect()
  return x >= rect.left && x <= rect.right
}

const scrollContainerAt = (start: Element | null): HTMLElement | null => {
  for (let el = start; el && el !== document.documentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight) continue
    if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el
  }
  return null
}

const sameLine = (a: DropLine | null, b: DropLine | null): boolean =>
  a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width)
