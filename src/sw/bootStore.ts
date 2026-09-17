/**
 * The boot set (shell HTML, first-paint assets, vendor React) in IndexedDB, so
 * a cold launch answers them without touching Cache Storage. On iOS the first
 * Cache Storage call of a service-worker lifetime costs ~600 ms regardless of
 * which cache or how many entries (measured against an IndexedDB open in the
 * same worker: 17 ms); Cache Storage stays the store for everything lazy.
 *
 * Entries are keyed by build id, so a worker only ever serves its own
 * generation's bytes and the activate GC reaps a generation by prefix.
 */
import { IdbKeyedStore, idbKeyPrefix, idbRecordId } from '../utils/idbKeyedStore'

export interface BootEntry {
  status: number
  contentType: string
  body: ArrayBuffer
}

export interface BootStore {
  get(key: string): Promise<BootEntry | undefined>
  putAll(entries: ReadonlyArray<readonly [string, BootEntry]>): Promise<void>
  deletePrefix(prefix: string): Promise<void>
}

export const bootKeyPrefix = (buildId: string): string => idbKeyPrefix(buildId)
export const bootKey = (buildId: string, url: string): string => idbRecordId(buildId, url)

export const idbBootStore = (): BootStore => {
  const store = new IdbKeyedStore('km-boot', 'entries')
  return {
    get: key => store.tx('readonly', s => s.get(key) as IDBRequest<BootEntry | undefined>),
    // Requests are issued synchronously (no await before the puts), which is
    // what keeps the transaction active — see idbKeyedStore.ts.
    putAll: entries => store.runTransaction('readwrite', async s => {
      for (const [key, entry] of entries) s.put(entry, key)
    }),
    deletePrefix: prefix => store.deleteByPrefix(prefix),
  }
}
