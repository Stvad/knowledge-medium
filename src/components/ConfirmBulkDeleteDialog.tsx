import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DialogContextProps } from '@/utils/dialogs.js'
import { agree, pluralize } from '@/utils/pluralize'

export interface ConfirmBulkDeleteDialogProps {
  /** Blocks the gesture names — the selection, or the one block a key was
   *  pressed on. */
  targetCount: number
  /** Blocks the delete actually removes: the targets plus everything nested
   *  under them. Always >= `targetCount`, and the number that decides whether
   *  this dialog opens at all. */
  totalCount: number
}

/** Confirmation for a delete large enough to be worth a second look.
 *
 *  The two numbers are both shown because they can differ by a lot: one
 *  collapsed page is a single target whose delete removes hundreds of blocks,
 *  and that gap is exactly what the user cannot see at the moment they press
 *  the key. */
export const ConfirmBulkDeleteDialog = ({
  targetCount,
  totalCount,
  resolve,
  cancel,
}: ConfirmBulkDeleteDialogProps & DialogContextProps<true>) => {
  const nested = totalCount - targetCount
  return (
    <Dialog open onOpenChange={next => { if (!next) cancel() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Delete {pluralize(totalCount, 'block')}?</DialogTitle>
        </DialogHeader>
        <p className="text-sm">
          {targetCount === 1 ? 'This block' : pluralize(targetCount, 'selected block')}
          {nested > 0 && <> and the {pluralize(nested, 'block')} nested
            {' '}{agree(targetCount, 'under it', 'under them')}</>}
          {' '}will be deleted.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>Cancel</Button>
          <Button variant="destructive" onClick={() => resolve(true)}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
