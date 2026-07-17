/**
 * Pure helpers for properties-as-blocks field/value children (PR #288 §5/§9,
 * extracted from the PR #285 spike). A property on a block is a FIELD ROW —
 * a child whose content is `((fieldId))`, an id block-ref to the definition
 * block, mirrored into the local `reference_target_id` column — whose own
 * child holds the value (scalar-first: one primary value child). Addressing
 * is BY ID: `reference_target_id` derives textually from the `((fieldId))`
 * content (no name→schema tier, no deferred resolution), and the name is
 * recovered by resolving the id → definition wherever it's needed.
 *
 * Recognition (§9) is a column read plus two context bits, never a content
 * parse: `reference_target_id` resolves a definition (fieldId-keyed lookup),
 * the WORKSPACE is flipped (`properties_migration` at or past 'children'),
 * and the row's ancestry doesn't pass through a field row (children of field
 * rows are values/comments, never field rows — whatever their target: a
 * ref-typed VALUE pointing at a definition block carries that definition's
 * id in the column too, and without the positional rule it would be
 * reinterpreted as a nested field). Callers own the flip + ancestry
 * context; these helpers own the column/definition half.
 */

import {
  CodecError,
  type AnyPropertySchema,
  type BlockData,
  type PropertySchema,
} from '@/data/api'
import { referenceBlockContentForId } from '@/data/referenceBlock'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical'

export const getPropertyFieldTargetId = (
  data: Pick<BlockData, 'referenceTargetId'> | null | undefined,
): string | undefined => data?.referenceTargetId ?? undefined

/** Synchronous fieldId → "is a resolvable definition" predicate, bound to a
 *  workspace registry snapshot by the caller (SameTxCtx /
 *  TxImpl.propertySchemaResolverFor). Shadowed definitions COUNT — losers
 *  stay fieldId-resolvable so their field rows keep classifying (§6). */
export type IsPropertyFieldDefinition = (fieldId: string) => boolean

/** Column + definition half of §9 recognition. The caller supplies the flip
 *  gate and the ancestry rule (positional; traversals know it from
 *  context). */
export const isPropertyFieldInstance = (
  data: Pick<BlockData, 'referenceTargetId' | 'parentId'> | null | undefined,
  isFieldDefinition: IsPropertyFieldDefinition,
): boolean => {
  // §9 positional rule, root half: a field row is a CHILD of the block
  // that owns the property — a workspace-root row is user content no
  // matter what its column resolves to (its stamp is just content
  // recognition). Without this, a stamped root `[[status]]` row classifies
  // as machinery, the write-side walks call it "inside a property
  // subtree", and its own bag can never materialize children (PR #386
  // review follow-up). The SQL twins carry the same `parent_id IS NOT
  // NULL` clause.
  if (data?.parentId === null) return false
  const fieldId = getPropertyFieldTargetId(data)
  return fieldId !== undefined && isFieldDefinition(fieldId)
}

/** Field-row content: a block-ref to the definition BY ID (`((fieldId))`, PR
 *  #288 §7). Rename-stable — the name lives only on the definition and is
 *  resolved via the id wherever it's actually needed (materialize's cell key,
 *  rendering). No name→schema resolution tier, no deferred/rename re-derive. */
export const propertyFieldContent = (fieldId: string): string =>
  referenceBlockContentForId(fieldId)

const finiteNumberFromContent = (content: string): number => {
  const value = Number(content.trim())
  if (!Number.isFinite(value)) throw new CodecError('finite number content', content)
  return value
}

const booleanFromContent = (content: string): boolean => {
  const normalized = content.trim().toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false
  throw new CodecError('boolean content', content)
}

const jsonFromContent = (content: string): unknown => {
  try {
    return JSON.parse(content)
  } catch (err) {
    throw new CodecError('JSON content', err)
  }
}

const codecAcceptsNull = (schema: AnyPropertySchema): boolean => {
  try {
    schema.codec.decode(null)
    return true
  } catch {
    return false
  }
}

/** Is `s` the literal encoded-null sentinel, or a quoted string that would
 *  collide with it one escaping level down (recursive, so `"null"` itself
 *  round-trips through an extra layer of `JSON.stringify`)? Only meaningful
 *  when the codec actually treats bare `'null'` content as the null
 *  sentinel (`codecAcceptsNull`) — otherwise there's no collision to guard
 *  against and the string should stay verbatim. Verbatim string-family
 *  codecs (`string` | `url` | `ref`) store values as raw content, so a
 *  legitimate string value equal to the sentinel — or to a JSON string
 *  literal that itself needs escaping — must be escaped via
 *  `JSON.stringify` instead of written through untouched. */
const needsEscape = (schema: AnyPropertySchema, s: string): boolean => {
  if (!codecAcceptsNull(schema)) return false
  const trimmed = s.trim()
  if (trimmed === 'null') return true
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'string') return needsEscape(schema, parsed)
    } catch {
      // not valid JSON — falls through to "no escaping needed"
    }
  }
  return false
}

