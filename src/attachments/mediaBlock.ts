/**
 * The `media` block type + its property schemas (design §3 / §11).
 *
 * An attachment IS a block (§3): a `media`-typed block holds the metadata for one
 * content-addressed object, and is embedded everywhere via `!((id))`. The bytes
 * live out-of-band in Storage (§10) + the local OPFS byte store (§8); this block
 * carries only the small metadata the resolver (§7.3) and renderer (§11) need.
 *
 * `media:hash` is THE load-bearing field — it is the `sha256:<hex>` content hash
 * (§5.1) the resolver verifies fetched bytes against and derives the object path
 * from (§10). `mime` drives the renderer's branch; `size`/`filename` are
 * cosmetic. (Capture — Phase 5 — populates them; this phase only defines + renders.)
 */

import { ChangeScope, codecs, defineBlockType, defineProperty } from '@/data/api'
import type { PropertySchema, TypeContribution } from '@/data/api'

export const MEDIA_TYPE = 'media'

/** The `sha256:<hex>` content hash (§5.1). The resolver verifies fetched bytes
 *  against it and derives the §10 object path from it — render-critical, never
 *  cosmetic. Empty default = "no hash yet" → the renderer fails closed. */
export const mediaHashProp = defineProperty<string>('media:hash', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** The object's MIME type — drives the renderer branch (image / file). Defaults
 *  to the bytes' on-the-wire type; the real value is set at capture (§11). */
export const mediaMimeProp = defineProperty<string>('media:mime', {
  codec: codecs.string,
  defaultValue: 'application/octet-stream',
  changeScope: ChangeScope.BlockDefault,
})

/** Plaintext byte length (cosmetic — for the file chip / pending UI). */
export const mediaSizeProp = defineProperty<number>('media:size', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

/** Original filename, when captured from a file (cosmetic; cross-device LWW). */
export const mediaFilenameProp = defineProperty<string | undefined>('media:filename', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const MEDIA_PROPERTY_SCHEMAS: ReadonlyArray<PropertySchema<unknown>> = [
  mediaHashProp,
  mediaMimeProp,
  mediaSizeProp,
  mediaFilenameProp,
] as ReadonlyArray<PropertySchema<unknown>>

export const MEDIA_TYPE_CONTRIBUTION: TypeContribution = defineBlockType({
  id: MEDIA_TYPE,
  label: 'Media',
  description: 'An image or file attachment, stored content-addressed and embedded via !((id)).',
  // Lift the media:* fields so addType('media') materialises their defaults and
  // the property panel surfaces them.
  properties: [...MEDIA_PROPERTY_SCHEMAS],
})

/** Does a MIME type render as an inline image (§11 image branch)? Case-insensitive
 *  — MIME types are case-insensitive (RFC 2045) even though `File.type` is lowercase. */
export const isImageMime = (mime: string | undefined): boolean =>
  typeof mime === 'string' && mime.toLowerCase().startsWith('image/')
