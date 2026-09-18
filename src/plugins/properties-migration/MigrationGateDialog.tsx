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
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { GraphBackfillClaim } from '@/data/internals/graphBackfillClaim'

/** Whole hours, then whole minutes: the operator is deciding whether a pass
 *  could still be running, and an exact duration says nothing they can use. */
const heldFor = (claimedAt: number, now: number): string => {
  const minutes = Math.max(0, Math.round((now - claimedAt) / 60_000))
  if (minutes < 60) return `${minutes} minute(s)`
  return `${Math.round(minutes / 60)} hour(s)`
}

export type ReleaseOutcome = 'released' | 'not-held' | 'changed'

export interface MigrationGateDialogProps {
  claim: GraphBackfillClaim
  /** What the pass is doing, when it is THIS device running it. `null` on every
   *  other device, which knows the workspace is being converted and not how far
   *  along it is. */
  localMessage: string | null
  /** Clear the claim the user was shown. Resolves `changed` when it is no
   *  longer the claim they consented about. */
  release: (shown: GraphBackfillClaim) => Promise<ReleaseOutcome>
}

export const MigrationGateDialog = ({
  claim, localMessage, release,
}: MigrationGateDialogProps) => {
  // The claim the user is being asked about, SNAPSHOT when they asked — with
  // the clock reading that produced its age. The gap between reading "held for
  // 3 hours" and clicking release is a human pause, and in it the run they were
  // told about can finish and a fresh one take the workspace; deleting THAT is
  // what the warning below says not to do.
  const [confirming, setConfirming] =
    useState<{claim: GraphBackfillClaim; askedAt: number} | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const onRelease = (shown: GraphBackfillClaim) => {
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
      setConfirming(null)
    })
  }

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
              {localMessage ?? 'Another device is converting this workspace.'}
            </span>
          </div>
          <p className="text-muted-foreground">
            Every block&apos;s properties are being rewritten against a plan fixed when
            the run started, so an edit made now may not be converted. This workspace is
            waiting on every device until it finishes.
            {localMessage !== null && (
              <> <strong>Leave this tab open.</strong> Closing it stops the run without
              handing the workspace back.</>
            )}
          </p>
          {problem !== null && <p className="text-destructive">{problem}</p>}
          {confirming !== null && (
            <p className="text-destructive">
              This workspace was claimed {heldFor(confirming.claim.claimedAt, confirming.askedAt)} ago and
              the run has not recorded finishing. Release it only if no device is still
              running the migration: releasing a live claim frees a second device to start
              the same pass over the same blocks.
            </p>
          )}
        </div>
        <DialogFooter>
          {confirming === null
            ? (
              <Button
                variant="ghost" size="sm"
                onClick={() => { setConfirming({claim, askedAt: Date.now()}) }}
              >
                Nothing is running?
              </Button>
            )
            : (
              <>
                <Button
                  variant="ghost" size="sm" disabled={releasing}
                  onClick={() => { setConfirming(null) }}
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
      </DialogContent>
    </Dialog>
  )
}