const encodedValueToContent = (schema: AnyPropertySchema, encoded: unknown): string => {
  if (encoded === undefined) return ''
  if (encoded === null) return codecAcceptsNull(schema) ? 'null' : ''
  if (
    schema.codec.type === 'string'
    || schema.codec.type === 'url'
    || schema.codec.type === 'ref'
  ) {
    if (typeof encoded !== 'string') return JSON.stringify(encoded)
    return needsEscape(schema, encoded) ? JSON.stringify(encoded) : encoded
  }
  if (schema.codec.type === 'date') {
    if (typeof encoded !== 'string') return JSON.stringify(encoded)
    return encoded
  }
  if (schema.codec.type === 'number' || schema.codec.type === 'boolean') {
    return String(encoded)
  }
  const serialized = JSON.stringify(encoded)
  return serialized === undefined ? '' : serialized
}

const contentToEncodedValue = (schema: AnyPropertySchema, content: string): unknown => {
  if (
    (schema.codec.type === 'string' || schema.codec.type === 'url' || schema.codec.type === 'ref')
    && content.trim().startsWith('"') && content.trim().endsWith('"')
  ) {
    try {
      const parsed: unknown = JSON.parse(content.trim())
      if (typeof parsed === 'string' && needsEscape(schema, parsed)) return parsed
    } catch {
      // not valid JSON — falls through to the sentinel/default handling below
    }
  }
  if (content.trim() === 'null' && codecAcceptsNull(schema)) {
    return schema.codec.encode(schema.codec.decode(null))
  }
  switch (schema.codec.type) {
    case 'string':
    case 'url':
    case 'ref':
      return content
    case 'date':
      return content.trim() === '' ? null : content.trim()
    case 'number':
      return finiteNumberFromContent(content)
    case 'boolean':
      return booleanFromContent(content)
    default:
      return jsonFromContent(content)
  }
}

/** Serialize a typed property value into the editable content of its
 *  backing child. Scalars stay human-readable; structured values fall
 *  back to their codec-encoded JSON. */
export const propertyValueToChildContent = <T>(
  schema: PropertySchema<T>,
  value: T,
): string => encodedValueToContent(schema, schema.codec.encode(value))

export const encodedPropertyValueToChildContent = (
  schema: AnyPropertySchema,
  encoded: unknown,
): string => encodedValueToContent(schema, encoded)

/** Parse a property-value child back into the canonical encoded value
 *  stored on the parent cell. Throws when the child content cannot be
 *  interpreted for this field's current codec. */
export const propertyChildContentToEncodedValue = (
  schema: AnyPropertySchema,
  content: string,
): unknown => {
  const encoded = contentToEncodedValue(schema, content)
  // Decode and re-encode so tolerant user text ("1" for number,
  // date strings, etc.) lands in the same canonical JSON shape as
  // tx.setProperty would have stored directly.
  return schema.codec.encode(schema.codec.decode(encoded))
}

export const propertiesEqual = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => jsonValuesEqual(a, b)

/** §9 ancestry rule, shared walk: does `startId`'s parent chain pass through
 *  a field row? Role is positional and inherits — everything beneath a
 *  field row is property-subtree interior (values, comments, ordinary
 *  content), so listings there never filter "field rows" out (a ref-typed
 *  VALUE pointing at a definition block would otherwise vanish).
 *
 *  `getRow` and `memo` are caller-owned: the tx engine walks live SQL rows
 *  through its per-tx cache; the migration pass walks via `tx.get` through a
 *  per-tx Map built fresh per chunk. Either way the memo is filled for every
 *  id visited on the walk (not just the terminal one), backfilling shared
 *  prefixes across repeated calls within the same tx. */
export const isInsidePropertySubtreeWalk = async (
  startId: string | null,
  getRow: (id: string) => Promise<Pick<BlockData, 'referenceTargetId' | 'parentId'> | null>,
  isFieldDefinition: IsPropertyFieldDefinition,
  memo: Map<string, boolean>,
): Promise<boolean> => {
  const walked: string[] = []
  const onPath = new Set<string>()
  let currentId: string | null = startId
  let result: boolean | undefined
  while (currentId !== null) {
    // Sync-introduced parent_id cycles are an accepted-reachable DB state
    // (detection-only telemetry, issue #183); every sibling walker guards
    // (SUBTREE_SQL's INSTR check, replayApplicationOrder's onPath set, the
    // SQL twin's depth cap). Treat a revisit — or pathological depth — as
    // "not inside" and stop, mirroring the SQL predicate's depth < 100.
    if (onPath.has(currentId) || walked.length >= 100) { result = false; break }
    const cached = memo.get(currentId)
    if (cached !== undefined) { result = cached; break }
    const row = await getRow(currentId)
    if (row === null) { result = false; break }
    walked.push(currentId)
    onPath.add(currentId)
    if (isPropertyFieldInstance(row, isFieldDefinition)) {
      result = true
      break
    }
    currentId = row.parentId
  }
  const resolved = result ?? false
  for (const walkedId of walked) memo.set(walkedId, resolved)
  return resolved
}
