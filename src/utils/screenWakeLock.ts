/**
 * Keep the screen awake for a long pass, best effort: a browser without the
 * Wake Lock API, or one that refuses it, just lets the screen dim. The browser
 * drops the lock whenever the tab is hidden, so it is taken again each time
 * the tab comes back. Resolves to the release.
 */
export const holdScreenWakeLock = async (): Promise<() => void> => {
  const wakeLock = typeof navigator !== 'undefined' ? navigator.wakeLock : undefined
  if (!wakeLock) return () => {}
  let sentinel: WakeLockSentinel | null = null
  let released = false
  let acquiring = false
  const acquire = async () => {
    if (acquiring) return
    acquiring = true
    try {
      const next = await wakeLock.request('screen')
      if (released) void next.release()
      else sentinel = next
    } catch {
      // Refused (battery saver, a hidden tab): the pass runs on regardless.
    } finally {
      acquiring = false
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && !released) void acquire()
  }
  await acquire()
  document.addEventListener('visibilitychange', onVisibilityChange)
  return () => {
    released = true
    document.removeEventListener('visibilitychange', onVisibilityChange)
    void sentinel?.release().catch(() => {})
  }
}
