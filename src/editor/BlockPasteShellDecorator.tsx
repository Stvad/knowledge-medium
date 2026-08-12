import { useMemo, type ClipboardEvent } from 'react'
import {
  isInteractiveContentEvent,
  type BlockShellDecoratorContribution,
  type BlockShellDecoratorProps,
  type BlockShellState,
} from '@/extensions/blockInteraction.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { focusBlock, isFocusedBlock } from '@/data/properties.js'
import { pasteMultilineText, resolvePasteWithMediaCapture } from '@/paste/operations.js'
import type { PasteRequest } from '@/paste/decision.js'
import { tryPasteAsMoveAt } from '@/paste/moveOnPasteVerb.js'

/**
 * Block-shell paste, as a shell decorator rather than a hardcoded handler on the
 * block wrapper. Contributing `onPaste` here (instead of baking it into
 * `DefaultBlockRenderer`'s shell props) puts paste on the same footing as the
 * other interactions — click (`blockClickHandlersFacet`), selection/focus (their
 * own shell decorators) — so it composes, can be overridden/disabled per the
 * plugin toggle, and keeps the renderer out of the paste/media plumbing.
 *
 * Fires only on the FOCUSED block, NOT in edit mode (the editor owns paste then).
 * Reads live focus at fire time via `isFocusedBlock` (peekProperty) rather than
 * capturing reactive focus, so the closure stays stable.
 */
export function BlockPasteShellDecorator({
  resolveContext,
  state,
  children,
}: BlockShellDecoratorProps) {
  const runtime = useAppRuntime()
  const { block, repo, uiStateBlock, scopeRootId, blockContext } = resolveContext
  const renderScopeId = typeof blockContext?.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : undefined

  const handlePaste = useMemo(
    () => async (e: ClipboardEvent<HTMLElement>) => {
      if (e.defaultPrevented || isInteractiveContentEvent(e)) return
      if (!isFocusedBlock(uiStateBlock, block.id, renderScopeId)) return

      e.preventDefault()
      // File(s) on the clipboard (a pasted image) carry no text/plain — read them
      // before the no-content early return so an image paste isn't dropped.
      const files = e.clipboardData.files
      const fileList = files && files.length > 0 ? Array.from(files) : []
      const pastedText = e.clipboardData.getData('text/plain')

      // Does this paste complete a pending cut→move (`@/utils/pendingMove.js`)?
      // Checked BEFORE the no-content early return below (and before the
      // paste-decision machinery further down): a move relocates the
      // original blocks rather than producing pasted content at all, and
      // must be considered even when `pastedText` is empty — cutting a
      // genuinely empty block records an empty clipboardText too, and
      // gating this on non-empty text would leave that cut marked forever
      // with no paste able to complete it (see `tryPasteAsMove`'s doc).
      // Only the `shell` surface moves — `editor` (BlockPasteShellDecorator
      // never fires there; the CodeMirror paste handler owns that surface)
      // stays text-only, matching `tryPasteAsMove`'s contract everywhere
      // else it's wired in. Uses the SAME visible-placement policy an
      // ordinary paste here would (`tryPasteAsMoveAt`/
      // `resolveVisiblePasteMoveTarget`) — the fallback below
      // (`pasteMultilineText`, default `placement: 'visible'`) would
      // otherwise land the pasted content somewhere different from where
      // the move lands.
      if (await tryPasteAsMoveAt(repo, block, 'after', scopeRootId, pastedText)) {
        return
      }
      if (!pastedText && fileList.length === 0) return

      const html = e.clipboardData.getData('text/html') || undefined

      // Block-shell paste (block focused, NOT in edit mode) has no text caret, so
      // the chord intent is always 'split'. Resolve the decision, capturing any
      // pasted media first (its reference text is spliced in, landing per the text
      // policy — NOT a forced child). `null` ⇒ nothing to paste.
      const request: PasteRequest = { text: pastedText, html, files: fileList, intent: 'split', surface: 'shell' }
      const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId ?? ''
      const resolved = await resolvePasteWithMediaCapture(runtime, request, { repo, workspaceId })
      if (!resolved) return
      const pasted = await pasteMultilineText(resolved.text, block, repo, {
        scopeRootId,
        asSingleBlock: resolved.decision.kind === 'single-block',
      })
      if (pasted[0]) {
        void focusBlock(uiStateBlock, pasted[0].id, { renderScopeId })
      }
    },
    [block, renderScopeId, repo, runtime, scopeRootId, uiStateBlock],
  )

  const nextState = useMemo<BlockShellState>(
    () => ({
      shellProps: {
        ...state.shellProps,
        onPaste: (event) => { void handlePaste(event) },
      },
      shortcutSurfaceOptions: state.shortcutSurfaceOptions,
    }),
    [state, handlePaste],
  )

  return <>{children(nextState)}</>
}

export const blockPasteShellDecorator: BlockShellDecoratorContribution = () =>
  BlockPasteShellDecorator
