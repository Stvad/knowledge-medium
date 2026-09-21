/**
 * What the tab shows while a property-definition change rewrites its
 * consumers.
 *
 * A MODAL, for the same reason the migration gate is one and not the same
 * reason the app is unusable: the fan-out holds the single SQLite writer for
 * its whole duration, so every edit made behind it queues rather than lands.
 * Typing into an outliner that silently accepts nothing for a minute is worse
 * than being told to wait — the user consented to this wait a dialog ago, and
 * this is the other half of that promise.
 *
 * DETERMINATE where it can be. The run opens before the transaction does, so
 * there is a stretch with no count yet, and another after the last consumer
 * while the commit and the post-commit walk finish; both are real parts of the
 * wait and neither is measured, so they say so rather than parking the bar at
 * a number that has stopped moving.
 *
 * No escape and no cancel. A transaction in flight cannot be handed back
 * halfway — there is nothing here for a button to do that closing the tab
 * does not already do, which rolls the change back whole.
 */
import { useCallback, useSyncExternalStore } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  propertyDefinitionFanoutFor,
  subscribePropertyDefinitionFanout,
  type PropertyDefinitionFanoutSnapshot,
} from '@/data/propertyDefinitionFanout.js'
import { useActiveWorkspaceId } from '@/hooks/useWorkspaces.js'
import { useModalShadowing } from '@/shortcuts/useActionContext.js'
import { appMountsFacet } from './core.ts'
import type { AppExtension } from '@/facets/facet.js'

/** Progress as a percentage, or `null` while the wait is one of the two
 *  unmeasured stretches. `total` of 0 is not reachable through the gesture
 *  (the threshold is in the thousands) but would divide by zero here. */
const percentDone = (run: PropertyDefinitionFanoutSnapshot): number | null => {
  if (run.done === null || run.total <= 0) return null
  return Math.min(100, Math.round((run.done / run.total) * 100))
}

const statusLine = (run: PropertyDefinitionFanoutSnapshot): string => {
  if (run.done === null) return 'Starting…'
  if (run.done >= run.total) return 'Saving the change…'
  return `${run.done.toLocaleString()} of ${run.total.toLocaleString()} blocks updated`
}

export const DefinitionFanoutProgress = () => {
  const workspaceId = useActiveWorkspaceId()
  const read = useCallback(
    () => propertyDefinitionFanoutFor(workspaceId), [workspaceId],
  )
  const run = useSyncExternalStore(subscribePropertyDefinitionFanout, read, read)
  return run === null ? null : <FanoutProgressDialog run={run} />
}

/** Split from the mount so the shortcut-shadowing hook — which suspends on the
 *  workspace's UI-state block, and throws this mount away if that read fails —
 *  is only reached while a run is actually up. Nothing else rides on this
 *  mount, so losing it costs the modal and nothing more. */
const FanoutProgressDialog = ({run}: {run: PropertyDefinitionFanoutSnapshot}) => {
  // While this is up the surface underneath must stop claiming keys, and
  // releasing the shadow is this component's job because nothing else knows
  // the modal went away.
  useModalShadowing(true)
  const percent = percentDone(run)
  return (
    // `open` fixed and `onOpenChange` inert: Escape, outside-click and the
    // corner button all route through it and none of them may close this.
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>Updating blocks that use “{run.propertyName}”</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div
            className="h-2 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={run.total}
            aria-valuenow={run.done ?? undefined}
            aria-label={`Blocks updated for ${run.propertyName}`}
          >
            <div
              className={`h-full rounded-full bg-foreground${
                percent === null ? ' w-1/4 animate-pulse' : ''}`}
              style={percent === null ? undefined : {width: `${percent}%`}}
            />
          </div>
          <p aria-live="polite">{statusLine(run)}</p>
          <DialogDescription>
            This change and every block it touches are saved together, so it
            stays one step you can undo — and nothing else can be saved until
            it finishes. Closing this tab now leaves the property as it was.
          </DialogDescription>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export const definitionFanoutAppMountExtension: AppExtension = [
  appMountsFacet.of(
    {id: 'core.definition-fanout-progress', component: DefinitionFanoutProgress},
    {source: 'core'},
  ),
]
