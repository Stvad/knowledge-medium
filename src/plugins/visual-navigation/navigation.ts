import { useCallback, useEffect, useId, useSyncExternalStore, type RefObject } from 'react'
import type { Block } from '@/data/block'
import type { BlockContextType } from '@/types'
import {
  activePanelIdProp,
  focusedBlockIdProp,
  focusedVisualTargetKeyProp,
  focusVisualTarget,
} from '@/data/properties'
import { usePropertyValue } from '@/hooks/block'

export type VisualNavigationDirection = 'up' | 'down' | 'left' | 'right'
export type VisualNavigationSurface = 'document' | 'backlink' | 'embed' | 'breadcrumb' | 'nested'

export interface VisualNavigationRect {
  top: number
  right: number
  bottom: number
  left: number
}

export interface VisualNavigationCandidate {
  id: string
  blockId: string
  panelId?: string
  surface: VisualNavigationSurface
  rect: VisualNavigationRect
  order: number
}

export interface RegisteredVisualNavigationTarget {
  id: string
  key: string
  blockId: string
  uiStateBlock: Block
  panelId?: string
  layoutSessionBlockId?: string
  surface: VisualNavigationSurface
  element: HTMLElement
  anchorElement?: HTMLElement | null
  lastRect?: VisualNavigationRect
}

export interface RegisterVisualNavigationTargetInput {
  id: string
  key: string
  blockId: string
  uiStateBlock: Block
  panelId?: string
  layoutSessionBlockId?: string
  surface: VisualNavigationSurface
  element: HTMLElement
  anchorElement?: HTMLElement | null
}

export interface VisualNavigationMoveInput {
  block: Block
  uiStateBlock: Block
  visualTargetId?: string
}

interface Score {
  primary: number
  cross: number
  order: number
}

const targets = new Map<string, RegisteredVisualNavigationTarget>()
const subscribers = new Set<() => void>()
const pendingRecoveryByUiStateBlockId = new Map<string, {
  removed: RegisteredVisualNavigationTarget
  removedOrder: number
}>()
let activeTargetId: string | null = null
let registryVersion = 0

const notify = () => {
  registryVersion += 1
  for (const subscriber of subscribers) subscriber()
}

