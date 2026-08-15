/**
 * The "does this paste complete a pending cut-as-move?" seam.
 *
 * Core (`cut_selected_blocks` / `cut_block` in `@/shortcuts/defaultShortcuts.js`)
 * puts a `intent: 'cut'` payload on the clipboard instead of deleting
 * (`@/paste/clipboardPayload.js`). EVERY paste surface asks "does this
 * clipboard content carry a cut payload I should complete as a move
 * instead of pasting text?" before doing anything else —
 * `defaultShortcuts.js`'s `paste_after_selection` / `paste_before_selection`,
 * `BlockPasteShellDecorator`, `CodeMirrorContentRenderer`'s editor paste, and
 * vim-normal-mode's `paste_after` / `paste_before` all call either
 * `tryPasteAsMove` directly (sibling-only surfaces) or `tryPasteAsMoveAt`
 * (surfaces that need the same 'visible' placement policy an ordinary paste
 * there would use). Answering the question requires `moveBlocksTo` (pruning,
 * ordering, one-undo-step), which lives in the move-blocks PLUGIN
 * (`src/plugins/move-blocks/moveBlocks.ts`). Core cannot import a plugin
 * (`boundary/no-core-to-plugin-imports`), so this verb is the inversion: core
 * declares the seam and calls it by id, the plugin supplies the impl
 * (`src/plugins/move-blocks/pasteAsMoveImpl.ts`). Same shape as
 * `pasteDecisionVerb` / `captureMediaVerb` in this same directory.
 *
 * With no impl installed (the move-blocks plugin is off, or hasn't resolved
 * yet), `defaultImpl` always answers "not a move" — every paste behaves
 * exactly as it did before this seam existed, i.e. an ordinary text paste.
 */
import type { Repo } from '@/data/repo.js'
import type { Block } from '@/data/block.js'
import type { InsertPosition } from '@/data/mutators.js'
import { isCollapsedProp } from '@/data/properties.js'
import { defineVerbFacet } from '@/facets/verbFacet.js'
import type { ClipboardPayload } from '@/paste/clipboardPayload.js'

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
  /** The identity of the blocks on the clipboard, already resolved from
   *  the paste's own content (`resolveClipboardPayload`). Passed IN rather
   *  than looked up here: the caller is the only one holding the paste
   *  event, and the payload is the whole question of validity — a caller
   *  with no payload never reaches the verb at all. */
  readonly payload: ClipboardPayload
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

/** Sibling-insert target anchored on `anchor`: land the moved content
 *  immediately before or after it, under the same parent.
 *
 *  Deliberately NOT exported. It is only ever correct as the FALLBACK
 *  branch of `resolvePasteMoveTarget` below — reaching for it directly is
 *  how the editor surface ended up moving blocks out of the rendered
 *  scope, because a "sibling" of a scope root sits outside the surface
 *  entirely. */
const siblingMoveTarget = (
  anchor: Block,
  kind: 'before' | 'after',
): PasteMoveTarget => ({
  parentId: anchor.peek()?.parentId ?? null,
  position: { kind, siblingId: anchor.id },
})

/** Ask the verb whether `payload` should be completed as a move at
 *  `target`. `false` whenever there's no live facet runtime yet (very early
 *  boot) — matches `pasteFromClipboard`'s own fallback for a runtime-less
 *  Repo — or when the payload came from a COPY rather than a cut.
 *
 *  Note there is no text check here, and nothing to short-circuit on empty
 *  text: the payload either describes this clipboard content or it doesn't,
 *  and `resolveClipboardPayload` already answered that by content. Cutting
 *  a genuinely empty block used to be a special case for exactly this
 *  reason (its sentinel was the empty string, which every emptiness guard
 *  ate); it needs no special handling now. */
export const tryPasteAsMove = async (
  repo: Repo,
  target: PasteMoveTarget,
  payload: ClipboardPayload | null,
): Promise<boolean> => {
  if (!payload || payload.intent !== 'cut') return false
  const runtime = repo.facetRuntime
  if (!runtime) return false
  return pasteAsMoveVerb.run(runtime, { repo, target, payload })
}

/**
 * Where a completed move lands, mirroring `resolveRootDestination`
 * (`@/paste/operations.js`) — the function an ordinary text paste at the
 * same spot goes through. A move that resolves its target differently
 * from the paste it replaces puts the blocks somewhere the user didn't
 * point at, so this is a mirror, not an approximation:
 *
 *   rootsAsChildren = targetIsScopeRoot
 *                  || target.parentId === null
 *                  || (placement === 'visible' && position === 'after'
 *                      && targetHasVisibleChildren)
 *
 * The two ROOT disjuncts hold for BOTH placements, which is the part
 * that's easy to get wrong: a `placement: 'sibling'` caller still gets
 * first-child placement at a scope or workspace root. It has to — a
 * sibling of the render-scope root sits OUTSIDE the rendered surface, so
 * the moved blocks leave the source and never visibly arrive (they read
 * as lost), and a "sibling" of a workspace root is just another root
 * rather than anything the user pointed at. Only the visible-children
 * rule is placement-sensitive.
 *
 * Read-only (no tx) — the caller commits its own transaction
 * (`moveBlocksTo`, inside `pasteAsMoveImpl`) once it has the target.
 */
export const resolvePasteMoveTarget = async (
  target: Block,
  position: 'before' | 'after',
  scopeRootId: string | undefined,
  placement: 'visible' | 'sibling' = 'visible',
): Promise<PasteMoveTarget> => {
  const data = target.peek() ?? await target.load()
  const isWorkspaceRoot = (data?.parentId ?? null) === null
  const targetIsScopeRoot = scopeRootId !== undefined && scopeRootId === target.id

  let rootsAsChildren = targetIsScopeRoot || isWorkspaceRoot
  if (!rootsAsChildren && placement === 'visible' && position === 'after') {
    const isCollapsed = target.peekProperty(isCollapsedProp) ?? false
    rootsAsChildren = !isCollapsed && (await target.childIds.load()).length > 0
  }

  return rootsAsChildren
    ? { parentId: target.id, position: { kind: 'first' } }
    : siblingMoveTarget(target, position)
}

/** Try to complete `payload` as a move at `position` relative to `target`,
 *  using the same placement policy an ordinary paste there would use (see
 *  `resolvePasteMoveTarget`).
 *
 *  Skips resolving the placement (an async children query) entirely when
 *  this paste isn't a cut — the overwhelming majority of pastes — so an
 *  ordinary paste doesn't pay for it. */
export const tryPasteAsMoveAt = async (
  repo: Repo,
  target: Block,
  position: 'before' | 'after',
  scopeRootId: string | undefined,
  payload: ClipboardPayload | null,
  placement: 'visible' | 'sibling' = 'visible',
): Promise<boolean> => {
  if (!payload || payload.intent !== 'cut') return false
  const moveTarget = await resolvePasteMoveTarget(target, position, scopeRootId, placement)
  return tryPasteAsMove(repo, moveTarget, payload)
}
