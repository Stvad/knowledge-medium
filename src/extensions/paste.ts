import { defineVerbFacet } from '@/facets/verbFacet.ts'
import type { PasteChordIntent } from '@/utils/paste.ts'

/**
 * What the editor should do with a paste. The default impl reproduces the
 * historical hardcoded branching; plugins override the decision to
 * customize when pasted content splits into an outline vs lands as-is
 * (e.g. CSV → table rows, URL → titled link, source-dialect parsing).
 */
export type PasteDecision =
  /** Drop the (optionally rewritten) text into the current block verbatim,
   *  newlines kept — Roam's "paste as plain text". */
  | {kind: 'single-block'; text?: string}
  /** Parse the (optionally rewritten) text as markdown and split it into a
   *  block tree at the cursor. */
  | {kind: 'split'; text?: string}
  /** Let the editor insert the text at the cursor (plain single-line
   *  paste). No structural change. */
  | {kind: 'native'}

export interface PasteRequest {
  /** Clipboard `text/plain`. */
  text: string
  /** Clipboard `text/html`, if any — lets format-aware overrides inspect
   *  richer content (tables, CSV pasted from a spreadsheet). */
  html?: string
  /** Latched paste chord: plain Cmd/Ctrl+V (`split`) vs Cmd/Ctrl+Shift+V
   *  (`single-block`). The paste `ClipboardEvent` carries no modifier
   *  state, so the renderer captures this on keydown. */
  intent: PasteChordIntent
}

/**
 * The historical paste decision, now the replaceable `defaultImpl` of the
 * paste verb:
 *   - `single-block` chord → verbatim into the current block.
 *   - plain chord with a newline → split into an outline.
 *   - plain chord, single line → native insert.
 */
export const defaultPasteDecision = (request: PasteRequest): PasteDecision => {
  if (request.intent === 'single-block') return {kind: 'single-block'}
  if (request.text.includes('\n')) return {kind: 'split'}
  return {kind: 'native'}
}

/**
 * The paste verb — the first home of `defineVerbFacet` outside
 * navigation. Decides, per paste, how clipboard content lands in the
 * outline. Plugins contribute:
 *   - `pasteDecisionVerb.impl(fn)`      — replace the decision wholesale,
 *   - `pasteDecisionVerb.decorator(fn)` — wrap it (e.g. rewrite CSV →
 *     markdown then defer to `next`),
 *   - `pasteDecisionVerb.before/after`  — observe pastes.
 * With no contributions, `run` returns `defaultPasteDecision`, so the
 * editor behaves exactly as before the seam existed.
 */
export const pasteDecisionVerb = defineVerbFacet<PasteRequest, PasteDecision>({
  id: 'core.paste-decision',
  defaultImpl: defaultPasteDecision,
})
