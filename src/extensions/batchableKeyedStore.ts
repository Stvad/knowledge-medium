import {CallbackSet} from '@/utils/callbackSet.js'

/**
 * Base for the small non-React "keyed map + CallbackSet" stores the runtime
 * resolve populates (extension trust statuses, extension load errors). They
 * were byte-for-byte identical apart from the value type and two method
 * names, so the shared machinery lives here.
 *
 * The point of the base (beyond dedup) is the BATCH mode: `AppRuntimeProvider`
 * re-resolves on every `refreshAppRuntime()`, and the naive shape — `reset()`
 * to empty, then dribble the loader's per-block re-reports in after an async
 * gap — briefly blanked the map, which flickered the surfaces that read it
 * (global prompt toasts + status chip, row status icons). A batch buffers the
 * cycle's writes and publishes them as ONE atomic old→new transition:
 *   - `beginBatch()` opens an EMPTY buffer (so anything no longer reported
 *     drops out on commit — same end state as `reset()`, just deferred).
 *   - `set`/`delete` during a batch write to the buffer and DON'T notify.
 *   - `commitBatch()` swaps the buffer into the live map, one notification.
 *   - `abandonBatch()` drops the buffer (cancelled / errored resolve).
 *
 * Subclasses expose domain-named methods (`report`/`clear`,
 * `reportError`/`clearError`) that delegate to the protected `set`/`delete`,
 * so call sites and hooks are unchanged. Every public member is a bound arrow
 * property, so they survive destructuring (e.g. `const {reportError} = store`).
 */
export class BatchableKeyedStore<V> {
  private map: ReadonlyMap<string, V> = new Map()
  // When non-null a batch is open (see class doc).
  private batch: Map<string, V> | null = null
  private readonly listeners: CallbackSet<[]>

  constructor(label: string) {
    this.listeners = new CallbackSet<[]>(label)
  }

  getSnapshot = (): ReadonlyMap<string, V> => this.map

  subscribe = (listener: () => void): (() => void) => this.listeners.add(listener)

  /** Open a batch: subsequent set/delete buffer without notifying until
   *  commitBatch. The buffer starts empty and is rebuilt from this cycle's
   *  writes. Discards any in-progress batch (a superseded resolve). */
  beginBatch = (): void => {
    this.batch = new Map()
  }

  /** Publish the buffered batch as ONE notification (even when it clears the
   *  map). No-op if no batch is open. */
  commitBatch = (): void => {
    if (this.batch === null) return
    this.map = this.batch
    this.batch = null
    this.listeners.notify()
  }

  /** Drop the buffer without publishing (cancelled / errored resolve). */
  abandonBatch = (): void => {
    this.batch = null
  }

  protected set = (key: string, value: V): void => {
    if (this.batch !== null) {
      this.batch.set(key, value)
      return
    }
    const next = new Map(this.map)
    next.set(key, value)
    this.map = next
    this.listeners.notify()
  }

  protected delete = (key: string): void => {
    if (this.batch !== null) {
      this.batch.delete(key)
      return
    }
    if (!this.map.has(key)) return
    const next = new Map(this.map)
    next.delete(key)
    this.map = next
    this.listeners.notify()
  }

  /** Clear the live map (and abandon any open batch). Notifies unless already
   *  empty. */
  reset = (): void => {
    this.batch = null
    if (this.map.size === 0) return
    this.map = new Map()
    this.listeners.notify()
  }
}
