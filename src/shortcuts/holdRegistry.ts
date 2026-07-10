/**
 * Registry of currently-ARMED hold bindings (a `phase: 'hold'` chord whose
 * keydown started its timer but which hasn't fired or been cancelled yet).
 *
 * Exists for keyboard-capture surfaces (shortcut-help's inspector) that
 * swallow key events wholesale while open: swallowing the keyup would
 * otherwise defeat the hold observer's cancel-on-release, letting a timer
 * armed BEFORE the surface opened fire an action while it's up. Such a
 * surface calls `cancelArmedHolds()` when it takes over the keyboard.
 *
 * The reconciler's `installHoldBinding` registers each armed press and
 * unregisters it on cancel/fire, so the set only ever holds in-flight
 * timers. Backed by `CallbackSet` so one throwing cancel can't strand the
 * remaining armed holds mid-fan-out.
 */
import { CallbackSet } from '@/utils/callbackSet'

const armed = new CallbackSet('armed-holds')

/** Track an armed hold's cancel. Returns the matching unregister. */
export const registerArmedHold = (cancel: () => void): (() => void) =>
  armed.add(cancel)

/** Cancel every armed (not yet fired) hold binding. */
export const cancelArmedHolds = (): void => {
  armed.notify()
}
