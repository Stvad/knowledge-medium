import { base64 } from '@scure/base'
import { MEDIA_BRIDGE_MAX_BYTES, type ReadMediaResult } from '@knowledge-medium/agent-cli/protocol'
import { safeDecodeRowProperty } from '@/data/rowProperty'
import { hasBlockType } from '@/data/properties'
import type { Repo } from '@/data/repo'
import {
  MEDIA_TYPE,
  mediaFilenameProp,
  mediaHashOf,
  mediaMimeProp,
  sniffImageMime,
} from '@/plugins/attachments/mediaBlock.js'
import type { AssetFailReason, AssetResolver } from '@/plugins/attachments/resolver.js'
import { loadRoot } from './agentViews/shared.ts'

const FAILURE_TEXT: Record<AssetFailReason, string> = {
  deferred: 'its workspace is locked, or the app tab is signed out',
  'no-content-key': 'this device does not have the workspace key',
  'invalid-hash': 'its media:hash is malformed',
  'fetch-failed': 'its bytes are not on this device and could not be downloaded',
  'decode-failed': 'its downloaded bytes could not be decrypted',
  'hash-mismatch': 'its downloaded bytes do not match its media:hash, so they were discarded',
  'store-failed': 'its bytes could not be stored on this device',
  error: 'the app hit an internal error resolving it (see the app tab console)',
}

/** One media block's bytes for an agent. Bytes come only from `resolver.resolve`,
 *  whose hash verification is the sole byte-integrity control: never read the byte
 *  store directly here. */
export const readMedia = async (
  repo: Repo,
  workspaceId: string,
  ref: string,
  resolver: Pick<AssetResolver, 'resolve'>,
): Promise<ReadMediaResult> => {
  const {root: block} = await loadRoot(repo, ref, workspaceId, async id => await repo.load(id) ?? undefined)
  if (!hasBlockType(block, MEDIA_TYPE)) {
    throw new Error(`Block ${block.id} is not a media block. A note shows one as ((id)): read that id.`)
  }
  const hash = mediaHashOf(block.properties)
  if (hash === null) throw new Error(`Media block ${block.id} has no content hash, so it has no bytes to read.`)

  const resolved = await resolver.resolve({workspaceId, contentHash: hash})
  if (!resolved.ok) throw new Error(`Cannot read media block ${block.id}: ${FAILURE_TEXT[resolved.reason]}.`)
  const {bytes} = resolved
  // After the read, not before it from media:size: that is member-writable, and could block a read.
  if (bytes.length > MEDIA_BRIDGE_MAX_BYTES) {
    throw new Error(`Media block ${block.id} is ${bytes.length} bytes; read-media carries at most ${MEDIA_BRIDGE_MAX_BYTES}.`)
  }

  return {
    id: block.id,
    hash,
    mime: safeDecodeRowProperty(block, mediaMimeProp),
    size: bytes.length,
    filename: safeDecodeRowProperty(block, mediaFilenameProp) ?? null,
    imageMime: sniffImageMime(bytes),
    base64: base64.encode(bytes),
  }
}
