import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
    {describeNames(keys.names, keys.count)}
  </span>
)

/** Consent for a workspace-wide migration. Resume and undo instructions name
 *  this device because claims and undo history are device-local. */
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
    <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md flex-col gap-0 overflow-hidden p-0">
      <DialogHeader className="shrink-0 border-b px-5 py-4 pr-12">
        <DialogTitle>Migrate properties to blocks</DialogTitle>
        <DialogDescription className="sr-only">
          Review the migration effects and device warnings before continuing.
        </DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-3 overflow-y-auto overscroll-contain px-5 py-4 text-sm" tabIndex={0}>
        <p>
          {childBacked
            ? <>Scan {blocks} with properties and create any missing child blocks.
                Existing child blocks and values stay unchanged.</>
            : <>Switch this workspace to properties stored as child blocks, then
                scan {blocks} with properties to create missing child blocks for
                registered values. Existing values stay intact.</>}
        </p>
        {synthesizedKeys.count > 0 && <p>
          {properties(synthesizedKeys.count)} {agree(synthesizedKeys.count, 'has', 'have')}
          {' '}no definition. The migration will infer a type for each from stored
          values and show it in the property panel for review. <strong>Check for an owning
          plugin or extension first.</strong> Enabling it helps only if it
          registers a schema block; code-only declarations remain invisible even
          when enabled. A new definition can conflict with that owner or make
          its writes fail. <code className="whitespace-nowrap">audit-properties</code>
          {' '}lists unresolved keys but cannot identify code-only owners.
          <KeyNames keys={synthesizedKeys} />
        </p>}
        {repairableKeys.count > 0 && <p className="text-destructive">
          {properties(repairableKeys.count)} {agree(repairableKeys.count, 'has', 'have')}
          {' '}a definition this device cannot read, often because an extension is
          disabled. Enable or repair it first; these properties will be skipped.
          <KeyNames keys={repairableKeys} />
        </p>}
        {undecodableValueKeys.count > 0 && <p className="text-destructive">
          Across {properties(undecodableValueKeys.count)},
          {' '}{pluralize(undecodableValueKeys.cells, 'stored property value')}
          {' '}{agree(undecodableValueKeys.cells, 'does', 'do')} not match
          {' '}{agree(undecodableValueKeys.count, 'its', 'their')} declared
          {' '}{agree(undecodableValueKeys.count, 'type', 'types')} and will be
          skipped. Fix the values or types, then run this again.
          <KeyNames keys={undecodableValueKeys} />
        </p>}
        {stranded !== null && <p>
          {properties(stranded.count)} {agree(stranded.count, 'has', 'have')} no definition
          and this device cannot create one: {stranded.reason}. Fix this and run
          the migration again; these properties will be skipped for now.
          <KeyNames keys={stranded} />
        </p>}
        {unfixableKeys.count > 0 && <p>
          {properties(unfixableKeys.count)} cannot be given a definition and will
          stay as {agree(unfixableKeys.count, 'it is', 'they are')}. Run{' '}
          <code className="whitespace-nowrap">audit-properties</code> for details.
          <KeyNames keys={unfixableKeys} />
        </p>}
        <div className="space-y-1.5 border-t pt-3">
          <p className="font-medium">Before you migrate</p>
          <ul className="list-disc space-y-1.5 pl-5">
            {!childBacked && <li>
              Bring every device online and fully synced. Offline, unsent property
              edits can be lost after the switch. The switch cannot be undone in
              the app.
            </li>}
            <li>
              Run this on one device; results sync to the others. It may take a
              while. If interrupted, run it again <em>on this device</em> to
              resume; other devices wait until then.
            </li>
            <li>
              Once this writes, this device’s workspace undo history is cleared.
              Undo is paused everywhere while it runs. Reload other tabs and
              devices afterwards to clear their undo history.
            </li>
          </ul>
        </div>
      </div>
      <DialogFooter className="shrink-0 flex-row justify-end gap-2 border-t px-5 py-4">
        <Button variant="outline" onClick={cancel}>Cancel</Button>
        <Button onClick={() => resolve(true)}>Migrate</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  )
}