const subscribe = (listener: () => void): (() => void) => {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

const getVisualNavigationSnapshot = () => `${activeTargetId ?? ''}:${registryVersion}`

export const visualNavigationSurfaceFromContext = (
  context: BlockContextType,
): VisualNavigationSurface => {
  if (context.isBreadcrumb) return 'breadcrumb'
  if (context.isBacklink) return 'backlink'
  if (context.isEmbedded) return 'embed'
  if (context.isNestedSurface) return 'nested'
  return 'document'
}

export const registerVisualNavigationTarget = (
  input: RegisterVisualNavigationTargetInput,
): (() => void) => {
  const target: RegisteredVisualNavigationTarget = input
  targets.set(target.id, target)
  notify()
  schedulePendingRecoveryFlush(target.uiStateBlock.id)

  return () => {
    const removedOrder = orderedTargets().findIndex(entry => entry.id === target.id)
    targetRect(target)
    targets.delete(target.id)
    if (activeTargetId === target.id || isStoredFocusedTarget(target)) {
      const replacement = pickRecoveryTarget(target, removedOrder)
      activeTargetId = replacement?.id ?? null
      notify()
      if (replacement) {
        pendingRecoveryByUiStateBlockId.delete(target.uiStateBlock.id)
        scheduleFocusVisualNavigationTarget(replacement)
      } else {
        queuePendingRecovery(target, removedOrder)
      }
      return
    }
    notify()
  }
}

export const setActiveVisualNavigationTarget = (targetId: string | null): void => {
  if (activeTargetId === targetId) return
  activeTargetId = targetId
  notify()
}

export const getActiveVisualNavigationTarget = (): RegisteredVisualNavigationTarget | null =>
  activeTargetId ? targets.get(activeTargetId) ?? null : null

export const __resetVisualNavigationForTesting = (): void => {
  targets.clear()
  pendingRecoveryByUiStateBlockId.clear()
  activeTargetId = null
  notify()
}

const toVisualRect = (rect: DOMRect): VisualNavigationRect => ({
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
  left: rect.left,
})

const centerX = (rect: VisualNavigationRect): number => (rect.left + rect.right) / 2
const centerY = (rect: VisualNavigationRect): number => (rect.top + rect.bottom) / 2

const intervalGap = (
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): number => {
  if (aEnd >= bStart && bEnd >= aStart) return 0
  return bStart > aEnd ? bStart - aEnd : aStart - bEnd
}

const scoreCandidate = (
  source: VisualNavigationCandidate,
  candidate: VisualNavigationCandidate,
  direction: VisualNavigationDirection,
): Score | null => {
  const sourceRect = source.rect
  const rect = candidate.rect

  if (direction === 'right') {
    if (centerX(rect) <= centerX(sourceRect)) return null
    return {
      primary: Math.max(0, rect.left - sourceRect.right),
      cross: intervalGap(sourceRect.top, sourceRect.bottom, rect.top, rect.bottom),
      order: candidate.order,
    }
  }

  if (direction === 'left') {
    if (centerX(rect) >= centerX(sourceRect)) return null
    return {
      primary: Math.max(0, sourceRect.left - rect.right),
      cross: intervalGap(sourceRect.top, sourceRect.bottom, rect.top, rect.bottom),
      order: -candidate.order,
    }
  }

  if (direction === 'down') {
    if (centerY(rect) <= centerY(sourceRect)) return null
    return {
      primary: Math.max(0, rect.top - sourceRect.bottom),
      cross: intervalGap(sourceRect.left, sourceRect.right, rect.left, rect.right),
      order: candidate.order,
    }
  }

  if (centerY(rect) >= centerY(sourceRect)) return null
  return {
    primary: Math.max(0, sourceRect.top - rect.bottom),
    cross: intervalGap(sourceRect.left, sourceRect.right, rect.left, rect.right),
    order: -candidate.order,
  }
}

const compareScores = (left: Score, right: Score): number =>
  left.cross - right.cross ||
  left.primary - right.primary ||
  left.order - right.order

const bestVisualNavigationTarget = (
  source: VisualNavigationCandidate,
  candidates: readonly VisualNavigationCandidate[],
  direction: VisualNavigationDirection,
  predicate: (candidate: VisualNavigationCandidate, score: Score) => boolean,
): VisualNavigationCandidate | null => {
  let best: {candidate: VisualNavigationCandidate; score: Score} | null = null

  for (const candidate of candidates) {
    if (candidate.id === source.id) continue
    if (candidate.surface === 'breadcrumb') continue
    const score = scoreCandidate(source, candidate, direction)
    if (!score || !predicate(candidate, score)) continue
    if (!best || compareScores(score, best.score) < 0) {
      best = {candidate, score}
    }
  }

  return best?.candidate ?? null
}

export const pickVisualNavigationTarget = (
  source: VisualNavigationCandidate,
  candidates: readonly VisualNavigationCandidate[],
  direction: VisualNavigationDirection,
): VisualNavigationCandidate | null => {
  if (source.panelId && (direction === 'left' || direction === 'right')) {
    return bestVisualNavigationTarget(source, candidates, direction, candidate =>
      Boolean(candidate.panelId) && candidate.panelId !== source.panelId)
  }

  if (source.panelId && (direction === 'up' || direction === 'down')) {
    const inPanel = bestVisualNavigationTarget(source, candidates, direction, candidate =>
      candidate.panelId === source.panelId)
    if (inPanel) return inPanel

    // Only jump vertically across panels when the target is actually in
    // the same visual column. Without the overlap gate, a lower block in
    // a side panel can beat the expected "stay in this panel" mental
    // model just because it is technically below the source.
    return bestVisualNavigationTarget(source, candidates, direction, candidate =>
      Boolean(candidate.panelId) && candidate.panelId !== source.panelId &&
      intervalGap(source.rect.left, source.rect.right, candidate.rect.left, candidate.rect.right) === 0)
  }

  return bestVisualNavigationTarget(source, candidates, direction, () => true)
}

const rectIsNavigable = (rect: DOMRect): boolean =>
  rect.width > 0 &&
  rect.height > 0 &&
  rect.bottom >= 0 &&
  rect.right >= 0 &&
  rect.top <= (window.innerHeight || document.documentElement.clientHeight) &&
  rect.left <= (window.innerWidth || document.documentElement.clientWidth)

const targetRect = (target: RegisteredVisualNavigationTarget): VisualNavigationRect | null => {
  const element = target.anchorElement ?? target.element
  if (!element.isConnected) return null
  const rect = element.getBoundingClientRect()
  if (!rectIsNavigable(rect)) return null
  const visualRect = toVisualRect(rect)
  target.lastRect = visualRect
  return visualRect
}

const candidateFromTarget = (
  target: RegisteredVisualNavigationTarget,
  order: number,
): VisualNavigationCandidate | null => {
  const rect = targetRect(target)
  if (!rect) return null
  return {
    id: target.id,
    blockId: target.blockId,
    panelId: target.panelId,
    surface: target.surface,
    rect,
    order,
  }
}

const orderedTargets = (): RegisteredVisualNavigationTarget[] =>
  Array.from(targets.values()).sort((left, right) => {
    if (left.element === right.element) return 0
    const position = left.element.compareDocumentPosition(right.element)
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1
    return 0
  })

const targetFromElement = (element: Element | null): RegisteredVisualNavigationTarget | null => {
  const targetElement = element?.closest<HTMLElement>('[data-visual-navigation-target-id]')
  const targetId = targetElement?.dataset.visualNavigationTargetId
  return targetId ? targets.get(targetId) ?? null : null
}

const rectDistance = (source: VisualNavigationRect, candidate: VisualNavigationRect): number => {
  const x = centerX(source) - centerX(candidate)
  const y = centerY(source) - centerY(candidate)
  return x * x + y * y
}

const compareRecoveryTargets = (
  removed: RegisteredVisualNavigationTarget,
  removedOrder: number,
  left: {target: RegisteredVisualNavigationTarget; rect: VisualNavigationRect; order: number},
  right: {target: RegisteredVisualNavigationTarget; rect: VisualNavigationRect; order: number},
): number => {
  const leftSameBlock = left.target.blockId === removed.blockId ? 0 : 1
  const rightSameBlock = right.target.blockId === removed.blockId ? 0 : 1
  if (leftSameBlock !== rightSameBlock) return leftSameBlock - rightSameBlock

  const leftSamePanel = left.target.panelId === removed.panelId ? 0 : 1
  const rightSamePanel = right.target.panelId === removed.panelId ? 0 : 1
  if (leftSamePanel !== rightSamePanel) return leftSamePanel - rightSamePanel

  const sourceRect = removed.lastRect
  if (sourceRect) {
    const distance = rectDistance(sourceRect, left.rect) - rectDistance(sourceRect, right.rect)
    if (distance !== 0) return distance
  }

  return Math.abs(left.order - removedOrder) - Math.abs(right.order - removedOrder)
}

const pickRecoveryTarget = (
  removed: RegisteredVisualNavigationTarget,
  removedOrder: number,
): RegisteredVisualNavigationTarget | null => {
  let best: {target: RegisteredVisualNavigationTarget; rect: VisualNavigationRect; order: number} | null = null

  for (const [order, target] of orderedTargets().entries()) {
    if (target.uiStateBlock.id !== removed.uiStateBlock.id) continue
    if (target.surface === 'breadcrumb') continue
    const rect = targetRect(target)
    if (!rect) continue
    const candidate = {target, rect, order}
    if (!best || compareRecoveryTargets(removed, removedOrder, candidate, best) < 0) {
      best = candidate
    }
  }

  return best?.target ?? null
}

const isStoredFocusedTarget = (target: RegisteredVisualNavigationTarget): boolean =>
  target.uiStateBlock.peekProperty(focusedBlockIdProp) === target.blockId &&
  target.uiStateBlock.peekProperty(focusedVisualTargetKeyProp) === target.key

const flushPendingRecovery = (uiStateBlockId: string): void => {
  const pending = pendingRecoveryByUiStateBlockId.get(uiStateBlockId)
  if (!pending) return
  const replacement = pickRecoveryTarget(pending.removed, pending.removedOrder)
  if (!replacement) return

  pendingRecoveryByUiStateBlockId.delete(uiStateBlockId)
  activeTargetId = replacement.id
  notify()
  scheduleFocusVisualNavigationTarget(replacement)
}

const schedulePendingRecoveryFlush = (uiStateBlockId: string): void => {
  if (!pendingRecoveryByUiStateBlockId.has(uiStateBlockId)) return
  setTimeout(() => flushPendingRecovery(uiStateBlockId), 0)
}

const queuePendingRecovery = (
  removed: RegisteredVisualNavigationTarget,
  removedOrder: number,
): void => {
  pendingRecoveryByUiStateBlockId.set(removed.uiStateBlock.id, {removed, removedOrder})
  schedulePendingRecoveryFlush(removed.uiStateBlock.id)
}

const recoverVisualNavigationTarget = async (
  input: VisualNavigationMoveInput,
): Promise<boolean> => {
  const source: RegisteredVisualNavigationTarget = {
    id: input.visualTargetId ?? '__missing__',
    key: input.uiStateBlock.peekProperty(focusedVisualTargetKeyProp) ?? '',
    blockId: input.uiStateBlock.peekProperty(focusedBlockIdProp) ?? input.block.id,
    uiStateBlock: input.uiStateBlock,
    surface: 'document',
    element: document.body,
  }
  const replacement = pickRecoveryTarget(source, 0)
  if (!replacement) return false
  await focusVisualNavigationTarget(replacement)
  return true
}

const scheduleFocusVisualNavigationTarget = (target: RegisteredVisualNavigationTarget): void => {
  const focus = () => {
    if (targets.get(target.id) !== target) return
    void focusVisualNavigationTarget(target)
  }
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(focus)
  } else {
    setTimeout(focus, 0)
  }
}

