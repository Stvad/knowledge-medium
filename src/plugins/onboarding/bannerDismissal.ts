/**
 * "Has the user retired the tutorial nudge?" — a per-DEVICE localStorage
 * marker, the same shape as the birthday overlay's one-shot flag.
 *
 * Deliberately NOT a synced `ChangeScope.UserPrefs` property: the banner
 * hangs off the daily-note header, which every session renders on the
 * startup path, and `usePluginPrefsProperty` resolves its prefs block via
 * `use()` — i.e. a suspending read added to first paint, for a signal whose
 * only job is to hide a first-run nudge. The cost of getting it wrong is
 * that the banner shows once more on a second device, where one click
 * retires it again.
 *
 * Backed by a SUBSCRIBABLE store, not a bare module flag. Neither
 * `localStorage` nor a plain variable notifies anyone, so with two panels
 * focused on the same daily note — or the same note open twice — dismissing
 * in one left the other on screen, still offering to dismiss again. The store
 * is the app's blessed mechanism for exactly this (`createToggleStore`, over
 * `CallbackSet`), so all mounted banners retire together.
 *
 * Cross-TAB sync is deliberately not attempted: no `storage` listener, so a
 * second tab keeps its banner until reload. One click there retires it again,
 * which is the same cost the per-device decision above already accepts.
 */
import { useSyncExternalStore } from 'react'
import { createToggleStore } from '@/utils/toggleStore.js'

const DISMISSED_KEY = 'onboarding:tutorial-banner-dismissed'

const readStoredDismissal = (): boolean => {
  try {
    return window.localStorage?.getItem(DISMISSED_KEY) === 'true'
  } catch {
    // Private-mode / blocked storage: show the banner rather than swallow it.
    return false
  }
}

/** `isOpen()` reads "dismissed". Seeded from storage at module load, which is
 *  also what makes the store the single source of truth afterwards — nothing
 *  re-reads `localStorage` per render. */
const dismissalStore = createToggleStore('tutorial-banner-dismissed')
dismissalStore.set(readStoredDismissal())

export const isTutorialBannerDismissed = (): boolean => dismissalStore.isOpen()

/** Reactive read for the banner. Every mounted instance re-renders on
 *  dismissal, so they disappear together. */
export const useTutorialBannerDismissed = (): boolean =>
  useSyncExternalStore(dismissalStore.subscribe, dismissalStore.isOpen, dismissalStore.isOpen)

export const dismissTutorialBanner = (): void => {
  // Flipped BEFORE the write, so a throwing setItem still retires the banner
  // for this page session (and across every mounted instance) rather than
  // leaving Dismiss with no visible effect at all.
  dismissalStore.set(true)
  try {
    window.localStorage?.setItem(DISMISSED_KEY, 'true')
  } catch {
    /* ignore — the store is the fallback */
  }
}

/** Test seam, mirroring `resetConsistencyAuditStore`. Without it a dismissal
 *  in one test leaks into the next. */
export const resetTutorialBannerDismissal = (): void => {
  dismissalStore.set(false)
}
