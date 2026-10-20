/**
 * In-memory model of a workspace's Storage folder as the attachment cleaner
 * sees it. Writes never overwrite (`upsert: false` plus the bucket's absent
 * UPDATE policy), and the bucket refuses an object over its `file_size_limit`
 * with a permanent 413.
 */

import { MAX_OBJECT_BYTES } from '../../byteTransform.js'
import type { ConversionBundle, MediaRef, ObjectPath } from '../attachmentCleaner.js'
import type { ConversionAttachmentsIO } from '../conversionAttachments.js'

/** The plugin's reading of a stored row, for the fake's rows. */
export const fakeMediaHashOf = (propertiesJson: string): string | null => {
  let properties: {types?: unknown; 'media:hash'?: unknown}
  try {
    properties = JSON.parse(propertiesJson) as typeof properties
  } catch {
    return null
  }
  const isMedia = Array.isArray(properties?.types) && properties.types.includes('media')
  return isMedia && typeof properties['media:hash'] === 'string' && properties['media:hash'] ? properties['media:hash'] : null
}

export interface FakeAttachmentStorage {
  readonly io: ConversionAttachmentsIO
  readonly objects: Map<ObjectPath, Uint8Array<ArrayBuffer>>
  readonly media: MediaRef[]
  /** This device's byte store, by local name. */
  readonly local: Map<string, Uint8Array<ArrayBuffer>>
  /** Every delete, in order. */
  readonly deletes: ObjectPath[]
  /** Uploads this device hasn't had confirmed. */
  pendingUploads: number
}

export const createFakeAttachmentStorage = ({limit = MAX_OBJECT_BYTES}: {limit?: number} = {}): FakeAttachmentStorage => {
  const objects = new Map<ObjectPath, Uint8Array<ArrayBuffer>>()
  const media: MediaRef[] = []
  const local = new Map<string, Uint8Array<ArrayBuffer>>()
  const deletes: ObjectPath[] = []
  const storage = {pendingUploads: 0} as {pendingUploads: number}
  const io: ConversionAttachmentsIO = {
    listObjects: async () => [...objects.keys()].sort(),
    readObject: async path => objects.get(path)?.slice() ?? null,
    writeObject: async (path, bytes) => {
      if (bytes.length > limit) return {kind: 'refused', status: 413}
      if (objects.has(path)) return {kind: 'exists'}
      objects.set(path, bytes.slice())
      return {kind: 'written'}
    },
    deleteObject: async path => {
      deletes.push(path)
      objects.delete(path)
    },
    mediaBlocks: async () => media,
    readLocal: async name => local.get(name)?.slice() ?? null,
    writeLocal: async (name, bytes) => void local.set(name, bytes.slice()),
    mediaHashOf: fakeMediaHashOf,
    pendingUploads: async () => storage.pendingUploads,
  }
  return Object.assign(storage, {io, objects, media, local, deletes})
}

export const createFakeBundle = (
  archived: ReadonlyMap<ObjectPath, Uint8Array<ArrayBuffer>> = new Map(),
  attachments: ReadonlyMap<string, Uint8Array<ArrayBuffer>> = new Map(),
  noVerifiedSource: ReadonlySet<string> = new Set(),
): ConversionBundle & {readable: boolean} => {
  const bundle = {
    readable: true,
    archivedPaths: new Set(archived.keys()),
    noVerifiedSource,
    readArchivedObject: async (path: ObjectPath) => {
      if (!bundle.readable) throw new Error('the bundle folder is not readable')
      return archived.get(path)?.slice() ?? null
    },
    readAttachment: async (contentHash: string) => {
      if (!bundle.readable) throw new Error('the bundle folder is not readable')
      return attachments.get(contentHash)?.slice() ?? null
    },
  }
  return bundle
}
