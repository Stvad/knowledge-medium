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

export const isTutorialBannerDismissed = (): boolean => {
  try {
    return window.localStorage?.getItem(DISMISSED_KEY) === 'true'
  } catch {
    // Private-mode / blocked storage: show the banner rather than swallow it.
    return false
  }
}

export const dismissTutorialBanner = (): void => {
  try {
    window.localStorage?.setItem(DISMISSED_KEY, 'true')
  } catch {
    /* ignore — the in-memory state still hides it for this session */
  }
}
