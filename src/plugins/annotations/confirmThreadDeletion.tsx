import type {Block} from '@/data/block'
import {Button} from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {BACKLINKS_FOR_BLOCK_QUERY} from '@/plugins/backlinks/query.js'
import {openDialog, type DialogContextProps} from '@/utils/dialogs.js'
import {agree, pluralize} from '@/utils/pluralize'

const ConfirmDeleteQuotedThreadDialog = ({count, resolve, cancel}: {count: number} & DialogContextProps<true>) => (
  <Dialog open onOpenChange={next => { if (!next) cancel() }}>
    <DialogContent className="max-w-sm">
      <DialogHeader>
        <DialogTitle>Delete the thread?</DialogTitle>
      </DialogHeader>
      <DialogDescription>
        This is the thread’s last comment, so the thread goes with it. It is quoted in {pluralize(count, 'block')},
        {' '}and {agree(count, 'that quote becomes', 'those quotes become')} plain text.
      </DialogDescription>
      <DialogFooter>
        <Button variant="outline" onClick={cancel}>Cancel</Button>
        <Button variant="destructive" onClick={() => resolve(true)}>Delete</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)

/** May the card delete `thread`? Deleting a quoted thread inlines its quote
 *  into every quoter as plain text, so that asks first. */
export const confirmThreadDeletion = async (thread: Block): Promise<boolean> => {
  const data = await thread.load()
  if (!data) return true
  const quoters = await thread.repo.query[BACKLINKS_FOR_BLOCK_QUERY]({workspaceId: data.workspaceId, id: thread.id}).load()
  if (quoters.length === 0) return true
  return await openDialog(ConfirmDeleteQuotedThreadDialog, {count: quoters.length}) === true
}
