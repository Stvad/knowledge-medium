/**
 * The opening moves every paste-EVENT handler makes, in one place.
 *
 * There are two such handlers — the block shell
 * (`@/editor/BlockPasteShellDecorator.js`) and the editor
 * (`CodeMirrorContentRenderer`) — and they used to hand-roll the same
 * four steps in the same order, with the same three ways to get it
 * subtly wrong:
 *
 *   1. read `files` BEFORE any early return, or an image paste (which
 *      carries no `text/plain`) is silently dropped;
 *   2. read `text/html` too, not just `text/plain`, or the cut payload
 *      is invisible on the one surface that can actually see it;
 *   3. resolve the payload BEFORE the "nothing to paste" bail, or a cut
 *      of a genuinely empty block can never be completed — its text is
 *      empty, so an emptiness guard eats it;
 *   4. only then decide there's nothing to do.
 *
 * The keyboard-driven surfaces have no `DataTransfer` at all and go
 * through `pasteOrMove` instead; see its module doc for why they resolve
 * payloads differently (text-only clipboard, no flavors).
 */
import type { ClipboardEvent } from 'react'
import { resolveClipboardPayload, type ClipboardPayload } from '@/paste/clipboardPayload.js'

export interface PasteEventContent {
  /** `text/plain`, or '' when absent. */
  readonly text: string
  /** `text/html`, or undefined when absent — the flavor that carries a
   *  cut's block identity. */
  readonly html: string | undefined
  /** Files (a pasted image); empty when there are none. */
  readonly files: File[]
  /** Block identity for this clipboard content, resolved from the two
   *  flavors above. `null` for ordinary content from anywhere else. */
  readonly payload: ClipboardPayload | null
  /** False when there is genuinely nothing to act on — no text, no
   *  files, and no cut to complete. Handlers return early on this. */
  readonly hasAnything: boolean
}

export const readPasteEventContent = (
  e: ClipboardEvent<HTMLElement>,
): PasteEventContent => {
  const files = e.clipboardData?.files
  const fileList = files && files.length > 0 ? Array.from(files) : []
  const text = e.clipboardData?.getData('text/plain') ?? ''
  const html = e.clipboardData?.getData('text/html') || undefined
  const payload = resolveClipboardPayload(text, html)

  return {
    text,
    html,
    files: fileList,
    payload,
    hasAnything: Boolean(text) || fileList.length > 0 || payload !== null,
  }
}
