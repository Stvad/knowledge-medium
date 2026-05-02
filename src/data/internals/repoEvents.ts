/** Internal impl for `repo.events` (spec §4.7). Tiny pub/sub —
 *  intentionally not pulling in EventEmitter or rxjs for two channels. */

import type {
  CycleDetectedEvent,
  EventChannel,
  RepoEvents,
  Unsubscribe,
} from '@/data/api'

interface InternalChannel<T> extends EventChannel<T> {
  emit(event: T): void
}

const createChannel = <T>(name: string): InternalChannel<T> => {
  const listeners = new Set<(event: T) => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(event) {
      for (const listener of listeners) {
        try { listener(event) } catch (err) {
          console.warn(`[repo.events.${name}] subscriber threw:`, err)
        }
      }
    },
  }
}

export interface InternalRepoEvents extends RepoEvents {
  cycleDetected: InternalChannel<CycleDetectedEvent>
}

export const createRepoEvents = (): InternalRepoEvents => ({
  cycleDetected: createChannel<CycleDetectedEvent>('cycleDetected'),
})

export type { Unsubscribe }
