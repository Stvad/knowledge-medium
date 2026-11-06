/** Which version of a document the viewer has let run, on this device. Local on
 *  purpose: anywhere synced, the people it guards against could write it. */

import {CallbackSet} from '@/utils/callbackSet'

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

/** Blocked storage reads as no consent, which holds the document. */
export const readConsent = (blockId: string): string | null => {
  try {
    return localStorage.getItem(keyFor(blockId))
  } catch {
    return null
  }
}

export const grantConsent = (blockId: string, sourceHash: string): void => {
  try {
    localStorage.setItem(keyFor(blockId), sourceHash)
  } catch {
    return
  }
  listeners.notify()
}

export const revokeConsent = (blockId: string): void => {
  try {
    localStorage.removeItem(keyFor(blockId))
  } catch {
    return
  }
  listeners.notify()
}
