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

/** `target` with every call that returns a promise ending at `signal`, for an
 *  I/O dependency bound to a run once, where it is built: a call added later
 *  can't miss the stop. A call that answers at once is passed through. */
export const stoppable = <T extends object>(target: T, signal: AbortSignal | undefined): T => {
  if (!signal) return target
  return new Proxy(target, {
    get: (object, key) => {
      const value: unknown = Reflect.get(object, key)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const result: unknown = value.apply(object, args)
        return result instanceof Promise ? untilStopped(result, signal) : result
      }
    },
  })
}
