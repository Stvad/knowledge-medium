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

export interface ConfirmMigrationDialogProps {
  /** Blocks the pass will visit — the same over-approximating predicate the
   *  pass uses, hence "check" rather than "change". */
  blockCount: number
  /** Already reads properties from child blocks, so the gesture backfills alone
   *  instead of switching the workspace over first — two materially different
   *  things to consent to. */
  childBacked: boolean
  /** Keys nothing declares, which the gesture will give a definition before it
   *  migrates anything (§9). Named here because it is the one part that
   *  invents something rather than moving what is already there. */
  synthesizedKeys: number
  /** Keys no definition can ever carry, or that this device will not mint for.
   *  On an un-flipped workspace the gesture refuses before reaching the dialog,
   *  so seeing a number here means the workspace is already flipped. */
  unfixableKeys: number
  /** Keys whose definition block exists but is BROKEN — usually a preset from
   *  an extension that is not loaded on this device, in which case the
   *  definition is fine and enabling the provider fixes it. Kept separate from
   *  `unfixableKeys` because calling a repairable problem permanent on a
   *  one-way consent screen is how the one cheap moment to repair it is
   *  missed. */
  repairableKeys: number
}

/** Confirmation for the one-time properties migration.
 *
 *  Three things the user cannot find out afterwards, so all three are said
 *  before they commit: it runs here and syncs to their other devices, it takes
 *  a while, and it drops this workspace's undo history. The undo line is the
 *  load-bearing one — clearing it silently is its own surprise, and the
 *  alternative (leaving history that reverts the migration on the next cmd-Z)
 *  is worse. It says "on this device" and asks for a reload because the clear
 *  reaches no peer (#684): an undo stack is in-memory, and a reload is the only
 *  thing that empties one on a device that stayed open across the switch.
 *
 *  "On this device" in the interruption line is precise, not filler. Resuming
 *  works because the claimant id is persisted per browser profile
 *  (`getClientId`), so an interrupted pass is one this device can pick
 *  back up; another device sees a claim it does not own and correctly declines
 *  rather than running a second writer. */
export const ConfirmMigrationDialog = ({
  blockCount,
  childBacked,
  synthesizedKeys,
  unfixableKeys,
  repairableKeys,
  resolve,
  cancel,
}: ConfirmMigrationDialogProps & DialogContextProps<true>) => {
  const blocks = pluralize(blockCount, 'block')
  const properties = (n: number) => pluralize(n, 'property', 'properties')
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
        </p>
        {synthesizedKeys > 0 && <p>
          {properties(synthesizedKeys)} in this workspace {agree(synthesizedKeys, 'has', 'have')}
          {' '}no definition — written by an importer, a raw write, or a plugin that is no
          longer installed. They get one created for them first, with a type guessed
          from the values already stored, and it shows up in the property panel so you can
          check the guess. Nothing you can see changes; without it those
          properties could never move.{' '}
          <strong>If a plugin or extension owns any of them, install or enable it before you
          run this</strong> — though that only helps for an owner that declares the property
          as a schema block; one declaring it in code alone stays invisible here. Creating a definition here claims the name: re-enabling the owner
          afterwards leaves two definitions competing, or — for an extension that declares
          properties in code rather than as blocks — makes its writes start failing. Run{' '}
          <code>audit-properties</code> first if you are not sure who wrote them.
        </p>}
        {repairableKeys > 0 && <p className="text-destructive">
          {properties(repairableKeys)} {agree(repairableKeys, 'has', 'have')} a definition
          this device cannot read — most often one whose type comes from an extension that
          is not enabled here, in which case enabling it is the whole fix. Repair
          {' '}{agree(repairableKeys, 'it', 'them')} first if you can: migrating now leaves
          {' '}{agree(repairableKeys, 'it', 'them')} behind, and this is the cheap moment.
          Run <code>audit-properties</code> to see which.
        </p>}
        {unfixableKeys > 0 && <p>
          {properties(unfixableKeys)} cannot be given a definition at all and will stay as
          {' '}{agree(unfixableKeys, 'it is', 'they are')}. Run{' '}
          <code>audit-properties</code> to see which and why.
        </p>}
        <p>
          {!childBacked && <>The switch applies to everyone in the workspace, so
            every device should be online and caught up before you start — a
            device that is offline with an unsent property edit uploads it into a
            workspace that has moved on, and that edit is lost. Nothing here can
            check that for you.{' '}</>}
          This runs on this device only — your other devices receive the result
          through sync, so run it in one place. It can take several minutes.
          Interrupting it is safe: reload or close the tab, then run it again
          <em> on this device</em> and it picks up where it stopped.
        </p>
        <p className="text-destructive">
          {!childBacked && <>The switch cannot be undone from the app — it only ever
            moves forward, and reversing it is a hand-run database migration.{' '}</>}
          Undo history for this workspace will be cleared on this device — undoing
          an edit made before the migration would revert part of it. A device that
          stays open while it runs keeps its own, so reload your other tabs and
          devices afterwards.
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
