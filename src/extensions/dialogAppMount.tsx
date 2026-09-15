/**
 * App-mount contribution that hosts dialogs opened via
 * `utils/dialogs.openDialog`.
 *
 * Mounted once via `appMountsFacet`. Subscribes to the module-level
 * dialog queue, renders each pending entry, and threads the host's
 * finalize callback into the entry's `resolve` / `cancel` props.
 *
 * Same placement story as `toastAppMount`: dialogs surfaced before
 * the runtime is up wouldn't render here — those callers should
 * fall back to a built-in confirm / alert. Anything that runs from
 * an action handler, post-commit processor, or user-initiated UI
 * path happens after the runtime mounts and lands here cleanly.
 */
import { useSyncExternalStore } from 'react'
import { appMountsFacet } from './core.ts'
import type { AppExtension } from '@/facets/facet.js'
import {
  getDialogQueue,
  subscribeDialogs,
} from '@/utils/dialogs.js'
import { useActionContext } from '@/shortcuts/useActionContext.js'
import { ActionContextTypes } from '@/shortcuts/types.js'

/** The context carries no actions, so it needs nothing beyond what
 *  `useActionContext` supplies itself. Hoisted for a stable identity. */
const NO_DEPS = {}

export const DialogHost = () => {
  const queue = useSyncExternalStore(
    subscribeDialogs,
    getDialogQueue,
    getDialogQueue,
  )

  // Modal while anything is open, so the surface underneath stops claiming
  // keys meant for the dialog — Enter on a confirm button would otherwise still
  // match the editor's split binding, which keeps its context active behind the
  // modal. One activation here rather than per dialog: every `openDialog`
  // caller has the same exposure and none of them should have to know it.
  useActionContext(ActionContextTypes.DIALOG, NO_DEPS, queue.length > 0)

  return (
    <>
      {queue.map(entry => {
        const Component = entry.Component
        return (
          <Component
            key={entry.id}
            {...entry.props}
            resolve={(value: unknown) => entry.finalize(value)}
            cancel={() => entry.finalize(null)}
          />
        )
      })}
    </>
  )
}

export const dialogAppMountExtension: AppExtension = [
  appMountsFacet.of(
    {id: 'core.dialogs', component: DialogHost},
    {source: 'core'},
  ),
]
