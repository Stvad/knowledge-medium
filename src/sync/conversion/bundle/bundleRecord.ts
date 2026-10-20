/**
 * The bundle record: what this device keeps about the recovery bundle it
 * verified (docs/workspace-e2ee-conversion.md §6.3 step 3). The re-seal never
 * starts without one, the purge takes its `through` and count from it, and the
 * attachment cleaner reads the bundle through it after the purge, so it is
 * cleared only on a purge refusal over a stale bundle, a re-check that fails,
 * or once the conversion finishes.
 */

import { IdbKeyedStore, idbRecordId } from '@/utils/idbKeyedStore.js'
import type { BundleFolder } from './bundleParts.js'
import type { VerifiedBundle } from './verifyBundle.js'

export interface BundleRecord {
  readonly workspaceId: string
  /** The sha256 of the verified `manifest.json`, which pins every part's digest. */
  readonly manifestSha256: string
  readonly through: number
  /** History rows archived up to `through`: the purge's archived count. */
  readonly historyRows: number
  readonly blockRows: number
  readonly exportedAt: string
  /** Media hashes the bundle holds no bytes for: confirmed before it was taken. */
  readonly noVerifiedSource: readonly string[]
  /** The Storage paths archived under `other-objects/`: the only objects the
   *  cleaner may delete without converting them. */
  readonly otherObjectPaths: readonly string[]
  /** The bundle's folder: a `FileSystemDirectoryHandle` in the browser. */
  readonly folder: BundleFolder
}

/** From what the read-back counted, not what the manifest claims. */
export const bundleRecordOf = ({manifest, manifestSha256, counted}: VerifiedBundle, folder: BundleFolder): BundleRecord => ({
  workspaceId: manifest.workspaceId,
  manifestSha256,
  through: counted.through,
  historyRows: counted.historyRows,
  blockRows: counted.blockRows,
  exportedAt: manifest.exportedAt,
  noVerifiedSource: manifest.noVerifiedSource,
  otherObjectPaths: manifest.otherObjects.map(entry => entry.path),
  folder,
})

export interface BundleRecordStore {
  get(userId: string, workspaceId: string): Promise<BundleRecord | null>
  put(userId: string, workspaceId: string, record: BundleRecord): Promise<void>
  delete(userId: string, workspaceId: string): Promise<void>
}

export class InMemoryBundleRecordStore implements BundleRecordStore {
  private readonly records = new Map<string, BundleRecord>()

  async get(userId: string, workspaceId: string) {
    return this.records.get(idbRecordId(userId, workspaceId)) ?? null
  }

  async put(userId: string, workspaceId: string, record: BundleRecord) {
    this.records.set(idbRecordId(userId, workspaceId), record)
  }

  async delete(userId: string, workspaceId: string) {
    this.records.delete(idbRecordId(userId, workspaceId))
  }
}

/** IndexedDB, which structured-clones the directory handle along with the record. */
export class IndexedDbBundleRecordStore implements BundleRecordStore {
  private readonly idb = new IdbKeyedStore('km-e2ee-conversion', 'bundle_records')

  async get(userId: string, workspaceId: string) {
    const record = await this.idb.tx<BundleRecord | undefined>('readonly', store => store.get(idbRecordId(userId, workspaceId)))
    return record ?? null
  }

  async put(userId: string, workspaceId: string, record: BundleRecord) {
    await this.idb.tx('readwrite', store => store.put(record, idbRecordId(userId, workspaceId)))
  }

  async delete(userId: string, workspaceId: string) {
    await this.idb.tx('readwrite', store => store.delete(idbRecordId(userId, workspaceId)))
  }
}
