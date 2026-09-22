import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DialogContextProps } from '@/utils/dialogs.js'
import { describeNames } from '@/utils/nameList'
import { agree, pluralize } from '@/utils/pluralize'

/** A category of property key this screen reports.
 *
 *  Named and not merely counted: this asks consent for a one-way, fleet-wide
 *  change, and a bare "N keys cannot be migrated" leaves `audit-properties` as
 *  the only way to find out which ones — which is exactly the moment the
 *  operator has no reason to go looking. */
export interface NamedPropertyKeys {
  /** Exact, workspace-wide. */
  count: number
  /** The first few keys, capped by the caller. `count` stays exact, so the
   *  copy can say how many are not named. */
  names: readonly string[]
}

export interface ConfirmMigrationDialogProps {
  /** Blocks the pass will VISIT — the same over-approximating predicate the
   *  pass uses, which selects every block carrying a property and cannot tell
   *  which of them still owe children (only the JS registry can answer that).
   *  So the copy must never spend it as a promise of work: on a re-run of a
   *  finished migration this is the whole candidate set and the pass writes
   *  nothing. */
  blockCount: number
  /** Already reads properties from child blocks, so the gesture backfills alone
   *  instead of switching the workspace over first — two materially different
   *  things to consent to. */
  childBacked: boolean
  /** Keys nothing declares, which the gesture will give a definition before it
   *  migrates anything (§9). Named here because it is the one part that
   *  invents something rather than moving what is already there. */
  synthesizedKeys: NamedPropertyKeys
  /** Keys no definition can ever carry. On an un-flipped workspace the gesture
   *  refuses before reaching the dialog, so seeing a number here means the
   *  workspace is already flipped. */
  unfixableKeys: NamedPropertyKeys
  /** Keys that COULD be defined but that this DEVICE will not mint for, with
   *  the reason — which is a fact about the device, not about the key. Kept
   *  apart from `unfixableKeys` for the reason `repairableKeys` is: the repair
   *  is real and cheap, and filing it under "cannot be defined at all" is how
   *  it is missed. Null when this device will mint. */
  stranded: (NamedPropertyKeys & {reason: string}) | null
  /** Keys whose definition block exists but is BROKEN — usually a preset from
   *  an extension that is not loaded on this device, in which case the
   *  definition is fine and enabling the provider fixes it. Kept separate from
   *  `unfixableKeys` because calling a repairable problem permanent on a
   *  one-way consent screen is how the one cheap moment to repair it is
   *  missed. */
  repairableKeys: NamedPropertyKeys
  /** Keys whose DEFINITION is fine and whose stored VALUES disagree with it —
   *  the class `audit-properties` cannot see, because the key resolves and only
   *  its cells do not. On an un-flipped workspace the gesture refuses before
   *  reaching the dialog, so a number here means the workspace is already
   *  flipped. Carries the CELL count as well: the repair is per key, and the
   *  scale that decides whether it is worth doing now is per value. */
  undecodableValueKeys: NamedPropertyKeys & {cells: number}
}

/** The keys behind the count just given. Subordinate to it on purpose: the
 *  count is what the consent decision turns on, and a screen that opens with a
 *  list of property names is one nobody finishes reading. Quoted (through
 *  {@link describeNames}) because a property key may contain a comma. */
const KeyNames = ({keys}: {keys: NamedPropertyKeys}) => (
  <span className="mt-1 block font-mono text-xs text-muted-foreground">
    {describeNames(keys.names, keys.count)}
  </span>
)

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
  stranded,
  repairableKeys,
  undecodableValueKeys,
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
                Properties written before that have none yet; this goes through
                {' '}{blocks} — every block carrying a property, however much of it is
                already done — and fills in what is missing, leaving every value
                already stored as a block exactly as it is.</>
            : <>This switches the workspace over to storing properties as child
                blocks, then gives every <em>registered</em> property on {blocks}
                {' '}the blocks it implies. Existing values are not changed or moved,
                and a property with no blocks yet keeps being read from where it
                is now — so the switch itself changes nothing you can see.</>}
        </p>
        {synthesizedKeys.count > 0 && <p>
          {properties(synthesizedKeys.count)} in this workspace
          {' '}{agree(synthesizedKeys.count, 'has', 'have')}
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
          <KeyNames keys={synthesizedKeys} />
        </p>}
        {repairableKeys.count > 0 && <p className="text-destructive">
          {properties(repairableKeys.count)} {agree(repairableKeys.count, 'has', 'have')} a
          definition this device cannot read — most often one whose type comes from an
          extension that is not enabled here, in which case enabling it is the whole fix.
          Repair {agree(repairableKeys.count, 'it', 'them')} first if you can: migrating now
          leaves {agree(repairableKeys.count, 'it', 'them')} behind, and this is the cheap
          moment.
          <KeyNames keys={repairableKeys} />
        </p>}
        {undecodableValueKeys.count > 0 && <p className="text-destructive">
          {pluralize(undecodableValueKeys.cells, 'stored property value')} across
          {' '}{properties(undecodableValueKeys.count)} cannot be stored as blocks — the
          value does not match the type its property declares. Nothing here changes
          {' '}{agree(undecodableValueKeys.cells, 'it', 'them')}, and nothing later will:
          fix the value or the declared type and run this again.
          <KeyNames keys={undecodableValueKeys} />
        </p>}
        {stranded !== null && <p>
          {properties(stranded.count)} {agree(stranded.count, 'has', 'have')} no definition
          and this device will not create one — {stranded.reason}. Nothing here changes
          {' '}{agree(stranded.count, 'it', 'them')}; fix that and run this again to bring
          {' '}{agree(stranded.count, 'it', 'them')} along.
          <KeyNames keys={stranded} />
        </p>}
        {unfixableKeys.count > 0 && <p>
          {properties(unfixableKeys.count)} cannot be given a definition at all and will stay
          as {agree(unfixableKeys.count, 'it is', 'they are')}. Run{' '}
          <code>audit-properties</code> to see why.
          <KeyNames keys={unfixableKeys} />
        </p>}
        <p>
          {!childBacked && <>The switch applies to everyone in the workspace, so
            every device should be online and caught up before you start — a
            device that is offline with an unsent property edit uploads it into a
            workspace that has moved on, and that edit is lost. Nothing here can
            check that for you.{' '}</>}
          This runs on this device only — your other devices receive the result
          through sync, so run it in one place. It can take several minutes, and
          while it runs every device holds a dialog asking you to wait.
          Interrupting it loses no data: run it again <em>on this device</em> and it
          picks up where it stopped. But every device keeps waiting until you do —
          an interrupted run does not hand the workspace back, and that dialog is
          where you release it.
        </p>
        <p className="text-destructive">
          {!childBacked && <>The switch cannot be undone from the app — it only ever
            moves forward, and reversing it is a hand-run database migration.{' '}</>}
          Undo history for this workspace will be cleared on this device once this
          writes anything — undoing an edit made before the migration would revert
          part of it. Undo is paused
          everywhere while it runs, but a device that stays open keeps its own
          history, so reload your other tabs and devices afterwards.
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
