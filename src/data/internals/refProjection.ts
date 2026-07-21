/**
 * Shared property-schema projection helpers — the ref-codec classification
 * and the ref-change diff. Used by two engines that were both carved out of
 * `Repo`:
 *
 *   - `facetBridge.ts` rebuild steps: `changedRefSchemaNames` (decide whether
 *     a swap needs a reprojection pass).
 *   - `repo.ts` reprojection: `projectedRefsForField` / `latestRefProjection-
 *     Schema` (recompute a block's derived references from its ref-typed
 *     property values).
 *
 * Lives in its own module so both can import it without a `repo ↔ bridge`
 * cycle. Imports only types + codec guards from `@/data/api`.
 */

import type {
  AnyPropertySchema,
  BlockData,
  BlockReference,
} from '@/data/api'
import { decodeRefId, decodeRefListIds, isRefCodec, isRefListCodec } from '@/data/api'

export type RefCodecKind = 'ref' | 'refList' | undefined

export const refCodecKind = (schema: AnyPropertySchema | undefined): RefCodecKind => {
  if (schema === undefined) return undefined
  if (isRefCodec(schema.codec)) return 'ref'
  if (isRefListCodec(schema.codec)) return 'refList'
  return undefined
}

/** Names whose ref-ness (ref / refList / not-a-ref) differs between two
 *  schema registries — the set a schema swap must reproject. */
export const changedRefSchemaNames = (
  before: ReadonlyMap<string, AnyPropertySchema>,
  after: ReadonlyMap<string, AnyPropertySchema>,
): string[] => {
  const names = new Set([...before.keys(), ...after.keys()])
  return Array.from(names)
    .filter(name => refCodecKind(before.get(name)) !== refCodecKind(after.get(name)))
    .sort()
}

/** Every ref-typed name in a registry. A workspace pin schedules a
 *  marker-gated scan over these so a newly-activated workspace backfills its
 *  own rows' derived refs even when a ref-typed name (e.g. a shared static
 *  seed like `next-review-date`) is unchanged from the previously-active
 *  workspace and thus absent from `changedRefSchemaNames`. */
export const refTypedSchemaNames = (
  schemas: ReadonlyMap<string, AnyPropertySchema>,
): string[] => {
  const names: string[] = []
  for (const [name, schema] of schemas) {
    if (refCodecKind(schema) !== undefined) names.push(name)
  }
  return names.sort()
}

const appendRefProjection = (
  refs: BlockReference[],
  seen: Set<string>,
  sourceField: string,
  id: string,
): void => {
  const targetId = id.trim()
  if (!targetId) return
  const key = `${sourceField}\u0000${targetId}`
  if (seen.has(key)) return
  seen.add(key)
  refs.push({id: targetId, alias: targetId, sourceField})
}

export const projectedRefsForField = (
  block: BlockData,
  schema: AnyPropertySchema | undefined,
  sourceField: string,
): BlockReference[] => {
  if (schema === undefined || !(sourceField in block.properties)) return []
  const encodedValue = block.properties[sourceField]
  const refs: BlockReference[] = []
  const seen = new Set<string>()
  if (isRefCodec(schema.codec)) {
    const id = decodeRefId(schema.codec, encodedValue)
    if (id !== undefined) appendRefProjection(refs, seen, sourceField, id)
    return refs
  }
  if (isRefListCodec(schema.codec)) {
    // Element-wise lenient decode: a single malformed element drops only
    // itself instead of stripping the whole field's backlinks to [] (#189).
    for (const id of decodeRefListIds(schema.codec, encodedValue)) {
      appendRefProjection(refs, seen, sourceField, id)
    }
  }
  return refs
}

/** Reprojection scans can outlive a later schema swap. Pick the schema a
 *  parked scan should project a field against:
 *   - live registry still knows the name ⇒ project against it, so a genuine
 *     ref→non-ref redefine that landed after scheduling strips the stale refs,
 *     and a still-ref field re-adds.
 *   - live registry no longer knows the name (absent) ⇒ keep the *scheduled*
 *     schema, so the scan RETAINS the field's refs instead of stripping them.
 *     Absence is "toggled off / not loaded", not a deletion. The caller already
 *     drops absent-everywhere names before scanning (see `reprojectRefTyped-
 *     Properties`); this guards the narrower race where a name was ref-typed at
 *     schedule time but vanished from the live registry by run time (a plugin
 *     toggled off, ?safeMode, or an async user/import schema mid-republish).
 *     Stripping that field is exactly the silent-deletion vector that wiped
 *     ~10k `next-review-date` backlinks on SRS toggle-off.
 *
 *  The caller passes a *workspace-correct* `currentSchemas`: the live registry
 *  only while still on the scan's workspace, else the scheduled snapshot (see
 *  `liveSchemas` in `reprojectRefTypedProperties`), so cross-workspace state
 *  never decides ref-ness for the captured workspace's blocks. */
export const latestRefProjectionSchema = (
  scheduledSchemas: ReadonlyMap<string, AnyPropertySchema>,
  currentSchemas: ReadonlyMap<string, AnyPropertySchema>,
  name: string,
): AnyPropertySchema | undefined => {
  const scheduledSchema = scheduledSchemas.get(name)
  const currentSchema = currentSchemas.get(name)
  if (currentSchema === undefined) return scheduledSchema
  return refCodecKind(scheduledSchema) === refCodecKind(currentSchema)
    ? scheduledSchema
    : currentSchema
}
