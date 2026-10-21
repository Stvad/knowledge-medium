/**
 * What every device shows while the cell-to-children pass holds this
 * workspace's claim.
 *
 * A MODAL, and that is the whole rule: the pass rewrites every block's
 * properties against a plan it fixed when it started, so an edit made behind it
 * is converted under a plan that no longer describes it. One thing to do — wait
 * — said once, in place of a guard per gesture (#1057).
 *
 * It cannot be enforced against a client that ignores it, and nothing in a
 * multi-client last-write-wins graph could be. What it buys is that the user is
 * not typing into an app that is quietly converting underneath them, and what
 * it costs when someone types anyway is small: past the flip a live write emits
 * the cell AND its children in one transaction, so a record written during the
 * run is born in the new shape.
 *
 * Except cmd-Z, which a modal cannot cover — the shortcut resolver keeps a
 * `global` carve-out so app-wide chords stay reachable while a modal is up, and
 * undo is registered there. A replay restores a whole pre-migration row over
 * children the pass has since written. The history drop its mount holds is what
 * closes that, and is the reason this is a mount rather than a dialog the
 * gesture opens.
 *
 * ONE paragraph that holds in every state, plus one line for the tab that is
 * running the pass. Copy that varies per state is copy somebody has to keep
 * true per state, and the claim cannot say WHICH device is running it anyway —
 * a claimant id is a browser profile (km-ij26).
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { GraphBackfillClaim } from '@/data/internals/graphBackfillClaim'
import { useModalShadowing } from '@/shortcuts/useActionContext.js'

export type ReleaseOutcome = 'released' | 'not-held' | 'changed'

/** Who is running the pass, relative to the tab reading this — see `holderOf`.
 *
 *  `this-tab` is this tab's own gesture, whether it is still preflighting,
 *  holding the claim, or has lost it. One arm for the three because the tab is
 *  owed the same thing in each — leave it open, reload it if it looks stuck —
 *  and it carries the progress line because it is the only arm that HAS one.
 *
 *  `running` is a claim held by a run this tab is not driving. It carries the
 *  claim because the release acts on one, which keeps "may release" and "has
 *  something to release" the same fact rather than two props that can disagree. */
export type ClaimHolder =
  | {kind: 'this-tab'; message: string}
  | {kind: 'running'; claim: GraphBackfillClaim}

/** Identity of a claim for the purposes of "is this still the same situation".
 *  Claimant plus the instant it was taken: a re-claim by the same device after a
 *  release is a different situation with the same claimant. */
const claimKey = (claim: GraphBackfillClaim): string =>
  `${claim.claimantId}:${claim.claimedAt}`

export interface MigrationGateDialogProps {
  holder: ClaimHolder
  /** Clear the claim the user was shown. Resolves `changed` when it is no
   *  longer the claim they consented about.
   *
   *  `null` where this device may not write at all: the release is a
   *  `BlockDefault` transaction like any other, so on a read-only workspace the
   *  button could only ever produce the read-only error. Saying who CAN release
   *  is the useful thing to do with that space. */
  release: ((shown: GraphBackfillClaim) => Promise<ReleaseOutcome>) | null
}

