/** Which version of a document the viewer has let run, on this device. Local on
 *  purpose: anywhere synced, the people it guards against could write it. */

import {CallbackSet} from '@/utils/callbackSet'
import {clientLocalSettings} from '@/utils/ClientLocalSettings.js'

const keyFor = (blockId: string): string => `km.html-document.scripts-allowed.${blockId}`

const listeners = new CallbackSet('html-document script consent')

/** The storage event is another tab's Run or Stop; Stop has to reach a document
 *  running there too. */
export const subscribeToConsent = (listener: () => void): (() => void) => {
  const unsubscribe = listeners.add(listener)
  window.addEventListener('storage', listener)
  return () => {
    unsubscribe()
    window.removeEventListener('storage', listener)
  }
}

/** Empty when nothing is allowed or storage is blocked, which matches no hash. */
export const readConsent = (blockId: string): string => clientLocalSettings.getString(keyFor(blockId))

export const grantConsent = (blockId: string, sourceHash: string): void => {
  clientLocalSettings.setString(keyFor(blockId), sourceHash)
  listeners.notify()
}

export const revokeConsent = (blockId: string): void => {
  clientLocalSettings.remove(keyFor(blockId))
  listeners.notify()
}
