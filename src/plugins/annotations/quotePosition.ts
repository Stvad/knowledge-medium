/**
 * Where a range thread's quote is drawn in its row, so the margin can put the
 * thread's card beside the quoted line rather than the row's first.
 *
 * Edit mode asks the row's editor, resolving the anchor against its live doc
 * as the editor's highlights do (`highlights.ts`). Read mode resolves against
 * the stored content and finds the offset through the source spans the
 * rendered markdown records (`readHighlights.ts`), under the key of exactly
 * that content, so a render the content has moved past finds nothing.
 */

import {EditorView} from '@codemirror/view'
import {BLOCK_SHELL_ATTRIBUTE} from '@/extensions/blockInteraction.js'
import {resolveAnchor, type RangeAnchor} from './anchor.ts'
import {renderedSourceKey, SOURCE_SPANS_ATTRIBUTE} from './readHighlights.ts'
import {recordedTexts} from './readSelection.ts'

export interface TextPoint {
  text: Text
  offset: number
}

/** The rendered point where the quote `[at, to)` starts, among the elements
 *  `root` holds that recorded spans under `key`: in the text that covers
 *  `at`, else at the start of the first text after it that is still inside
 *  the quote (a quote starting in a reference, which records no span of its
 *  own). Text past the quote may be on another line. */
export const renderedPoint = (root: Element, key: string, content: string, at: number, to: number): TextPoint | null => {
  let next: {text: Text; from: number} | null = null
  for (const holder of root.querySelectorAll(`[${SOURCE_SPANS_ATTRIBUTE}~="${CSS.escape(key)}"]`)) {
    for (const {text, from} of recordedTexts(holder, key, content) ?? []) {
      if (from === null) continue
      if (from <= at && at < from + text.length) return {text, offset: at - from}
      if (from > at && from <= to && (next === null || from < next.from)) next = {text, from}
    }
  }
  return next && {text: next.text, offset: 0}
}

/** The editor of the row's own content: a nested row's is inside that row's
 *  shell, and an editor below the content (a suggestion's composer) edits
 *  other text. */
export const contentEditor = (row: Element): Element | undefined =>
  [...row.querySelectorAll('.block-content .cm-editor')]
    .find(editor => editor.closest(`[${BLOCK_SHELL_ATTRIBUTE}]`) === row)

const editorTop = (editor: Element, anchor: RangeAnchor): number | null => {
  const view = EditorView.findFromDOM(editor as HTMLElement)
  if (!view) return null
  const resolved = resolveAnchor(view.state.doc.toString(), anchor)
  return resolved.state === 'stale' ? null : view.coordsAtPos(resolved.from, 1)?.top ?? null
}

/** The top of the first character at `point`: a collapsed range has no box
 *  in every engine, and at a wrap it is ambiguous which line it is on. */
const pointTop = ({text, offset}: TextPoint): number | null => {
  const range = text.ownerDocument.createRange()
  range.setStart(text, offset)
  range.setEnd(text, Math.min(offset + 1, text.length))
  const [first] = range.getClientRects()
  return first?.top ?? null
}

/** The viewport top of the line `anchor`'s quote starts on in `row`, the
 *  block's shell in render scope `renderScopeId`; null where the quote isn't
 *  found exactly, which leaves the card at the row's top. `content` is the
 *  block's stored content, which read mode renders. */
export const quoteTop = (
  row: Element,
  blockId: string,
  renderScopeId: string,
  anchor: RangeAnchor,
  content: string | undefined,
): number | null => {
  const editor = contentEditor(row)
  if (editor) return editorTop(editor, anchor)
  if (content === undefined) return null
  const resolved = resolveAnchor(content, anchor)
  if (resolved.state === 'stale') return null
  const key = renderedSourceKey(blockId, renderScopeId, content)
  const point = renderedPoint(row, key, content, resolved.from, resolved.to)
  return point && pointTop(point)
}
