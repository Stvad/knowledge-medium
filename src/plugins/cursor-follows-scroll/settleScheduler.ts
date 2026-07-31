/**
 * A debounce with one property worth isolating: running it NOW cancels what was
 * pending.
 *
 * The settle it drives has two callers — the scroll debounce, and the effect
 * that fires when an editor closes — and the direct caller used to leave the
 * armed timeout behind. That orphan could then fire inside the next scroll's
 * quiet period and move the cursor while the user was still scrolling, and no
 * cleanup could reach it.
 *
 * Extracted rather than left as a `clearTimeout` inside the component because
 * that form is not pinnable: every ordering a component test can stage ends in
 * the same observable cursor, so the bug is one extra write in a 150ms window
 * that the final state doesn't show. Here it is three lines and a fake-timer
 * assertion.
 */
export interface SettleScheduler {
  /** Arm the run, replacing anything already pending. */
  schedule: (delayMs: number) => void
  /** Run immediately, cancelling anything pending. */
  runNow: () => void
  cancel: () => void
}

export const createSettleScheduler = (run: () => void): SettleScheduler => {
  let timer: ReturnType<typeof setTimeout> | null = null

  const cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }

  return {
    schedule: (delayMs) => {
      cancel()
      timer = setTimeout(() => {
        timer = null
        run()
      }, delayMs)
    },
    runNow: () => {
      cancel()
      run()
    },
    cancel,
  }
}
