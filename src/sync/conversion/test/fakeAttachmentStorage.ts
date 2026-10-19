/**
 * In-memory model of a workspace's Storage folder as the attachment cleaner
 * sees it. Writes never overwrite (`upsert: false` plus the bucket's absent
 * UPDATE policy), and the bucket refuses an object over its `file_size_limit`
 * with a permanent 413.
 */

import { MAX_OBJECT_BYTES } from '../../byteTransform.js'
import type { AttachmentCleanerIO, ConversionBundle, MediaRef, ObjectPath } from '../attachmentCleaner.js'

export interface FakeAttachmentStorage {
  readonly io: AttachmentCleanerIO
  readonly objects: Map<ObjectPath, Uint8Array<ArrayBuffer>>
  readonly media: MediaRef[]
  /** This device's byte store, by local name. */
  readonly local: Map<string, Uint8Array<ArrayBuffer>>
  /** Every delete, in order. */
  readonly deletes: ObjectPath[]
}

export const createFakeAttachmentStorage = ({limit = MAX_OBJECT_BYTES}: {limit?: number} = {}): FakeAttachmentStorage => {
  const objects = new Map<ObjectPath, Uint8Array<ArrayBuffer>>()
  const media: MediaRef[] = []
  const local = new Map<string, Uint8Array<ArrayBuffer>>()
  const deletes: ObjectPath[] = []
  const io: AttachmentCleanerIO = {
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
  }
  return {io, objects, media, local, deletes}
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