const hasMountedTargetKey = (
  uiStateBlock: Block,
  blockId: string | undefined,
  targetKey: string | undefined,
): boolean =>
  Boolean(targetKey) &&
  Boolean(blockId) &&
  Array.from(targets.values()).some(target =>
    target.uiStateBlock.id === uiStateBlock.id &&
    target.blockId === blockId &&
    target.key === targetKey &&
    Boolean(targetRect(target)),
  )

const resolveCurrentTarget = (
  input: VisualNavigationMoveInput,
): RegisteredVisualNavigationTarget | null => {
  const focusedBlockId = input.uiStateBlock.peekProperty(focusedBlockIdProp) ?? input.block.id
  const focusedTargetKey = input.uiStateBlock.peekProperty(focusedVisualTargetKeyProp)

  if (input.visualTargetId) {
    const explicit = targets.get(input.visualTargetId)
    if (explicit) return explicit
  }

  if (focusedTargetKey) {
    const fromStoredKey = orderedTargets().find(target =>
      target.uiStateBlock.id === input.uiStateBlock.id &&
      target.blockId === focusedBlockId &&
      target.key === focusedTargetKey &&
      target.surface !== 'breadcrumb' &&
      Boolean(targetRect(target)),
    )
    if (fromStoredKey) return fromStoredKey
  }

  const active = getActiveVisualNavigationTarget()
  if (active?.uiStateBlock.id === input.uiStateBlock.id) return active

  if (typeof document !== 'undefined') {
    const fromDomFocus = targetFromElement(document.activeElement)
    if (fromDomFocus?.uiStateBlock.id === input.uiStateBlock.id) return fromDomFocus
  }

  return orderedTargets().find(target =>
    target.uiStateBlock.id === input.uiStateBlock.id &&
    target.blockId === focusedBlockId &&
    target.surface !== 'breadcrumb' &&
    Boolean(targetRect(target)),
  ) ?? null
}

