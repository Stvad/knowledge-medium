/**
 * What the operator watches while the migration runs.
 *
 * A MODAL, not a toast, and that is the point: the pass rewrites every block's
 * properties against a plan it fixed when it started, and the graph refuses
 * writes for its duration. A toast leaves the app looking editable while every
 * edit is silently refused; this says what is happening and takes the keyboard
 * out of the way until it is over.
 *
 * It is the UI half of a rule the data layer enforces on its own — the commit
 * pipeline's migration lock, which also covers the user's OTHER devices, where
 * no modal of ours is mounted. Neither substitutes for the other.
 */
import { useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { DialogContextProps } from '@/utils/dialogs.js'

export type MigrationProgressState =
  /** The gesture is working. No way out of the dialog in this state. */
  | {kind: 'running'; message: string}
  | {kind: 'done'; message: string}
  | {kind: 'failed'; message: string}

export interface MigrationProgressDialogProps {
  /** Read on every render and on every notification. Returns a STABLE object
   *  while nothing changes and a fresh one when it does — `useSyncExternalStore`
   *  re-renders on the selected value changing, so a store that rebuilt this on
   *  each call would loop and one that mutated in place would never repaint. */
  getState: () => MigrationProgressState
  subscribe: (listener: () => void) => () => void
}

export const MigrationProgressDialog = ({
  getState,
  subscribe,
  resolve,
}: MigrationProgressDialogProps & DialogContextProps<true>) => {
  const state = useSyncExternalStore(subscribe, getState)
  const running = state.kind === 'running'
  return (
    // `open` is fixed, so `onOpenChange` is the ONLY exit — Radix reports
    // Escape, outside-click and the corner button all through it, and none of
    // them can close a controlled dialog on their own. Refusing it while the
    // run has no outcome is therefore the whole block; `hideClose` is about the
    // affordance, so the terminal state offers one way out rather than two.
    <Dialog open onOpenChange={next => { if (!next && !running) resolve(true) }}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>
            {state.kind === 'failed' ? 'Migration stopped' : 'Migrating properties to blocks'}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {running && (
            <div className="flex items-center gap-3">
              <div
                aria-hidden
                className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-foreground"
              />
              <span aria-live="polite">{state.message}</span>
            </div>
          )}
          {!running && (
            <p className={state.kind === 'failed' ? 'text-destructive' : undefined}>
              {state.message}
            </p>
          )}
          {running && (
            <p className="text-muted-foreground">
              This workspace is not accepting edits until it finishes. Leave this tab
              open — closing it is safe, and running the command again on this device
              picks up where it stopped.
            </p>
          )}
        </div>
        {!running && (
          <DialogFooter>
            <Button onClick={() => resolve(true)}>Close</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
