const DEFAULT_BLUR_EXIT_SUPPRESSION_MS = 400

let blurExitSuppressionCount = 0

/** Acquire one hold on CodeMirror blur-driven edit-mode exits.
 *  While held, BlockEditor's blur handler refocuses instead of flipping
 *  `isEditing` off. The release function is idempotent so callers can
 *  safely schedule it from finally blocks. */
export const acquireBlurExitSuppression = (): (() => void) => {
  blurExitSuppressionCount++
  let released = false
  return () => {
    if (released) return
    released = true
    blurExitSuppressionCount--
  }
}

export const isBlurExitSuppressed = (): boolean => blurExitSuppressionCount > 0

export const scheduleBlurExitSuppressionRelease = (
  release: () => void,
  delayMs = DEFAULT_BLUR_EXIT_SUPPRESSION_MS,
): void => {
  globalThis.setTimeout(release, delayMs)
}