async function focusVisualNavigationTarget(
  target: RegisteredVisualNavigationTarget,
): Promise<void> {
  setActiveVisualNavigationTarget(target.id)

  if (target.layoutSessionBlockId && target.panelId) {
    const layoutSessionBlock = target.uiStateBlock.repo.block(target.layoutSessionBlockId)
    if (layoutSessionBlock.peekProperty(activePanelIdProp) !== target.panelId) {
      await layoutSessionBlock.set(activePanelIdProp, target.panelId)
    }
  }

  await focusVisualTarget(target.uiStateBlock, target.blockId, target.key)

  const element = target.anchorElement ?? target.element
  if (typeof element.scrollIntoView === 'function') {
    element.scrollIntoView({block: 'nearest', inline: 'nearest'})
  }
  target.element.focus({preventScroll: true})
}

export const moveVisualFocus = async (
  input: VisualNavigationMoveInput,
  direction: VisualNavigationDirection,
): Promise<boolean> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false

  const current = resolveCurrentTarget(input)
  if (!current) return recoverVisualNavigationTarget(input)

  const ordered = orderedTargets()
  const sourceOrder = ordered.findIndex(target => target.id === current.id)
  const source = candidateFromTarget(current, Math.max(0, sourceOrder))
  if (!source) return recoverVisualNavigationTarget(input)

  const candidates = ordered
    .map((target, order) => candidateFromTarget(target, order))
    .filter((candidate): candidate is VisualNavigationCandidate => Boolean(candidate))
  const next = pickVisualNavigationTarget(source, candidates, direction)
  if (!next) return false

  const target = targets.get(next.id)
  if (!target) return false

  await focusVisualNavigationTarget(target)
  return true
}

