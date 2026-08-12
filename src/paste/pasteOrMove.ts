/**
 * "Paste here, or complete a pending cut→move here" — the single entry
 * point for the CLIPBOARD-API paste surfaces (vim's `p`/`P`, multi-select
 * `p`/`P`). The DOM-event surfaces (`BlockPasteShellDecorator`,
 * `CodeMirrorContentRenderer`) can't use it: they must read their text off
 * the event's `clipboardData` (which also carries files/HTML) rather than
 * re-reading the clipboard, so they call `tryPasteAsMove*` directly.
 *
 * Exists to make two things impossible to get wrong per call site:
 *
 *  1. **One clipboard read.** `tryPasteAsMove*` and `pasteFromClipboard`
 *     both need the text. Reading twice can disagree (something else got
 *     copied in between), the second read can be refused where the first
 *     wasn't, and on iOS each read can cost its own system paste prompt.
 *
 *  2. **The move target and the text-paste placement agree.** They're
 *     derived from the same `placement` here rather than chosen twice.
 *     Choosing them separately is a live bug, not a tidiness point: a
 *     `sibling` fallback paired with the `visible` move target lands a
 *     completed cut somewhere different from where an ordinary paste at
 *     the same spot goes, and at a scope root the sibling slot can sit
 *     outside the rendered surface entirely — the blocks leave the source
 *     and never visibly arrive.
 */
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { pasteFromClipboard } from '@/paste/operations.js'
import { tryPasteAsMoveAt } from '@/paste/moveOnPasteVerb.js'

export interface PasteOrMoveResult {
  /** A pending cut→move was consumed — completed, or refused as a
   *  would-be cycle (see `pasteAsMoveImpl`). Either way nothing was
   *  pasted and `pasted` is empty. */
  moved: boolean
  /** Blocks created by the text paste. Empty when `moved`. */
  pasted: Block[]
}

export const pasteOrMove = async (
  repo: Repo,
  anchor: Block,
  position: 'before' | 'after',
  {
    placement = 'visible',
    scopeRootId,
  }: {
    /** Matches `PasteOptions.placement` — and is applied to BOTH halves;
     *  see the module doc. */
    placement?: 'visible' | 'sibling'
    scopeRootId?: string
  } = {},
): Promise<PasteOrMoveResult> => {
  const clipboardText = await navigator.clipboard.readText()

  // Asked even when `clipboardText` is empty: cutting a genuinely empty
  // block records an empty sentinel too, and gating on non-empty text
  // would leave that cut marked forever (see `tryPasteAsMove`'s doc).
  // `pasteFromClipboard` keeps its own empty-text bail below.
  const moved = await tryPasteAsMoveAt(
    repo, anchor, position, scopeRootId, clipboardText, placement,
  )
  if (moved) return {moved: true, pasted: []}

  const pasted = await pasteFromClipboard(
    anchor,
    repo,
    {position, placement, scopeRootId},
    clipboardText,
  )
  return {moved: false, pasted}
}
