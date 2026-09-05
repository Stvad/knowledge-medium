/*
 * What the RUNNING loop knows about itself, in memory.
 *
 * The persisted status cannot answer "is this device still mirroring?" in the
 * one case that matters most: when the thing that failed is the store. A run
 * that cannot read its own settings cannot record that it could not — the
 * write goes through the same broken store — so the last good record stands
 * and the health chip goes on reporting a mirror that stopped. That is exactly
 * the silent failure the chip exists to prevent, so it needs a channel that
 * does not depend on storage.
 *
 * Deliberately NOT persisted: a reload starts clean, because a failure no run
 * has met since is not a failure. The persisted `lastError` is the one that
 * survives a session, and the diagnostic prefers it when both are present.
 */
import {CallbackSet} from '@/utils/callbackSet.js'

let failure: string | undefined
const listeners = new CallbackSet('db-mirror-runtime')

export const dbMirrorRuntimeHealth = {
  /** The last tick's failure, or undefined when one got through. */
  getSnapshot: (): string | undefined => failure,
  subscribe: (listener: () => void): (() => void) => listeners.add(listener),
  /** Every tick reports: the message when it threw, `undefined` when it did
   *  not. Reporting the unchanged value notifies nobody, so a loop that fails
   *  the same way every five minutes does not re-render the chip. */
  report: (message: string | undefined): void => {
    if (failure === message) return
    failure = message
    listeners.notify()
  },
}
