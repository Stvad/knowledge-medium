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
import type { AppExtension } from './facet.ts'
import {
  getDialogQueue,
  subscribeDialogs,
} from '@/utils/dialogs.js'

export const DialogHost = () => {
  const queue = useSyncExternalStore(
    subscribeDialogs,
    getDialogQueue,
    getDialogQueue,
  )

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
