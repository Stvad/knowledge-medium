/**
 * This tab's side of a deploy: whether a newer build is downloading or has
 * already taken over, and the reload that moves the tab onto it.
 *
 * `ready` means the build this tab runs is no longer the one being served.
 * The new service worker controls every open tab from the moment it activates
 * (src/sw/sw.ts), so a module this tab imports after that comes from the newer
 * build's cache. We prompt rather than reload on our own; until the tab
 * reloads, the newer build's tabs keep off the local database
 * (src/data/localDbBuildGate.ts). Set by registerServiceWorker; read by the
 * update prompt (toast) and the status chip.
 */
import { useSyncExternalStore } from 'react'
import { CallbackSet } from '@/utils/callbackSet.js'

export type AppUpdatePhase = 'current' | 'downloading' | 'ready'

/** How often a requested reload re-checks whether a write still holds it. */
export const RELOAD_POLL_MS = 250

export interface AppUpdateDeps {
  reload: () => void
}

export const createAppUpdate = ({reload}: AppUpdateDeps) => {
  let phase: AppUpdatePhase = 'current'
  const listeners = new CallbackSet('appUpdate')
  // eslint-disable-next-line callback-set/prefer-callback-set -- predicates the reload polls, not listeners it notifies
  const busyChecks = new Set<() => boolean>()
  let poll: ReturnType<typeof setInterval> | null = null

  const setPhase = (next: AppUpdatePhase): void => {
    if (phase === next) return
    phase = next
    listeners.notify()
  }

  const attempt = (): void => {
    for (const busy of busyChecks) if (busy()) return
    if (poll !== null) clearInterval(poll)
    poll = null
    reload()
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
    },
    /** Reload once no write is in flight: an unload mid-transaction drops it. */
    reload(): void {
      if (poll !== null) return
      poll = setInterval(attempt, RELOAD_POLL_MS)
      attempt()
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
})

/** Reactive read of {@link AppUpdate.phase} for components (toast, status chip). */
export const useAppUpdatePhase = (): AppUpdatePhase =>
  useSyncExternalStore(appUpdate.subscribe, appUpdate.phase, () => 'current')
