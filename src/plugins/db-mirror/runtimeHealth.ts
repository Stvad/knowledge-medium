/*
 * What the RUNNING loop knows about itself, in memory.
 *
 * The persisted status cannot answer "is this device still mirroring?" when the
 * thing that failed is the store: a run that cannot read its own settings
 * cannot record that it could not, because the write goes through the same
 * broken store, so the last good record stands and the chip reports a mirror
 * that stopped.
 *
 * It covers a store that breaks AFTER a successful load, not one broken from
 * boot — with no snapshot the chip cannot know whether the user ever opted in,
 * and warning them about a feature they never turned on is worse than silence.
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
   *  not. The equality check is de-duplication only — it changes what listeners
   *  see, never what `getSnapshot` answers — so that a loop failing the same
   *  way every five minutes does not re-render the chip. */
  report: (message: string | undefined): void => {
    if (failure === message) return
    failure = message
    listeners.notify()
  },
}
