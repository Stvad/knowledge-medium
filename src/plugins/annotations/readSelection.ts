/**
 * A selection in rendered (read-mode) content, mapped back to raw offsets in
 * the block's text through the source spans the read-mode transform records
 * on each element ({@link SOURCE_SPANS_ATTRIBUTE}). Exact or refused: an
 * endpoint maps only from text that is exactly its source slice, in an element
 * whose DOM text nodes are exactly the ones it recorded.
 */

import {useSyncExternalStore} from 'react'
import {BLOCK_BOUNDARY_SELECTOR, BLOCK_SHELL_ATTRIBUTE, elementOf} from '@/extensions/blockInteraction.js'
import {CallbackSet} from '@/utils/callbackSet.js'
import {renderedSourceKey, SOURCE_SPANS_ATTRIBUTE} from './readHighlights.ts'
import {viewKey} from './uiStore.ts'

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
 *  spans: the element must have recorded them under `key` (this row's block
 *  and scope, rendering exactly `content`), hold exactly as many text nodes as
 *  it recorded, and this one must be its slice of `content`. */
const offsetInText = (text: Text, offset: number, key: string, content: string): number | null => {
  const holder = text.parentElement
  const [recordedKey, ...entries] = holder?.getAttribute(SOURCE_SPANS_ATTRIBUTE)?.split(' ') ?? []
  if (recordedKey !== key) return null
  const texts = [...holder!.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
  if (texts.length !== entries.length) return null
  const span = SPAN_ENTRY.exec(entries[texts.indexOf(text)])
  if (!span) return null
  const from = Number(span[1])
  // DEFENCE IN DEPTH: the key and the entry already say this text rendered
  // that slice; this catches text changed in the page since (an extension).
  if (content.slice(from, Number(span[2])) !== text.data) return null
  return from + offset
}

/** A point between two nodes maps through the text on either side of it. */
const offsetAt = (node: Node, offset: number, key: string, content: string): number | null => {
  if (node.nodeType === Node.TEXT_NODE) return offsetInText(node as Text, offset, key, content)
  const before = node.childNodes[offset - 1]
  if (before?.nodeType === Node.TEXT_NODE) {
    return offsetInText(before as Text, (before as Text).length, key, content)
  }
  const after = node.childNodes[offset]
  return after?.nodeType === Node.TEXT_NODE ? offsetInText(after as Text, 0, key, content) : null
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
  const key = renderedSourceKey(location.blockId, location.renderScopeId, content)
  const anchor = offsetAt(ends!.anchorNode!, ends!.anchorOffset, key, content)
  const focus = offsetAt(ends!.focusNode!, ends!.focusOffset, key, content)
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

// ──── Which row holds the selection, as a store ────

/** The `viewKey` of the row whose rendered content holds the whole selection,
 *  or null: all its one reader asks is "is it this row?". */
const holderOf = (ends: SelectionEnds | null): string | null => {
  const location = locateReadSelection(ends)
  return location?.kind === 'block' ? viewKey(location.renderScopeId, location.blockId) : null
}

let holder: string | null = null
const listeners = new CallbackSet('annotations.read-selection')

const rehold = () => {
  const next = holderOf(document.getSelection())
  if (next === holder) return
  holder = next
  listeners.notify()
}

/** Listens to the document only while someone reads the holder, and notifies
 *  only when it changes, not on every caret move. */
const subscribe = (listener: () => void) => {
  if (listeners.size === 0) {
    holder = holderOf(document.getSelection())
    document.addEventListener('selectionchange', rehold)
  }
  const remove = listeners.add(listener)
  return () => {
    remove()
    if (listeners.size === 0) document.removeEventListener('selectionchange', rehold)
  }
}

/** Does the read-mode selection sit in this block, as rendered in this scope? */
export const useHoldsReadSelection = (blockId: string, renderScopeId: string | undefined): boolean =>
  useSyncExternalStore(subscribe, () => holder === viewKey(renderScopeId, blockId))
