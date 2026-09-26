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
import { agree } from '@/utils/pluralize'

/** Which edit to the definition row is being confirmed. They differ in what
 *  they do to the consumers, and the copy has to say so: a rename moves every
 *  cell to a new key and touches no stored text, while the other two re-read
 *  every value under a different codec and can therefore be refused. */
export type DefinitionChangeKind = 'rename' | 'type' | 'options'

export interface ConfirmDefinitionChangeDialogProps {
  kind: DefinitionChangeKind
  /** The name the property answers to NOW — the one the user recognizes, and
   *  the one it still answers to if they cancel. */
  propertyName: string
  /** Rename only: where it is going. */
  nextName?: string
  /** Consuming blocks, counted the way the fan-out finds them
   *  (`repo.countPropertyDefinitionConsumers`) rather than by cell key, so the
   *  number here is the work that follows. */
  blockCount: number
}

/** Roughly what one consumer costs the fan-out, end to end — its cell read,
 *  its field rows, the rewrite.
 *
 *  A single number for a spread of machines and graph shapes, which is why
 *  {@link describeFanoutWait} spends it in buckets and the copy says "around".
 *  It exists because the count alone does not answer the question the user is
 *  actually asking, which is whether to start this now. */
const MILLISECONDS_PER_CONSUMER = 2

const describeFanoutWait = (blockCount: number): string => {
  const seconds = (blockCount * MILLISECONDS_PER_CONSUMER) / 1000
  if (seconds < 15) return 'a few seconds'
  if (seconds < 45) return 'under a minute'
  if (seconds < 150) return 'a minute or two'
  return 'several minutes'
}

const TITLES: Record<DefinitionChangeKind, (name: string, next?: string) => string> = {
  rename: (name, next) => `Rename “${name}” to “${next}”?`,
  type: name => `Change the type of “${name}”?`,
  options: name => `Change the options of “${name}”?`,
}

/** A rename re-spells nothing, so it never reaches this; the other two both
 *  move the codec, but only one of them moves the TYPE — telling a user
 *  adjusting an enum's choices that their values face a "new type" describes
 *  an operation they did not ask for. */
const RE_READ_AS: Record<DefinitionChangeKind, string> = {
  rename: '',
  type: 'under the new type',
  options: 'under the new settings',
}

const CONFIRM_LABELS: Record<DefinitionChangeKind, string> = {
  rename: 'Rename',
  type: 'Change type',
  options: 'Change options',
}

/** Confirmation for a definition change big enough to stop the app.
 *
 *  The fan-out is not a background job and the dialog must not imply one: it
 *  runs in the same transaction as the edit, which is what buys the single
 *  undo step and the ordinary synced rows, and what costs the user every other
 *  write for its duration. So the two things they cannot find out afterwards
 *  are both said here — how long the app is unusable, and that it is one step.
 *
 *  Only the type and options edits mention a refusal. A rename re-spells
 *  nothing, so it cannot fail on a value it could not read; saying it might
 *  would be a warning about something that cannot happen. */
export const ConfirmDefinitionChangeDialog = ({
  kind,
  propertyName,
  nextName,
  blockCount,
  resolve,
  cancel,
}: ConfirmDefinitionChangeDialogProps & DialogContextProps<true>) => (
  <Dialog open onOpenChange={next => { if (!next) cancel() }}>
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{TITLES[kind](propertyName, nextName)}</DialogTitle>
      </DialogHeader>
      {/* `DialogDescription`, not a bare div: it is what Radix points
          `aria-describedby` at, so without it a screen reader announces the
          title and then the buttons — the count, the freeze and the refusal
          are exactly what the user is being asked to consent to, and the
          people who most need them announced were the ones not hearing
          them. */}
      <DialogDescription className="space-y-3 text-sm text-foreground" asChild>
        <div>
        {/* ONE interpolated string rather than a sentence with the count
            spliced in: the number and the wait are the whole message, and JSX
            that splits them into sibling text nodes is a sentence no screen
            reader and no test reads as one. */}
        <p>{`${blockCount.toLocaleString()} `
          + `${agree(blockCount, 'block uses', 'blocks use')} this property, and the change `
          + 'goes through every one of them. That is what makes it a single step you '
          + 'can undo — and it means the app saves nothing else until it finishes, '
          + `which on this many blocks is around ${describeFanoutWait(blockCount)}.`
        }</p>
        <p>
          Your other devices receive the finished blocks the usual way; there
          is nothing to run there. Closing this tab before it saves leaves the
          property exactly as it is now — once it starts saving, it is done.
        </p>
        {kind !== 'rename' && <p>
          Every stored value is re-read {RE_READ_AS[kind]}. If any of them
          cannot be, the whole change is refused and nothing is written.
        </p>}
        </div>
      </DialogDescription>
      <DialogFooter>
        <Button variant="ghost" onClick={() => cancel()}>Cancel</Button>
        <Button onClick={() => resolve(true)}>{CONFIRM_LABELS[kind]}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
)
