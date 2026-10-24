/**
 * This tab's side of a deploy: whether a newer build is downloading or has
 * already taken over, and the one reload that moves the tab onto it.
 *
 * `ready` means the build this tab runs is no longer the one being served.
 * The new service worker controls every open tab from the moment it activates
 * (src/sw/sw.ts), so a module this tab imports after that comes from the newer
 * build's cache, and the newer build may change the local database. The tab
 * therefore reloads at the first moment that loses nothing — no input in
 * progress, no write in flight — and every open tab does the same, because
 * activation reaches them all at once. Set by registerServiceWorker; read by
 * the update prompt (toast) and the status chip.
 */
import { useSyncExternalStore } from 'react'
import { CallbackSet } from '@/utils/callbackSet.js'

export type AppUpdatePhase = 'current' | 'downloading' | 'ready'

/** How often a deferred reload re-checks whether it is safe yet. */
export const RELOAD_POLL_MS = 250

/** True while reloading could throw away input the user has not committed:
 *  editors commit on a debounce, and a form's fields may live only in component
 *  state until it is submitted — still so after focus moves on to its Save
 *  button, or out of a dialog's field. Not covered: a draft left in an input
 *  outside any form or dialog once focus has left it. */
export const hasInputInProgress = (doc: Document): boolean => {
  if (doc.querySelector('[role="dialog"], [role="alertdialog"]')) return true
  const el = doc.activeElement
  if (!(el instanceof HTMLElement)) return false
  return el.isContentEditable || el.matches('input, textarea, select') || el.closest('form') !== null
}

export interface AppUpdateDeps {
  reload: () => void
  isEditing: () => boolean
}

export const createAppUpdate = ({reload, isEditing}: AppUpdateDeps) => {
  let phase: AppUpdatePhase = 'current'
  const listeners = new CallbackSet('appUpdate')
  // eslint-disable-next-line callback-set/prefer-callback-set -- predicates the reload polls, not listeners it notifies
  const busyChecks = new Set<() => boolean>()
  let pending: {requested: boolean, poll: ReturnType<typeof setInterval>} | null = null

  const setPhase = (next: AppUpdatePhase): void => {
    if (phase === next) return
    phase = next
    listeners.notify()
  }

  const attempt = (): void => {
    if (!pending) return
    if (!pending.requested && isEditing()) return
    for (const busy of busyChecks) if (busy()) return
    clearInterval(pending.poll)
    pending = null
    reload()
  }

  // `requested`: the user asked, so editing no longer defers it — a write
  // still in flight does.
  const scheduleReload = (requested: boolean): void => {
    if (pending) pending.requested ||= requested
    else pending = {requested, poll: setInterval(attempt, RELOAD_POLL_MS)}
    attempt()
  }

  return {
    phase: (): AppUpdatePhase => phase,
    subscribe: (listener: () => void): (() => void) => listeners.add(listener),
    markDownloading(): void {
      if (phase === 'current') setPhase('downloading')
    },
    markDownloadFailed(): void {
      if (phase === 'downloading') setPhase('current')
    },
    /** A newer build took over this tab's service worker. */
    markReady(): void {
      setPhase('ready')
      scheduleReload(false)
    },
    reload(): void {
      scheduleReload(true)
    },
    /** `busy` returns true while a reload would lose work (a write in flight).
     *  Returns the removal. */
    addBusyCheck(busy: () => boolean): () => void {
      busyChecks.add(busy)
      return () => busyChecks.delete(busy)
    },
  }
}

export type AppUpdate = ReturnType<typeof createAppUpdate>

export const appUpdate: AppUpdate = createAppUpdate({
  reload: () => window.location.reload(),
  isEditing: () => hasInputInProgress(document),
})

/** Reactive read of {@link AppUpdate.phase} for components (toast, status chip). */
export const useAppUpdatePhase = (): AppUpdatePhase =>
  useSyncExternalStore(appUpdate.subscribe, appUpdate.phase, () => 'current')