export const useVisualNavigationTarget = ({
  blockId,
  uiStateBlock,
  visualTargetKey,
  panelId,
  layoutSessionBlockId,
  surface,
  elementRef,
  anchorElementRef,
}: {
  blockId: string
  uiStateBlock: Block
  visualTargetKey?: string
  panelId?: string
  layoutSessionBlockId?: string
  surface: VisualNavigationSurface
  elementRef: RefObject<HTMLElement | null>
  anchorElementRef?: RefObject<HTMLElement | null>
}): {
  targetId: string
  activate: () => void
  active: boolean
} => {
  const reactId = useId()
  const targetId = `${panelId ?? '__root__'}:${blockId}:${reactId}`
  const targetKey = visualTargetKey ?? targetId
  useSyncExternalStore(subscribe, getVisualNavigationSnapshot, getVisualNavigationSnapshot)
  const [focusedBlockId] = usePropertyValue(uiStateBlock, focusedBlockIdProp)
  const [focusedTargetKey] = usePropertyValue(uiStateBlock, focusedVisualTargetKeyProp)
  const focusedTargetKeyMounted = hasMountedTargetKey(uiStateBlock, focusedBlockId, focusedTargetKey)
  const activeTarget = activeTargetId ? targets.get(activeTargetId) : null
  const activeTargetApplies =
    Boolean(activeTarget) &&
    activeTarget?.uiStateBlock.id === uiStateBlock.id &&
    activeTarget.blockId === focusedBlockId &&
    Boolean(targetRect(activeTarget))

  useEffect(() => {
    const element = elementRef.current
    if (!element) return

    element.dataset.visualNavigationTargetId = targetId
    const unregister = registerVisualNavigationTarget({
      id: targetId,
      key: targetKey,
      blockId,
      uiStateBlock,
      panelId,
      layoutSessionBlockId,
      surface,
      element,
      anchorElement: anchorElementRef?.current ?? null,
    })
    return () => {
      unregister()
      if (element.dataset.visualNavigationTargetId === targetId) {
        delete element.dataset.visualNavigationTargetId
      }
    }
  }, [
    anchorElementRef,
    blockId,
    elementRef,
    layoutSessionBlockId,
    panelId,
    surface,
    targetKey,
    targetId,
    uiStateBlock,
  ])

  const activate = useCallback(() => {
    setActiveVisualNavigationTarget(targetId)
    void uiStateBlock.set(focusedVisualTargetKeyProp, targetKey)
  }, [targetId, targetKey, uiStateBlock])

  return {
    targetId,
    activate,
    active: focusedBlockId === blockId &&
      (focusedTargetKeyMounted
        ? focusedTargetKey === targetKey
        : !activeTargetApplies || activeTargetId === targetId),
  }
}
