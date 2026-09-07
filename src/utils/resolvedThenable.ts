/** A promise React's `use()` reads WITHOUT suspending.
 *
 *  `use()` cannot see inside a native promise: on one it has never tracked
 *  it attaches callbacks and throws, even when the value is already there —
 *  and React 19 then holds the resolved content behind the Suspense fallback
 *  for its 300ms retry throttle. It skips all of that for a thenable that
 *  already carries `status: 'fulfilled'` + `value` (the instrumented-thenable
 *  protocol React stamps onto promises itself once they settle).
 *
 *  Use it where a value is available synchronously but the API shape is a
 *  promise consumers `use()`, so a cache hit never costs a fallback. */
export const resolvedThenable = <T>(value: T): Promise<T> => {
  const thenable = Promise.resolve(value) as Promise<T> & {status: 'fulfilled'; value: T}
  thenable.status = 'fulfilled'
  thenable.value = value
  return thenable
}
