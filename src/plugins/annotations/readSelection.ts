/**
 * A selection in rendered (read-mode) content, mapped back to raw offsets in
 * the block's text through the source spans the read-mode transform records
 * on each element ({@link SOURCE_SPANS_ATTRIBUTE}). Exact or refused: an
 * endpoint maps only from text that is exactly its source slice, in an element
 * whose DOM text nodes are exactly the ones it recorded.
 */

import {useSyncExternalStore} from 'react'
import {BLOCK_BOUNDARY_SELECTOR, BLOCK_SHELL_ATTRIBUTE} from '@/extensions/blockInteraction.js'
import {SOURCE_SPANS_ATTRIBUTE} from './readHighlights.ts'

/** The endpoints of a selection, as `Selection` reports them. */
export interface SelectionEnds {
  anchorNode: Node | null
  anchorOffset: number
  focusNode: Node | null
  focusOffset: number
}

interface BlockLocation {
  blockId: string
  renderScopeId: string | undefined
}

/** Where a selection sits, without mapping it: in one block's rendered
 *  content, across several (or partly outside any), or not in rendered block
 *  content at all — collapsed, in an editor, in the app's chrome. */
export type ReadSelectionLocation =
  | {kind: 'block'; blockId: string; renderScopeId: string | undefined}
  | {kind: 'several'}
  | null

export type ReadSelection =
  | {kind: 'range'; blockId: string; renderScopeId: string | undefined; content: string; from: number; to: number}
  | {kind: 'several'}
  | {kind: 'inexact'}
  | null

const elementOf = (node: Node): Element | null =>
  node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement

/** The block whose content slot holds `node`, or null outside every slot. An
 *  editor's text is edit mode, not read mode. */
const blockAt = (node: Node | null): BlockLocation | null => {
  const element = node && elementOf(node)
  const boundary = element?.closest(BLOCK_BOUNDARY_SELECTOR)
  if (!boundary || boundary.hasAttribute(BLOCK_SHELL_ATTRIBUTE) || element!.closest('.cm-editor')) return null
  const shell = boundary.closest<HTMLElement>(`[${BLOCK_SHELL_ATTRIBUTE}]`)
  const blockId = shell?.dataset.blockId
  return blockId ? {blockId, renderScopeId: shell.dataset.renderScopeId} : null
}

const isCollapsed = (ends: SelectionEnds) =>
  ends.anchorNode === ends.focusNode && ends.anchorOffset === ends.focusOffset

export const locateReadSelection = (ends: SelectionEnds | null): ReadSelectionLocation => {
  if (!ends?.anchorNode || !ends.focusNode || isCollapsed(ends)) return null
  const anchor = blockAt(ends.anchorNode)
  const focus = blockAt(ends.focusNode)
  if (!anchor && !focus) return null
  if (!anchor || !focus || anchor.blockId !== focus.blockId || anchor.renderScopeId !== focus.renderScopeId) {
    return {kind: 'several'}
  }
  return {kind: 'block', ...anchor}
}

const SPAN_ENTRY = /^(\d+)-(\d+)$/

/** The raw offset of `offset` in `text`, read from its element's recorded
 *  spans: the element must have recorded them for `blockId`, hold exactly as
 *  many text nodes as it recorded, and this one must still be its slice of
 *  `content` (a render that lags the content refuses). */
const offsetInText = (text: Text, offset: number, blockId: string, content: string): number | null => {
  const holder = text.parentElement
  const [source, ...entries] = holder?.getAttribute(SOURCE_SPANS_ATTRIBUTE)?.split(' ') ?? []
  if (source !== blockId) return null
  const texts = [...holder!.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
  if (texts.length !== entries.length) return null
  const span = SPAN_ENTRY.exec(entries[texts.indexOf(text)])
  if (!span) return null
  const from = Number(span[1])
  if (content.slice(from, Number(span[2])) !== text.data) return null
  return from + offset
}

/** A point between two nodes maps through the text on either side of it. */
const offsetAt = (node: Node, offset: number, blockId: string, content: string): number | null => {
  if (node.nodeType === Node.TEXT_NODE) return offsetInText(node as Text, offset, blockId, content)
  const before = node.childNodes[offset - 1]
  if (before?.nodeType === Node.TEXT_NODE) {
    return offsetInText(before as Text, (before as Text).length, blockId, content)
  }
  const after = node.childNodes[offset]
  return after?.nodeType === Node.TEXT_NODE ? offsetInText(after as Text, 0, blockId, content) : null
}

/** The selection as a raw range of one block's text. `contentOf` reads the
 *  block's current content; the range is not widened to reference spans,
 *  which is the anchor's job. */
export const mapReadSelection = (
  ends: SelectionEnds | null,
  contentOf: (blockId: string) => string | undefined,
): ReadSelection => {
  const location = locateReadSelection(ends)
  if (location?.kind !== 'block') return location
  const content = contentOf(location.blockId)
  if (content === undefined) return {kind: 'inexact'}
  const anchor = offsetAt(ends!.anchorNode!, ends!.anchorOffset, location.blockId, content)
  const focus = offsetAt(ends!.focusNode!, ends!.focusOffset, location.blockId, content)
  if (anchor === null || focus === null) return {kind: 'inexact'}
  const {blockId, renderScopeId} = location
  return {kind: 'range', blockId, renderScopeId, content, from: Math.min(anchor, focus), to: Math.max(anchor, focus)}
}

/** Does the user hold a non-collapsed selection touching `element`? */
export const holdsSelection = (element: Element): boolean => {
  const selection = element.ownerDocument.getSelection()
  return !!selection && !selection.isCollapsed && selection.rangeCount > 0 &&
    selection.getRangeAt(0).intersectsNode(element)
}

// ──── Where the selection is, as a store ────

let located: ReadSelectionLocation = null
const listeners = new Set<() => void>()

const sameLocation = (a: ReadSelectionLocation, b: ReadSelectionLocation): boolean =>
  a?.kind === 'block' && b?.kind === 'block'
    ? a.blockId === b.blockId && a.renderScopeId === b.renderScopeId
    : a?.kind === b?.kind

const relocate = () => {
  const next = locateReadSelection(document.getSelection())
  if (sameLocation(located, next)) return
  located = next
  for (const listener of listeners) listener()
}

/** Listens to the document only while someone reads the location, and
 *  notifies only when the block holding the selection changes, not on every
 *  caret move. */
const subscribe = (listener: () => void) => {
  if (listeners.size === 0) {
    located = locateReadSelection(document.getSelection())
    document.addEventListener('selectionchange', relocate)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) document.removeEventListener('selectionchange', relocate)
  }
}

/** Does the read-mode selection sit in this block, as rendered in this scope? */
export const useHoldsReadSelection = (blockId: string, renderScopeId: string | undefined): boolean =>
  useSyncExternalStore(subscribe, () =>
    located?.kind === 'block' && located.blockId === blockId && located.renderScopeId === renderScopeId)
