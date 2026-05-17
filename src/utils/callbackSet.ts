/**
 * Minimal listener-set primitive — the shared half of the "Family B"
 * notify-callback pattern that several subsystems re-implement (see
 * `repo.ts` propertySchemasListeners / userErrorListeners, the new
 * UndoManager.subscribe path).
 *
 *   const cs = new CallbackSet<[delta: number]>('foo')
 *   const off = cs.add(d => console.log(d))
 *   cs.notify(1)
 *   off()
 *
 * Contract:
 *  - `add` returns an idempotent unsubscribe; calling it twice is safe.
 *  - `notify` iterates a snapshot so a listener can subscribe /
 *    unsubscribe during its own callback without skipping a neighbour.
 *  - Listener exceptions are caught + logged with the optional label
 *    so one bad subscriber can't break the notification fan-out.
 */

export type Listener<TArgs extends readonly unknown[]> = (...args: TArgs) => void

export class CallbackSet<TArgs extends readonly unknown[] = []> {
  private readonly listeners = new Set<Listener<TArgs>>()
  private readonly label: string | undefined

  constructor(label?: string) {
    this.label = label
  }

  add(listener: Listener<TArgs>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  notify(...args: TArgs): void {
    for (const listener of [...this.listeners]) {
      try { listener(...args) } catch (err) {
        const tag = this.label ? ` ${this.label}` : ''
        console.warn(`[CallbackSet${tag}] listener threw:`, err)
      }
    }
  }

  get size(): number {
    return this.listeners.size
  }

  clear(): void {
    this.listeners.clear()
  }
}
