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
import { useState, type ReactNode } from 'react'
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

/** Whole hours, then whole minutes, and never rounded UP: the operator is
 *  deciding whether a pass could still be running, so an age that overstates
 *  argues for killing a live run. `claimedAt` is the CLAIMING device's clock and
 *  there is no server one, so a claim from a device running ahead of this one
 *  produces a negative age — reported as what it is rather than clamped to
 *  "0 minute(s) ago". */
const heldFor = (claimedAt: number, now: number): string => {
  const minutes = Math.floor((now - claimedAt) / 60_000)
  // A MINUTE of tolerance, not zero: two devices' `Date.now()` are independent,
  // so a fresh claim from one running a few seconds ahead is ordinary, and
  // calling that a clock fault would fire on about half of all live claims.
  if (now - claimedAt < -60_000) {
    return 'at a time this device reads as the future — its clock is ahead'
  }
  if (minutes < 0) return 'less than a minute ago'
  if (minutes < 60) return `at least ${minutes} minute(s) ago`
  return `at least ${Math.floor(minutes / 60)} hour(s) ago`
}

export type ReleaseOutcome = 'released' | 'not-held' | 'changed'

/** Who is running the pass, relative to the tab reading this — see `holderOf`.
 *
 *  `starting` is this tab's own gesture before its claim exists; the claim is
 *  written after several preflight reads, and with nothing on screen for that
 *  window the operator has just confirmed a one-way flip into silence.
 *
 *  `this-tab` carries the progress line because only that arm HAS one: a
 *  claimant id is a browser PROFILE, so a sibling tab's run is indistinguishable
 *  from this one by the claim alone, and what separates them is whether this tab
 *  is the one reporting. Carrying the message in the arm rather than beside it
 *  is what stops the two from being read independently and disagreeing. */
export type ClaimHolder =
  | {kind: 'starting'; message: string}
  /** This tab WAS running the pass and the claim is now GONE — released from
   *  somewhere, or completed. Distinct from `starting` because the two look
   *  identical in the claim row and owe the user opposite things. */
  | {kind: 'lost-claim'; message: string}
  /** This tab WAS running the pass and another client's claim is live in its
   *  place. Separate from `lost-claim` because a claim IS held: undo is paused
   *  again, the graph is being rewritten by someone else right now, and telling
   *  this tab that undo is live and another device "may" start a run would be
   *  false on both counts. Carries the claim so the shared "a claim is held"
   *  sentence renders. */
  | {kind: 'superseded'; message: string; claim: GraphBackfillClaim}
  | {kind: 'this-tab'; message: string; claim: GraphBackfillClaim}
  // The two arms that may release, and the two that carry a claim to release.
  // Same list by construction rather than by agreement between two props.
  | {kind: 'this-browser'; claim: GraphBackfillClaim}
  | {kind: 'another-device'; claim: GraphBackfillClaim}

/** Identity of a claim for the purposes of "is this still the same situation".
 *  Claimant plus the instant it was taken: a re-claim by the same device after a
 *  release is a different situation with the same claimant. */
const claimKey = (claim: GraphBackfillClaim): string =>
  `${claim.claimantId}:${claim.claimedAt}`

/** What the spinner line says: this tab's own progress where it has some, and
 *  what the claim says otherwise. The two are exclusive by construction — see
 *  `ArmCopy`. */
const statusLine = (holder: ClaimHolder): string =>
  'message' in holder ? holder.message : (COPY[holder.kind] as {status: string}).status

/** The arms a stranded claim can be released from. */
type ReleasableHolder = Extract<ClaimHolder, {kind: 'this-browser' | 'another-device'}>
const releasable = (holder: ClaimHolder): ReleasableHolder | null =>
  holder.kind === 'this-browser' || holder.kind === 'another-device' ? holder : null

/** True of exactly the arms that CARRY a claim, which is the same fact: the
 *  history pause follows the claim, so this sentence is as true as
 *  `'claim' in holder`. Rendered off that narrowing rather than pasted into each
 *  arm, so a new arm gets it if and only if it carries a claim — the compiler
 *  decides, not whoever writes the next arm's copy. */
const UNDER_A_CLAIM = <>Every block&apos;s properties are being rewritten against
  a plan fixed when the run started, so an edit made now may not be converted, and
  undo is paused here until it finishes.{' '}</>

/** What a device that only WATCHED the run is owed afterwards: its own
 *  pre-migration entries are still replayable over rows the run rewrote.
 *  Shared by the two arms whose exposure is identical — a sibling tab of this
 *  browser keeps its stacks exactly as a peer does. */
const STALE_UNDO = <>Reload this tab afterwards: undo entries from before the
  migration are not cleared here, and replaying one can revert part of it.</>

/** An arm that carries a `message` shows it in the status line, so a `status`
 *  on such an arm could never be read — the type says which arms may have one
 *  rather than leaving it to whoever adds the next. */
type ArmCopy<K extends ClaimHolder['kind']> =
  Extract<ClaimHolder, {kind: K}> extends {message: string}
    ? {body: ReactNode}
    : {status: string; body: ReactNode}

