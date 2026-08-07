/** `'disposed'` is terminal and only ever reported by a store-backed handle
 *  that has been GC'd: its value is gone, `subscribe` is a no-op and `load`
 *  rejects, so the holder must re-acquire through the factory rather than
 *  keep using it. It exists because a disposed handle used to report `'idle'`
 *  — indistinguishable from a fresh one, which is what let a consumer sit on
 *  a dead handle forever (docs/handle-lifecycle-hidden-subtrees.html).
 *  `Block` has no disposal concept and never returns it. */
export type HandleStatus = 'idle' | 'loading' | 'ready' | 'error' | 'disposed'

export type Unsubscribe = () => void

/** Single read primitive. Identity-stable per `(name, JSON.stringify(args))`.
 *  GC after `gcTime` of zero subscribers + zero in-flight loads. See §5.1. */
export interface Handle<T> {
  readonly key: string

  /** Sync read. `undefined` = not yet loaded; never throws. */
  peek(): T | undefined

  /** Ensure loaded; idempotent + deduped. */
  load(): Promise<T>

  /** Reactive subscription. Listener fires on structural change only. */
  subscribe(listener: (value: T) => void): Unsubscribe

  /** Suspense path: returns T or throws a Promise if not loaded. */
  read(): T

  status(): HandleStatus
}
