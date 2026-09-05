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
import { recallPayloadForText } from '@/paste/clipboardPayload.js'

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

  // This is a KEYBOARD-driven paste — a bare `p` fires no paste event, so
  // there is no `DataTransfer` and no flavors, only text. That's exactly
  // what the content-keyed table in `@/paste/clipboardPayload.js` is for,
  // and why `navigator.clipboard.read()` isn't used here: it isn't
  // supported everywhere, and a move that worked in some browsers and not
  // others is worse than one resolution path that works in all of them.
  //
  // Asked even when `clipboardText` is empty — cutting a genuinely empty
  // block leaves empty text, and gating on non-empty text would make that
  // cut un-completable from this surface. `pasteFromClipboard` keeps its
  // own empty-text bail below.
  // The table is the only reader available here: a bare keypress fires no
  // paste event, so there are no flavors to read. See
  // `@/paste/clipboardPayload.js` on why event surfaces use the other one.
  const payload = recallPayloadForText(clipboardText)
  const outcome = await tryPasteAsMoveAt(
    repo, anchor, position, scopeRootId, payload, placement,
  )
  // A refusal is consumed but changed nothing, so it must NOT report
  // `moved` — callers use that to decide whether to clear the user's
  // selection, and clearing it after a refusal takes away the range they
  // need in order to retry somewhere valid.
  if (outcome !== 'not-a-move') return {moved: outcome === 'moved', pasted: []}

  const pasted = await pasteFromClipboard(
    anchor,
    repo,
    {position, placement, scopeRootId},
    clipboardText,
  )
  return {moved: false, pasted}
}
