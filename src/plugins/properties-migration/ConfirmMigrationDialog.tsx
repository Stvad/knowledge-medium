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
  /** Already reads properties from child blocks, so the gesture backfills alone
   *  instead of switching the workspace over first — two materially different
   *  things to consent to. */
  childBacked: boolean
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
 *  (`getClientId`), so an interrupted pass is one this device can pick
 *  back up; another device sees a claim it does not own and correctly declines
 *  rather than running a second writer. */
export const ConfirmMigrationDialog = ({
  blockCount,
  childBacked,
  resolve,
  cancel,
}: ConfirmMigrationDialogProps & DialogContextProps<true>) => {
  const blocks = `${blockCount.toLocaleString()} block${blockCount === 1 ? '' : 's'}`
  return (
  <Dialog open onOpenChange={next => { if (!next) cancel() }}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>Migrate properties to blocks</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        <p>
          {childBacked
            ? <>This workspace already reads properties from child blocks.
                Properties written before that have none yet; this fills them in
                across {blocks}, and leaves every value already stored as a block
                exactly as it is.</>
            : <>This switches the workspace over to storing properties as child
                blocks, then gives every <em>registered</em> property on {blocks}
                {' '}the blocks it implies. Existing values are not changed or moved,
                and a property with no blocks yet keeps being read from where it
                is now — so the switch itself changes nothing you can see.</>}
          {' '}A key no schema declares is skipped and stays cell-only — run{' '}
          <code>audit-properties</code> to find those.
        </p>
        <p>
          {!childBacked && 'The switch applies to everyone in the workspace. '}
          This runs on this device only — your other devices receive the result
          through sync, so run it in one place. It can take several minutes.
          Interrupting it is safe: reload or close the tab, then run it again
          <em> on this device</em> and it picks up where it stopped.
        </p>
        <p className="text-destructive">
          {!childBacked && <>The switch cannot be undone from the app — it only ever
            moves forward, and reversing it is a hand-run database migration.{' '}</>}
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
}
