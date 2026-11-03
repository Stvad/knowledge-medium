/**
 * The recovery bundle's manifest (docs/workspace-e2ee-conversion.md §6.3
 * step 3): what the folder holds, bound to its workspace, with a digest of
 * every part. The sha256 of the manifest itself pins every part's digest, so
 * the device keeps only that, and a different folder with matching counts
 * can't stand in.
 *
 * Key-loss recovery (#1302) reads it too, so its shape is versioned.
 */

import type { OtherObjectEntry } from './attachmentParts.js'
import type { JsonlDigest, PartDigest } from './bundleParts.js'

export const BUNDLE_FORMAT = 'km-e2ee-conversion-bundle'
export const BUNDLE_FORMAT_VERSION = 1

export const BUNDLE_PARTS = {
  manifest: 'manifest.json',
  blocks: 'blocks.jsonl',
  history: 'server-history.jsonl',
  localDb: 'local.db',
} as const

export interface BundleManifest {
  readonly format: typeof BUNDLE_FORMAT
  readonly version: typeof BUNDLE_FORMAT_VERSION
  readonly workspaceId: string
  /** ISO time the bundle was taken. */
  readonly exportedAt: string
  /** The last `blocks_history` event archived, 0 for an empty history. */
  readonly through: number
  /** The workspace's block count, read in the same window as `blocks.jsonl`. */
  readonly serverBlockCount: number
  /** `workspaces.properties_migration` as the bundle was taken: rows from
   *  another stage of that switch read differently, so a restore checks it. */
  readonly propertiesMigration: string
  readonly parts: {
    readonly [BUNDLE_PARTS.blocks]: JsonlDigest
    readonly [BUNDLE_PARTS.history]: JsonlDigest
    readonly [BUNDLE_PARTS.localDb]: PartDigest
  }
  /** Media content hashes (`sha256:<hex>`, as `media:hash` stores them) the
   *  user confirmed before the flip have no hash-verified source: the only
   *  media blocks `attachments/` may lack. */
  readonly noVerifiedSource: readonly string[]
  /** Every other Storage object archived under `other-objects/`. */
  readonly otherObjects: readonly OtherObjectEntry[]
}
