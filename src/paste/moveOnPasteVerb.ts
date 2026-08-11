/**
 * The "does this paste complete a pending cut-as-move?" seam.
 *
 * Core (`cut_selected_blocks` / `cut_block` in `@/shortcuts/defaultShortcuts.js`)
 * marks a cut in `@/utils/pendingMove.js` instead of deleting. Core's paste call
 * sites (the same file's `paste_after_selection` / `paste_before_selection`, and
 * `BlockPasteShellDecorator`) need to ask "is there a still-valid pending move
 * that this paste should complete instead of pasting text?" — but answering
 * that requires `moveBlocksTo` (pruning, ordering, one-undo-step), which lives
 * in the move-blocks PLUGIN (`src/plugins/move-blocks/moveBlocks.ts`). Core
 * cannot import a plugin (`boundary/no-core-to-plugin-imports`), so this verb
 * is the inversion: core declares the seam and calls it by id, the plugin
 * supplies the impl (`src/plugins/move-blocks/pasteAsMoveImpl.ts`). Same shape
 * as `pasteDecisionVerb` / `captureMediaVerb` in this same directory.
 *
 * With no impl installed (the move-blocks plugin is off, or hasn't resolved
 * yet), `defaultImpl` always answers "not a move" — every paste behaves
 * exactly as it did before this seam existed, i.e. an ordinary text paste.
 */
import type { Repo } from '@/data/repo.js'
import type { Block } from '@/data/block.js'
import type { InsertPosition } from '@/data/mutators.js'
import { defineVerbFacet } from '@/facets/verbFacet.js'

/** Where a completed move would land — the same shape as move-blocks'
 *  `MoveTarget`, restated here because `InsertPosition` (the only thing it
 *  actually depends on) is already core (`@/data/mutators.js`). Structurally
 *  identical, so a plugin's `MoveTarget` value is assignable here with no
 *  conversion. */
export interface PasteMoveTarget {
  readonly parentId: string | null
  readonly position: InsertPosition
}

export interface PasteAsMoveInput {
  readonly repo: Repo
  readonly target: PasteMoveTarget
  /** The exact text read off the clipboard for THIS paste — compared
   *  against the register's `clipboardText` to decide validity. */
  readonly clipboardText: string
}

/** `true` ⇒ the paste was consumed as a move (or refused as a would-be
 *  cycle, see `pasteAsMoveImpl`'s doc) — the caller must NOT also do a text
 *  paste. `false` ⇒ not a move (nothing pending, or the register no longer
 *  validates) — the caller falls through to its normal text paste. */
export type PasteAsMoveResult = boolean

export const pasteAsMoveVerb = defineVerbFacet<PasteAsMoveInput, PasteAsMoveResult>({
  id: 'core.paste-as-move',
  defaultImpl: () => false,
  // Effectful (the impl calls `moveBlocksTo`, which writes blocks) — never
  // re-run the harmless default after a partial effect; see verbFacet's
  // onError doc. The impl is expected to handle its OWN failures (toast +
  // clearPendingMove) rather than throw; a throw here means a genuine bug.
  onError: 'rethrow',
})

/** Sibling-insert target anchored on `anchor`: land the pasted/moved
 *  content immediately before or after it, under the same parent. Shared by
 *  every call site so "read the anchor's parentId" isn't re-derived three
 *  ways. */
export const siblingMoveTarget = (
  anchor: Block,
  kind: 'before' | 'after',
): PasteMoveTarget => ({
  parentId: anchor.peek()?.parentId ?? null,
  position: { kind, siblingId: anchor.id },
})

/** Ask the verb whether `clipboardText` completes a pending move at
 *  `target`. `false` whenever there's no live facet runtime yet (very early
 *  boot) or the clipboard text is empty — matches `pasteFromClipboard`'s own
 *  fallback for a runtime-less Repo. */
export const tryPasteAsMove = async (
  repo: Repo,
  target: PasteMoveTarget,
  clipboardText: string,
): Promise<boolean> => {
  const runtime = repo.facetRuntime
  if (!runtime || !clipboardText) return false
  return pasteAsMoveVerb.run(runtime, { repo, target, clipboardText })
}
