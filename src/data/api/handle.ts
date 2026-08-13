/** `'disposed'` is reported by a store-backed handle that has been GC'd AND
 *  has no live replacement at its key. It is not a dead end: the handle
 *  resolves itself — `peek`/`status` forward to a replacement if one exists,
 *  and `subscribe`/`load`/`read` adopt it, or mint a fresh one at the key when
 *  it is vacant, and operate through that (the disposed instance stays dead) —
 *  because a holder cannot be relied on to re-acquire (React Compiler memoizes the
 *  factory call). So a handle with a live replacement reports THAT handle's
 *  status, never `'disposed'`. See docs/handle-lifecycle-hidden-subtrees.html.
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