export const MigrationGateDialog = ({holder, release}: MigrationGateDialogProps) => {
  // The claim the user is being asked about, SNAPSHOT when they asked. The gap
  // between asking and answering is a human pause, and in it the run they were
  // told about can finish and a fresh one take the workspace; deleting THAT is
  // what the warning below says not to do.
  const [pending, setPending] = useState<{claim: GraphBackfillClaim; of: string} | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // WHAT was dismissed, not merely that something was. The escape is offered
  // only to a device that can do nothing about the claim, so a dismissal must
  // not outlive that: a viewer who hides the modal and is then granted write
  // access is the device that could release a stranded claim, and would
  // otherwise stay blind to it for the rest of the run.
  const [dismissed, setDismissed] = useState<string | null>(null)

  // The release is for a claim nobody will release, so the tab that is RUNNING
  // is not offered it: releasing from there drops the modal and the undo pause
  // while its own writes continue.
  const canRelease = holder.kind === 'running' ? holder : null
  const current = canRelease === null ? null : claimKey(canRelease.claim)
  // The state a dismissal is ABOUT — `null` where there is nothing to dismiss,
  // because this device CAN act on the claim. A new claim, a change of arm, or
  // being granted write access are each a different situation the user has not
  // dismissed; the last one matters most, since it turns this device into the
  // one that could release a stranded claim.
  const dismissKey = release !== null ? null : `${holder.kind}:${current ?? ''}`
  const hidden = dismissKey !== null && dismissed === dismissKey

  // Consent is about ONE claim. DERIVED rather than reset in an effect: a claim
  // replaced underneath the panel simply stops being current, so there is no
  // frame in which "Release the claim" is armed against a claim the user was
  // never shown. The release re-checks inside its own transaction and answers
  // `changed` either way; this is about not leaving the button armed.
  const confirming = pending !== null && pending.of === current ? pending : null

  // Follows the dialog: dismissing releases the shadow along with the modal it
  // was shadowing for. See useModalShadowing's docstring for why it is needed.
  useModalShadowing(!hidden)

  const onRelease = (shown: GraphBackfillClaim) => {
    if (release === null) return
    setReleasing(true)
    setProblem(null)
    release(shown).then(outcome => {
      // `released` and `not-held` both end with nothing holding the workspace,
      // and this dialog is unmounted by the claim clearing rather than by
      // anything here — so neither has a message to leave behind.
      if (outcome === 'changed') {
        setProblem('Not released: the claim changed while this was open, so the migration '
          + 'holding this workspace is no longer the one you were shown. Ask again to see '
          + 'what holds it now.')
      }
    }).catch((err: unknown) => {
      console.error('[properties-migration] could not release the claim:', err)
      setProblem('Could not release the claim: '
        + `${err instanceof Error ? err.message : String(err)}`)
    }).finally(() => {
      setReleasing(false)
      setPending(null)
    })
  }

  if (hidden) return null
  return (
    // `open` is fixed and `onOpenChange` does nothing: Radix routes Escape,
    // outside-click and the corner button all through it and can close none of
    // them itself, so ignoring it is the whole block. `hideClose` is the
    // affordance to match.
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>Migrating properties to blocks</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
            />
            <span aria-live="polite">
              {holder.kind === 'this-tab'
                ? holder.message
                : 'A migration is converting this workspace.'}
            </span>
          </div>
          <DialogDescription>
            This workspace is being converted to property blocks. Every block&apos;s
            properties are rewritten against a plan fixed when the run started, so an
            edit made now may not be converted, and undo is paused here until it
            finishes.
          </DialogDescription>
          {problem !== null && <p className="text-destructive" role="alert">{problem}</p>}
          {/* The tab that IS running is not offered the release below, so this
              is its only way out: a run whose promise never settles would
              otherwise leave it behind a modal with no exit at all, reading
              copy that tells it not to close. */}
          {holder.kind === 'this-tab' && (
            <p className="text-muted-foreground">
              <strong>Leave this tab open.</strong> Closing it stops the run without
              handing the workspace back. If it looks stuck, reload it — the migration
              resumes where it stopped when you run it again, and a reloaded tab is
              offered the option to release the claim.
            </p>
          )}
          {confirming !== null && (
            <p className="text-destructive" role="alert">
              The run holding this workspace has not recorded finishing. Release it only
              if no device is still running the migration: releasing a live claim frees a
              second device to start the same pass over the same blocks.
            </p>
          )}
          {release === null && (
            <p className="text-muted-foreground">
              This workspace is read-only here, so only someone who can write to it
              can release the claim.
            </p>
          )}
        </div>
        {/* A device that may not write can neither release the claim nor be the
            one holding it, so a modal it cannot dismiss is a workspace it cannot
            use — and the gate mount is `essential`, so safe mode and the
            settings toggle are no longer escapes either. Dismissing hides only
            the DIALOG; the undo pause lives in the mount above and keeps
            running, which is the half that protects rows. */}
        {release === null && (
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => { setDismissed(dismissKey) }}>
              Hide this
            </Button>
          </DialogFooter>
        )}
        {canRelease !== null && release !== null && (
        <DialogFooter>
          {confirming === null
            ? (
              <Button
                variant="ghost" size="sm"
                onClick={() => { setPending({claim: canRelease.claim, of: current!}) }}
              >
                Nothing is running?
              </Button>
            )
            : (
              <>
                <Button
                  variant="ghost" size="sm" disabled={releasing}
                  onClick={() => { setPending(null) }}
                >
                  Keep waiting
                </Button>
                <Button
                  variant="destructive" size="sm" disabled={releasing}
                  onClick={() => { onRelease(confirming.claim) }}
                >
                  Release the claim
                </Button>
              </>
            )}
        </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
