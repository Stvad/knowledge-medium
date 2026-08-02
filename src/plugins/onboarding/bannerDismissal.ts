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
 */
const DISMISSED_KEY = 'onboarding:tutorial-banner-dismissed'

/** Set on every dismissal, whether or not it reached storage.
 *
 *  The banner's own `useState` cannot serve as the fallback: it is per-MOUNT,
 *  and the banner unmounts as soon as you navigate to another daily note. So
 *  where `localStorage` is blocked (private mode, storage policy), a
 *  component-state-only fallback means Dismiss appears to work and then the
 *  prompt returns on the next note — indistinguishable from the button being
 *  broken. Module scope degrades that to "dismissed until reload" instead. */
let dismissedThisSession = false

export const isTutorialBannerDismissed = (): boolean => {
  if (dismissedThisSession) return true
  try {
    return window.localStorage?.getItem(DISMISSED_KEY) === 'true'
  } catch {
    // Private-mode / blocked storage: show the banner rather than swallow it.
    return false
  }
}

export const dismissTutorialBanner = (): void => {
  // Before the write, so a throwing setItem still retires it for this page
  // session rather than leaving Dismiss with no effect at all.
  dismissedThisSession = true
  try {
    window.localStorage?.setItem(DISMISSED_KEY, 'true')
  } catch {
    /* ignore — `dismissedThisSession` is the fallback */
  }
}

/** Test seam for the module-scope flag, mirroring `resetConsistencyAuditStore`.
 *  Without it a dismissal in one test leaks into the next. */
export const resetTutorialBannerDismissal = (): void => {
  dismissedThisSession = false
}
