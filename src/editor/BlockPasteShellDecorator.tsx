import { useMemo, type ClipboardEvent } from 'react'
import {
  isInteractiveContentEvent,
  type BlockShellDecoratorContribution,
  type BlockShellDecoratorProps,
  type BlockShellState,
} from '@/extensions/blockInteraction.js'
import { hasSourceContent } from '@/data/blockTypes'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { focusBlock, isFocusedBlock } from '@/data/properties.js'
import { readClipboardContent } from '@/paste/clipboard.js'
import { pasteArmedCut, pasteResolvedDecision, resolvePasteWithMediaCapture } from '@/paste/operations.js'
import type { PasteRequest } from '@/paste/decision.js'

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
      const content = readClipboardContent(e.clipboardData)
      if (!content) return

      const cutPaste = await pasteArmedCut(content.text, block, repo, { scopeRootId })
      if (cutPaste) {
        if (cutPaste.kind === 'moved' && cutPaste.blocks[0]) {
          void focusBlock(uiStateBlock, cutPaste.blocks[0].id, { renderScopeId })
        }
        return
      }

      // Block-shell paste (block focused, NOT in edit mode) has no text caret, so
      // the chord intent is always 'split'. Resolve the decision, capturing any
      // pasted media first (its reference text is spliced in, landing per the text
      // policy — NOT a forced child). `null` ⇒ nothing to paste.
      //
      // An empty source block takes the clipboard's text whole: parsed as an outline
      // it would keep one line and shred the rest around it, and a captured file's
      // `((id))` would only be text in it. Non-empty source pastes around itself.
      const target = block.peek()
      const wholeIntoEmptySource = target != null && hasSourceContent(target) && target.content === ''
      const request: PasteRequest = wholeIntoEmptySource
        ? { ...content, files: [], intent: 'single-block', surface: 'shell' }
        : { ...content, intent: 'split', surface: 'shell' }
      const workspaceId = target?.workspaceId ?? repo.activeWorkspaceId ?? ''
      const resolved = await resolvePasteWithMediaCapture(runtime, request, { repo, workspaceId })
      if (!resolved) return
      const pasted = await pasteResolvedDecision(resolved, block, repo, { scopeRootId })
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
