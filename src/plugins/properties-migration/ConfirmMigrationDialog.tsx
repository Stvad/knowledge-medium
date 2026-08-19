import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DialogContextProps } from '@/utils/dialogs.js'

export interface ConfirmMigrationDialogProps {
  /** Blocks the pass will visit — the same over-approximating predicate the
   *  pass uses, hence "check" rather than "change". */
  blockCount: number
}

/** Confirmation for the one-time properties migration.
 *
 *  Three things the user cannot find out afterwards, so all three are said
 *  before they commit: it runs here and syncs to their other devices, it takes
 *  a while, and it drops this workspace's undo history. The undo line is the
 *  load-bearing one — clearing it silently is its own surprise, and the
 *  alternative (leaving history that reverts the migration on the next cmd-Z)
 *  is worse.
 *
 *  "On this device" in the interruption line is precise, not filler. Resuming
 *  works because the claimant id is persisted per browser profile
 *  (`resolveClaimantId`), so an interrupted pass is one this device can pick
 *  back up; another device sees a claim it does not own and correctly declines
 *  rather than running a second writer. */
export const ConfirmMigrationDialog = ({
  blockCount,
  resolve,
  cancel,
}: ConfirmMigrationDialogProps & DialogContextProps<true>) => (
  <Dialog open onOpenChange={next => { if (!next) cancel() }}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Migrate properties to blocks</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <p>
          Every property on {blockCount.toLocaleString()} block
          {blockCount === 1 ? '' : 's'} will also be stored as child blocks.
          Existing values are not changed or moved.
        </p>
        <p>
          This runs on this device only — your other devices receive the result
          through sync, so run it in one place. It can take several minutes.
          Interrupting it is safe: reload or close the tab, then run it again
          <em> on this device</em> and it picks up where it stopped.
        </p>
        <p className="text-destructive">
          Undo history for this workspace will be cleared. Undoing an edit made
          before the migration would revert part of it.
        </p>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={cancel}>Cancel</Button>
        <Button onClick={() => resolve(true)}>Migrate</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)
