export type HandleStatus = 'idle' | 'loading' | 'ready' | 'error'

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
