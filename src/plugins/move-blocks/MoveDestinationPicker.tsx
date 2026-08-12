/**
 * Picker modal for "move these block(s) to…". Opened via
 * `openDialog(MoveDestinationPicker, {blockIds, workspaceId})` from
 * `move-blocks.move-to` / `multi_select.move-blocks.move-to`.
 *
 * The search UI itself is `BlockSearchPicker` (shared with `MergePicker`);
 * this picker owns only the destination-resolution semantics. It never
 * touches the repo, it just resolves `{destinationId}` back to the
 * action, which runs `moveBlocksTo`. That keeps the mutation (and its
 * undo-group + error handling) in one place instead of split between
 * dialog and action.
 *
 * `excludeBlockIds` for the search is the movers PLUS all of their
 * descendants — offering a destination inside a mover's own subtree
 * would be refused downstream (`core.move` throws `CycleError`), so
 * the picker filters it out up front rather than surface a dead-end
 * result. Descendants are resolved once at open time via
 * `repo.query.subtree`.
 */
import { useEffect, useRef, useState } from 'react'
import { BlockSearchPicker } from '@/components/BlockSearchPicker.tsx'
import { useRepo } from '@/context/repo.js'
import type { DialogContextProps } from '@/utils/dialogs.js'

interface ActiveSession {
  workspaceId: string
  /** Movers plus every one of their descendants — resolved once at
   *  open time so search never offers a destination that `core.move`
   *  would refuse as a cycle. */
  excludeBlockIds: string[]
}

export interface MoveDestinationPickerResult {
  destinationId: string
}

export interface MoveDestinationPickerProps {
  blockIds: readonly string[]
  workspaceId: string
}

export function MoveDestinationPicker({
  blockIds,
  workspaceId,
  resolve,
  cancel,
}: DialogContextProps<MoveDestinationPickerResult> & MoveDestinationPickerProps) {
  const repo = useRepo()

  const [session, setSession] = useState<ActiveSession | null>(null)

  // The finalize callbacks are fresh closures from the DialogHost on
  // each of its renders; read them through a ref so the load effect can
  // bail without depending on (and re-running for) their identity.
  const cancelRef = useRef(cancel)
  useEffect(() => {
    cancelRef.current = cancel
  })

  // Resolve the movers' combined subtree once on mount so the exclude
  // set is stable for the life of the dialog.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (blockIds.length === 0) {
        cancelRef.current()
        return
      }
      // Structural (not visible-outline) subtree: excluding a destination
      // is a correctness concern (avoiding `core.move`'s `CycleError`),
      // so a descendant hidden behind property-field machinery must be
      // excluded too, not just what the outline renders.
      const subtrees = await Promise.all(
        blockIds.map(id => repo.query.subtree({id, hidePropertyChildren: false}).load()),
      )
      if (cancelled) return
      const excludeBlockIds = new Set<string>(blockIds)
      for (const rows of subtrees) {
        for (const row of rows) excludeBlockIds.add(row.id)
      }
      setSession({
        workspaceId,
        excludeBlockIds: Array.from(excludeBlockIds),
      })
    })()
    return () => { cancelled = true }
  }, [repo, blockIds, workspaceId])

  const commit = (destinationId: string): void => {
    if (!session) return
    resolve({destinationId})
  }

  // Unlike the other openDialog dialogs (which render with a bare
  // `open`), this one gates its very rendering on `session` — the async
  // subtree resolution that decides the exclude set — so the picker
  // doesn't flash before it's known.
  if (!session) return null

  const count = blockIds.length
  const title = count > 1 ? `Move ${count} blocks to…` : 'Move this block to…'

  return (
    <BlockSearchPicker
      title={title}
      description="The moved block(s) land as the last children of whatever you pick here."
      placeholder="Find destination…"
      workspaceId={session.workspaceId}
      excludeBlockIds={session.excludeBlockIds}
      onSelect={commit}
      onCancel={cancel}
    />
  )
}
