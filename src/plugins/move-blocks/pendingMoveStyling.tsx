/**
 * Dims a block while it's marked for a pending cut→move.
 *
 * This is the ONLY feedback a cut gives. Cut deliberately doesn't delete
 * (an un-pasted cut must lose nothing — see `pasteAsMoveImpl.ts`), so
 * without a visual mark the user presses ⌘X and *nothing observable
 * happens at all*: the block stays exactly where it was. That's worse
 * than the destructive behaviour it replaced, so the mark has to be
 * reliable rather than best-effort.
 *
 * Hence a shell DECORATOR and not `blockTextClassFacet`. Class-facet
 * contributions are plain `(ctx) => string | null` functions and can't
 * call hooks, so they can only read the register non-reactively — the
 * mark then appears whenever the row happens to re-render next, which
 * for a single-block normal-mode cut is "not until something unrelated
 * changes". Measured: it never appeared at all. A decorator renders a
 * real component, so it can subscribe via `usePendingMoveIds` and repaint
 * the instant the register changes.
 */
import { useMemo } from 'react'
import type {
  BlockShellDecoratorContribution,
  BlockShellDecoratorProps,
} from '@/extensions/blockInteraction.js'
import { getPendingMove, usePendingMoveIds } from '@/utils/pendingMove.js'

export function PendingMoveShellDecorator({
  resolveContext,
  state,
  children,
}: BlockShellDecoratorProps) {
  const { block, repo } = resolveContext
  const pendingIds = usePendingMoveIds()
  // `usePendingMoveIds` is the reactive subscription (ids only); the
  // workspace it belongs to comes off the same store, read in the same
  // render, so it can't disagree with the ids we just subscribed to.
  const pendingWorkspaceId = pendingIds ? getPendingMove()?.workspaceId : undefined

  const nextState = useMemo(() => {
    if (!pendingIds?.has(block.id)) return state
    // A pending move never applies across workspaces — `core.move` can't
    // change `workspace_id` at all — so don't mark a block just because
    // another workspace has a cut outstanding.
    if (pendingWorkspaceId !== repo.activeWorkspaceId) return state
    return {
      ...state,
      shellProps: {
        ...state.shellProps,
        className: `${state.shellProps.className ?? ''} opacity-50`.trim(),
        // Lets the state be asserted on without depending on a utility
        // class, and gives the user's own CSS something stable to hook.
        'data-pending-move': 'true',
      },
    }
  }, [pendingIds, pendingWorkspaceId, block.id, state, repo])

  return <>{children(nextState)}</>
}

export const pendingMoveStyling: BlockShellDecoratorContribution = () =>
  PendingMoveShellDecorator
