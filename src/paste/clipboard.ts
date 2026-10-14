import type { PasteRequest } from './decision.ts'

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
