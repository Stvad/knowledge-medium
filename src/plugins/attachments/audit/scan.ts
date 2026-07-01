/**
 * Map each item through `fn`, isolating per-item failures via `onError` so one
 * item can never abort the batch. This is the audit's no-fatal-abort guarantee
 * made structural: a single object that fails to read (a torn body stream, a
 * mid-scan delete) becomes that object's verdict, not a thrown exception that
 * kills the whole scan and silently skips everything after it.
 *
 * Sequential by design — the audit is an off-path daily job, so we trade
 * throughput for no concurrent-request pressure on Storage.
 */
export async function mapSettled<T, R>(
  items: readonly T[],
  fn: (item: T) => Promise<R>,
  onError: (item: T, err: unknown) => R,
): Promise<R[]> {
  const out: R[] = []
  for (const item of items) {
    try {
      out.push(await fn(item))
    } catch (err) {
      out.push(onError(item, err))
    }
  }
  return out
}
