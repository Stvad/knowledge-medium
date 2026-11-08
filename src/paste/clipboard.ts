import type { Block } from '@/data/block'
import { hasSourceContent, holdsSource } from '@/data/blockTypes'
import type { PasteCaret, PasteRequest } from './decision.ts'

export type ClipboardContent = Pick<PasteRequest, 'text' | 'html' | 'files'>

/** What a paste/drop payload carries for the paste decision, or null when it
 *  carries nothing to paste. Neither text nor html alone decides emptiness:
 *  a pasted file has no `text/plain`, and a copied `<img>` can arrive as
 *  `text/html` only. */
export const readClipboardContent = (
  data: Pick<DataTransfer, 'getData'> & {files?: FileList | null} | null | undefined,
): ClipboardContent | null => {
  if (!data) return null
  const files = data.files && data.files.length > 0 ? Array.from(data.files) : []
  const text = data.getData('text/plain')
  const html = data.getData('text/html') || undefined
  if (!text && !html && files.length === 0) return null
  return {text, html, files}
}

/** Content that is only whitespace: the one test of an empty target, so the request
 *  below and the paste's absorption of its target agree. */
export const isBlankContent = (content: string): boolean => content.trim().length === 0

/** What source takes from a paste: the text, whole. Parsed as an outline it would
 *  keep one line and shred the rest around it, and a captured file's `((id))` would
 *  only be text in it. */
const asSourcePaste = (content: ClipboardContent) =>
  ({...content, files: [], intent: 'single-block'}) as const

/** The request for a paste with no text caret, which is otherwise always a split.
 *  An empty source block takes it as source; source with content pastes around itself. */
export const shellPasteRequest = (content: ClipboardContent, target: Block): PasteRequest => {
  const row = target.peek()
  return row != null && hasSourceContent(row) && isBlankContent(row.content)
    ? {...asSourcePaste(content), surface: 'shell'}
    : {...content, intent: 'split', surface: 'shell'}
}

/** The request for a paste at the markdown editor's caret: the chord's intent,
 *  except that source, open there when its own editor's plugin is off, takes it as
 *  source. */
export const editorPasteRequest = (
  content: ClipboardContent,
  target: Block,
  intent: PasteRequest['intent'],
  caret: PasteCaret,
): PasteRequest => holdsSource(target)
  ? {...asSourcePaste(content), surface: 'editor', caret}
  : {...content, intent, surface: 'editor', caret}
