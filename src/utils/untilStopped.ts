/** A step that ends with `signal`'s reason as soon as it aborts, for an
 *  operation that can't itself be cancelled (a drive that stopped answering).
 *  `onLate` gets what the step brings if it arrives after that, to undo it. */
export const untilStopped = <R>(step: Promise<R>, signal: AbortSignal | undefined, onLate?: (value: R) => void): Promise<R> => {
  if (!signal) return step
  let stopped = false
  void step.then(value => { if (stopped) onLate?.(value) }, () => {})
  if (signal.aborted) {
    stopped = true
    return Promise.reject(signal.reason)
  }
  let onAbort = () => {}
  const stop = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      stopped = true
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, {once: true})
  })
  return Promise.race([step, stop]).finally(() => signal.removeEventListener('abort', onAbort))
}