/** Every arm's copy in full, rather than one paragraph plus fragments that
 *  switch on the arm.
 *
 *  TOTAL on purpose. A shared sentence is a sentence somebody has to check
 *  against every state. Written out per arm, a sentence can only be wrong
 *  about the one state it is under. */
const COPY: {[K in ClaimHolder['kind']]: ArmCopy<K>} = {
  'starting': {
    body: <>Checking whether this workspace can be converted. Nothing has been
      written yet.</>,
  },
  'lost-claim': {
    body: <>This tab no longer holds the migration — it was released, or the run
      finished. Anything still in flight here is no longer protected: undo is live
      again on every device, and another device is free to start its own run.{' '}
      <strong>Reload this tab.</strong></>,
  },
  'superseded': {
    body: <>Another client has taken over the migration — this tab was running it
      and no longer holds the claim. Anything it wrote after losing the claim is
      outside both runs&apos; plans, and the run that holds the workspace now did
      not start from where this one stopped. <strong>Reload this tab.</strong></>,
  },
  'this-tab': {
    body: <>Undo history for this workspace will be cleared as soon as the run
      writes anything. <strong>Leave this tab open.</strong> Closing it stops the
      run without handing the workspace back.</>,
  },
  'this-browser': {
    status: 'This browser profile holds the migration.',
    body: <>If another tab of this browser is still running it, let that tab
      finish; if a run here stopped without handing the workspace back, it needs
      releasing. {STALE_UNDO}</>,
  },
  'another-device': {
    status: 'Another device is converting this workspace.',
    body: <>{STALE_UNDO}</>,
  },
}

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
  // The claim the user is being asked about, SNAPSHOT when they asked — with
  // the clock reading that produced its age. The gap between reading "held for
  // 3 hours" and clicking release is a human pause, and in it the run they were
  // told about can finish and a fresh one take the workspace; deleting THAT is
  // what the warning below says not to do.
  const [pending, setPending] =
    useState<{claim: GraphBackfillClaim; askedAt: number; of: string} | null>(null)
  const [releasing, setReleasing] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  // WHAT was dismissed, not merely that something was. The escape is offered
  // only to a device that can do nothing about the claim, so a dismissal must
  // not outlive that: a viewer who hides the modal and is then granted write
  // access is the device that could release a stranded claim, and would
  // otherwise stay blind to it for the rest of the run.
  const [dismissed, setDismissed] = useState<string | null>(null)

  // The release is for a claim nobody will release. Neither the tab running the
  // pass nor one whose claim does not exist yet can be in that situation, and
  // releasing from the running tab drops the modal and the undo pause while its
  // own writes continue.
  const canRelease = releasable(holder)
  // The state a dismissal is ABOUT — `null` where there is nothing to dismiss,
  // because this device CAN act on the claim. A new claim, a change of arm, or
  // being granted write access are each a different situation the user has not
  // dismissed; the last one matters most, since it turns this device into the
  // one that could release a stranded claim.
  const dismissKey = release !== null
    ? null
    : `${holder.kind}:${canRelease === null ? '' : claimKey(canRelease.claim)}`
  const hidden = dismissKey !== null && dismissed === dismissKey

  // The panel is about ONE claim and says how long that claim has been held, so
  // a claim replaced underneath it would keep a stale age on screen — and a
  // stale age is the argument FOR releasing. DERIVED rather than reset in an
  // effect: the panel simply stops being current, with no frame showing the old
  // one. Consent itself is already safe — the release re-checks inside its own
  // transaction and answers `changed`; this is about not showing a reason that
  // has stopped being true.
  const current = canRelease === null ? null : claimKey(canRelease.claim)
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
            <span aria-live="polite">{statusLine(holder)}</span>
          </div>
          <DialogDescription>
            {'claim' in holder && UNDER_A_CLAIM}{COPY[holder.kind].body}
          </DialogDescription>
          {problem !== null && <p className="text-destructive" role="alert">{problem}</p>}
          {/* The way out for the tab that IS running, which is not offered the
              release below: a run whose promise never settles would otherwise
              leave this tab behind a modal with no exit at all, reading copy
              that tells it not to close. Reloading makes it an ordinary tab
              again, and the release comes back with it. */}
          {holder.kind === 'this-tab' && (
            <p className="text-muted-foreground">
              If this tab looks stuck, reload it. The migration resumes where it
              stopped when you run it again, and a reloaded tab is offered the
              option to release the claim.
            </p>
          )}
          {canRelease !== null && confirming !== null && (
            <p className="text-destructive" role="alert">
              This workspace was claimed {heldFor(confirming.claim.claimedAt, confirming.askedAt)} and
              the run has not recorded finishing. Release it only if no device is still
              running the migration: releasing a live claim frees a second device to start
              the same pass over the same blocks.
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
                onClick={() => {
                  setPending({claim: canRelease.claim, askedAt: Date.now(), of: current!})
                }}
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

/** Test-only: the age string is the one thing here a user acts on destructively,
 *  and driving it through a claim row and a suspending render to assert on a
 *  sentence would pin the harness rather than the arithmetic. */
export const __heldForTest = heldFor
