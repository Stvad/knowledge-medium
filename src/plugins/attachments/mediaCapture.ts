/**
 * Media capture (design §9/§11) — turns raw pasted/dropped bytes into a
 * content-addressed `media` block (the renderer places a `((id))` reference to it),
 * and arms the up-lane.
 *
 * The ORDER is the data-loss-critical contract (§11 staging box):
 *
 *   1. guard (size / mime) and derive the content identity (hash → content-key →
 *      deterministic UUIDv5 block id) from the PLAINTEXT bytes.
 *   2. write the plaintext to the OPFS byte store           ─┐ durable, and
 *   3. STAGE a byte-upload record (status `staged`, NOT       │ BEFORE the block
 *      drainable)                                            ─┘ tx.
 *   4. mint the asset block under the workspace ASSETS container, in ONE repo.tx.
 *      (Capture mints NO placement block — the renderer inserts a `((id))` reference
 *      as text at the paste site, per the text policy.)
 *   5. AFTER the tx commits: promote `staged` → `pending` (now drainable) + arm
 *      the drain.
 *
 * Why this order: staging BEFORE the tx with a NON-drainable status closes the
 * orphan-upload window (a crash between stage and commit leaves a `staged` record
 * whose block never committed — it stays `staged` so it never uploads, and §16 GC
 * reclaims its bytes; we never upload bytes for a block that doesn't exist).
 * Promoting only AFTER commit closes the lost-upload window (a crash between commit
 * and promote leaves the block with a `staged` record the reconciler promotes,
 * because its block IS present). So a crash at any single point is recoverable,
 * never a broken-image-forever.
 *
 * The block id is `uuidv5(<workspaceId>:<content-key>)` — a UUID, because the
 * reference is a block-ref (`((id))`) and the block-ref grammar only recognises
 * UUID-shaped targets (referenceParser `UUID_RE_SOURCE`); a `media:…`-style id
 * would render as literal `((media:…))` text, never a media reference. It's keyed on
 * the workspace AND content-key, so it stays both deterministic and
 * workspace-scoped: re-pasting identical content into the SAME workspace dedups to
 * one block (createOrRestoreTargetBlock, systemMint pristine so two devices' first
 * pastes reconcile; DeletedConflictError → restore so a re-paste-after-undo
 * resurrects), while the SAME plaintext bytes in a DIFFERENT workspace get a
 * distinct block (their content-key is raw sha256, identical across workspaces —
 * keying the uuid on the workspace keeps the ids from colliding cross-workspace,
 * which `createOrGet` rejects, and the upload-queue records from clobbering). The
 * asset lives under a SHARED workspace ASSETS container, never under the pasting
 * note (a note delete must not tombstone a shared asset, §11). Each paste adds
 * only the `((id))` reference at the paste site.
 */

import { v5 as uuidv5 } from 'uuid'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { getOrCreateKernelPage, kernelPageBlockId } from '@/data/kernelPage'
import { keyAtEnd } from '@/data/orderKey'
import { createOrRestoreTargetBlock } from '@/data/targets'
import { BINARY_ENVELOPE_OVERHEAD_BYTES } from '@/sync/crypto/binaryEnvelope.js'
import { computeContentHash } from '@/sync/crypto/contentHash.js'
import { deriveContentKey } from '@/sync/crypto/contentKey.js'
import { materializabilityToMode, type GetMaterializability } from '@/sync/transform.js'
import type { ByteStore } from './byteStore.js'
import {
  ASSETS_ALIAS,
  ASSETS_NS,
  ASSETS_TYPE,
  MEDIA_TYPE,
  mediaFilenameProp,
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
} from './mediaBlock.js'
import type { ByteUploadStore } from './uploadStore.js'

/** The bucket's `file_size_limit` (§10) — 50 MiB. The client guard rejects an
 *  oversize capture BEFORE staging, so we never queue an upload the server's 413
 *  would only quarantine — and it bounds the ENCODED object (e2ee adds the
 *  envelope overhead, {@link BINARY_ENVELOPE_OVERHEAD_BYTES}), not just the
 *  plaintext, so an e2ee file just under the cap can't 413 at upload. */
export const DEFAULT_MAX_CAPTURE_BYTES = 50 * 1024 * 1024

/** uuid v5 namespace for media asset block ids (distinct from ASSETS_NS). */
const MEDIA_BLOCK_NS = 'a1f4c7e2-9b3d-4e6a-8c5f-2d0b1e7a4c93'

/** The deterministic asset block id — a UUIDv5 (the reference is a `((id))` block-ref
 *  and the block-ref grammar only matches UUID-shaped targets, so a `media:…` id
 *  would render as literal text). Keyed on workspace + content-key so the same
 *  plaintext content (whose content-key is the raw sha256, identical across
 *  workspaces) gets a distinct block per workspace, while two devices in the SAME
 *  workspace still converge on one id. */
export const mediaBlockId = (workspaceId: string, contentKey: string): string =>
  uuidv5(`${workspaceId}:${contentKey}`, MEDIA_BLOCK_NS)

export interface MediaSource {
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly mime: string
  readonly filename?: string
}

export interface MediaCaptureRequest {
  readonly workspaceId: string
  readonly source: MediaSource
}

export interface MediaCaptureDeps {
  readonly repo: Repo
  readonly byteStore: ByteStore
  readonly uploadStore: ByteUploadStore
  /** The active account — scopes the byte store + the upload queue (§7). */
  readonly getUserId: () => string | null
  /** The three-valued mode (same source the read/up lanes use): copy → plaintext
   *  content-key, decrypt → keyed content-key (needs K_id), defer → can't capture
   *  (the workspace is locked). */
  readonly getMaterializability: GetMaterializability
  /** The workspace's K_id (§10) — required to derive an e2ee content-key. */
  readonly getContentKeyHmac: (workspaceId: string) => Promise<CryptoKey | null>
  /** Arm the up-lane after commit. Fire-and-forget — the boot reconciler /
   *  periodic sweep also drains, so a missed arm only delays, never drops. */
  readonly drain: (userId: string) => void
  readonly maxBytes?: number
  /** Optional MIME allow-list; default allows everything (the bucket does). */
  readonly isAllowedMime?: (mime: string) => boolean
}

export type MediaCaptureFailure =
  | 'no-user'
  | 'empty'
  | 'too-large'
  | 'unsupported-mime'
  | 'workspace-locked'
  | 'no-content-key'

export type MediaCaptureResult =
  // `assetBlockId` is the content-addressed media block (under the ASSETS container);
  // the caller builds the `((assetBlockId))` reference and PLACES it (the renderer's job
  // — capture no longer mints the reference/embed block).
  | { readonly ok: true; readonly assetBlockId: string; readonly deduped: boolean }
  | { readonly ok: false; readonly reason: MediaCaptureFailure }

/** Capture ONE file. See the module header for the ordering contract. */
export const captureMedia = async (
  request: MediaCaptureRequest,
  deps: MediaCaptureDeps,
): Promise<MediaCaptureResult> => {
  const { workspaceId, source } = request
  const { bytes, mime, filename } = source

  const userId = deps.getUserId()
  if (!userId) return { ok: false, reason: 'no-user' }

  // (1a) Guard — reject before any durable write. (The size-vs-limit check is
  //      mode-aware and lands in 1b: the e2ee envelope adds upload overhead.)
  const size = bytes.byteLength
  if (size === 0) return { ok: false, reason: 'empty' }
  if (deps.isAllowedMime && !deps.isAllowedMime(mime)) return { ok: false, reason: 'unsupported-mime' }

  // (1b) Mode + content identity. A locked workspace can't derive a content-key.
  const mode = materializabilityToMode(await deps.getMaterializability(workspaceId))
  if (mode === null) return { ok: false, reason: 'workspace-locked' }

  // The uploaded OBJECT is the encoded bytes: e2ee wraps the plaintext in the
  // encb:v1 envelope (magic+nonce+GCM tag); copy is passthrough. Guard the ENCODED
  // size against the bucket's file_size_limit so an e2ee file in the top envelope-
  // overhead bytes of the allowance can't pass here, then 413 (permanent) at upload.
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_CAPTURE_BYTES
  const encodedSize = mode === 'e2ee' ? size + BINARY_ENVELOPE_OVERHEAD_BYTES : size
  if (encodedSize > maxBytes) return { ok: false, reason: 'too-large' }

  const contentKeyHmac = mode === 'e2ee' ? await deps.getContentKeyHmac(workspaceId) : null
  if (mode === 'e2ee' && !contentKeyHmac) return { ok: false, reason: 'no-content-key' }

  const contentHash = await computeContentHash(bytes)
  const contentKey = await deriveContentKey({ contentHash, mode, contentKeyHmac })
  const assetBlockId = mediaBlockId(workspaceId, contentKey)

  // (2) + (3) Durable, BEFORE the block tx: the bytes (render source + upload
  // source) then a NON-drainable `staged` record. If we crash here the staged
  // record's block never committed; it stays `staged` (never drains, never an
  // orphan upload) and its bytes are reclaimed by §16 GC — the reconciler never reaps.
  await deps.byteStore.put(userId, workspaceId, contentKey, bytes)
  await deps.uploadStore.stage({
    userId,
    assetBlockId,
    workspaceId,
    contentHash,
    contentKey,
  })

  // (4) Mint the asset under the workspace ASSETS container (idempotent ensure
  // first, its own tx), then the asset block in one tx — one undo entry for the
  // pair. The `((assetBlockId))` EMBED is NOT minted here — the caller
  // (renderer) places it via the text-paste path, so a pasted attachment lands
  // at the caret per the text policy.
  let inserted = false
  await deps.repo.undoGroup(async (repo) => {
    await getOrCreateKernelPage(repo, workspaceId, {
      namespace: ASSETS_NS,
      alias: ASSETS_ALIAS,
      markerType: ASSETS_TYPE,
    })
    const containerId = kernelPageBlockId(workspaceId, ASSETS_NS)
    const typeSnapshot = repo.snapshotTypeRegistries()

    await repo.tx(async (tx) => {
      const minted = await createOrRestoreTargetBlock(tx, {
        id: assetBlockId,
        workspaceId,
        parentId: containerId,
        orderKey: keyAtEnd(),
        freshContent: filename ?? '',
        // Pristine systemMint so two devices' first pastes of the same content
        // reconcile to one row rather than racing wall-clocks (§11).
        systemMint: true,
        onInsertedOrRestored: async (tx, id) => {
          await tx.setProperty(id, mediaHashProp, contentHash)
          await tx.setProperty(id, mediaMimeProp, mime)
          await tx.setProperty(id, mediaSizeProp, size)
          if (filename !== undefined) await tx.setProperty(id, mediaFilenameProp, filename)
          await repo.addTypeInTx(tx, id, MEDIA_TYPE, {}, typeSnapshot)
        },
      })
      inserted = minted.inserted
    }, { scope: ChangeScope.BlockDefault, description: 'capture media' })
  })

  // (5) AFTER commit: the record is safe to drain, and the block exists.
  await deps.uploadStore.promote(userId, assetBlockId)
  deps.drain(userId)

  return { ok: true, assetBlockId, deduped: !inserted }
}
