/**
 * Pure helpers for properties-as-blocks field/value children (PR #288 §5/§9,
 * extracted from the PR #285 spike). A property on a block is a FIELD ROW —
 * a child whose content is the MARKED field form `::((fieldId))` (§7 grammar
 * box: `::` + one whole-block reference span), mirrored into the local
 * `reference_target_id` + `is_field_form` columns — whose own
 * child holds the value (scalar-first: one primary value child). Addressing
 * is BY ID for the canonical form: `reference_target_id` derives textually
 * from the content (no name→schema tier), and the name is
 * recovered by resolving the id → definition wherever it's needed.
 *
 * Recognition (§9) is FLAT — a column read plus context, never a content
 * parse and never an ancestry walk: `is_field_form = 1` (the marker matched)
 * ∧ non-null parent ∧ `reference_target_id` resolves a definition
 * (fieldId-keyed, shadow-tolerant) ∧ the WORKSPACE is flipped
 * (`properties_migration` at or past 'children'). Content-intrinsic and
 * identical at every depth: a `::` child of ANY block — value rows included —
 * is that block's field row, and an unmarked ref targeting a definition is a
 * plain reference block, full stop (the bit is what makes ref-typed values
 * pointing at definitions unambiguous — no positional rule needed). Callers
 * own the flip gate; these helpers own the bit/column/definition half.
 *
 * A field row's VALUE SET is exactly its `is_field_form IS NOT 1` children
 * (`isFieldValueChild` / the SQL twin) — a binding selection discipline
 * (§9): every site that enumerates values or selects "the field row for
 * this fieldId" filters by the bit, or a nested `::` row materialized under
 * a field row could be selected as its value and overwritten.
 */

import {
  CodecError,
  type AnyPropertySchema,
  type BlockData,
  type PropertySchema,
  type Tx,
} from '@/data/api'
import { FIELD_FORM_MARKER, referenceBlockContentForId } from '@/data/referenceBlock'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical'

export const getPropertyFieldTargetId = (
  data: Pick<BlockData, 'referenceTargetId'> | null | undefined,
): string | undefined => data?.referenceTargetId ?? undefined

/** Synchronous fieldId → "is a resolvable definition" predicate, bound to a
 *  workspace registry snapshot by the caller (SameTxCtx /
 *  TxImpl.propertySchemaResolverFor). Shadowed definitions COUNT — losers
 *  stay fieldId-resolvable so their field rows keep classifying (§6). */
export type IsPropertyFieldDefinition = (fieldId: string) => boolean

/** The flat §9 predicate, bit/column/definition half — the caller supplies
 *  only the flip gate. All three conditions here are content-intrinsic
 *  (recognition is move-proof at any non-root position): the marker bit,
 *  the non-null parent (root half: a workspace-root row has no owner to be
 *  a field OF — its marker is just content; the SQL twins carry the same
 *  `parent_id IS NOT NULL` clause), and the shadow-tolerant definition
 *  resolution of the target. Defined ONCE and composed by every selection
 *  site (§9's named-predicate discipline — hand-rolled restatements are the
 *  recorded failure mode). */
export const isPropertyFieldInstance = (
  data: Pick<BlockData, 'referenceTargetId' | 'parentId' | 'isFieldForm'> | null | undefined,
  isFieldDefinition: IsPropertyFieldDefinition,
): boolean => {
  if (data?.isFieldForm !== true) return false
  if (data.parentId === null) return false
  const fieldId = getPropertyFieldTargetId(data)
  return fieldId !== undefined && isFieldDefinition(fieldId)
}

/** The value-set half of §9's binding selection discipline: a field row's
 *  values are exactly its children where the bit is NOT set. The bit is
 *  NULL for every underived/unmarked row (never stamped `0`), so the JS
 *  test treats undefined/false as "value candidate" — matching the SQL
 *  twin `is_field_form IS NOT 1`, never `= 0`. */
export const isFieldValueChild = (
  data: Pick<BlockData, 'isFieldForm'>,
): boolean => data.isFieldForm !== true

/** SQL fragment twin of {@link isFieldValueChild} for value-set filters. */
export const FIELD_VALUE_CHILD_SQL_PREDICATE = 'is_field_form IS NOT 1'

/** Field-row content: the §7 marked field form — the `::` marker + an exact
 *  block-ref to the definition BY ID (`::((fieldId))`). Canonical and
 *  rename-stable — the name lives only on the definition and is resolved via
 *  the id wherever it's actually needed (materialize's cell key, rendering).
 *  `referenceBlockContentForId` guards the span round-trip; the marker
 *  composes safely (a span never starts with whitespace or `:`). */
export const propertyFieldContent = (fieldId: string): string =>
  FIELD_FORM_MARKER + referenceBlockContentForId(fieldId)

const finiteNumberFromContent = (content: string): number => {
  const trimmed = content.trim()
  // `Number('')` and `Number('   ')` are 0, not NaN, so the isFinite guard
  // below waves blank content through as a real zero — a cleared value row
  // would silently project 0 over the cell (PR #386 review). Blank is not the
  // encoding of any number (`encodedValueToContent` writes `String(n)`, and
  // reserves '' for undefined), so it's unparseable: throwing preserves the
  // row's text and surfaces the count, rather than inventing a value.
  if (trimmed === '') throw new CodecError('finite number content', content)
  const value = Number(trimmed)
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
  if (schema.codec.type === 'ref') {
    // A ref value child holds the reference in editable `((id))` form — the
    // same block-reference affordance as everywhere else, and the same shape
    // as the field row's own `((fieldId))` — so `core.deriveReferenceTarget`
    // stamps it and reference maintenance (merge retarget, inline-deleted)
    // sees it. The CELL keeps a bare id (`codecs.ref` encodes via `string`);
    // only the child content is reference-shaped.
    if (typeof encoded !== 'string') return JSON.stringify(encoded)
    // An EMPTY ref is not a reference — it is the absence of one. `codecs.ref`
    // encodes a cleared/default ref as EXACTLY `''`, and rendering that as
    // `(())` would be unparseable content that `referenceBlockContentForId`
    // refuses, aborting the whole tx over a normal "clear this property" write.
    // Empty content is right here: the row survives, its derived column stays
    // NULL, and the projection reads the key as unset. Match `''` EXACTLY, not
    // `.trim() === ''`: a whitespace-only id is a MALFORMED reference (not a
    // clear), so it must reach `referenceBlockContentForId` — which throws on a
    // whitespace/parens id — rather than silently unsetting the property here,
    // the same silent property-loss that guard exists to prevent (Codex #386).
    if (encoded === '') return ''
    return referenceBlockContentForId(encoded)
  }
  if (
    schema.codec.type === 'string'
    || schema.codec.type === 'url'
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

const contentToEncodedValue = (
  schema: AnyPropertySchema,
  content: string,
  referenceTargetId: string | null,
): unknown => {
  if (
    (schema.codec.type === 'string' || schema.codec.type === 'url')
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
    case 'ref':
      // The column IS the decoded ref value: DERIVE already parsed the content
      // (`((id))` textually, `[[alias]]` via lookup) and stored the result,
      // keeping "column is null iff content isn't a resolvable exact ref". So
      // we re-use that parse instead of re-doing it — and a NULL column means
      // the content is prose / a dangling ref: unparseable, so the projection
      // skips it and the cell reads unset while the row keeps its text. The
      // explicit-null case for an optional ref is handled by the sentinel
      // above, before we get here.
      if (referenceTargetId === null) {
        throw new CodecError('resolvable reference', content)
      }
      return referenceTargetId
    case 'string':
    case 'url':
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
 *  interpreted for this field's current codec.
 *
 *  `referenceTargetId` is the value child's derived column — the source of
 *  truth for a `ref`-typed value (its content is the `((id))` edit affordance,
 *  the column is the resolved id). Every caller has the row in hand; pass
 *  `row.referenceTargetId ?? null`. It is unused for non-ref codecs. */
export const propertyChildContentToEncodedValue = (
  schema: AnyPropertySchema,
  content: string,
  referenceTargetId: string | null = null,
): unknown => {
  const encoded = contentToEncodedValue(schema, content, referenceTargetId)
  // Decode and re-encode so tolerant user text ("1" for number,
  // date strings, etc.) lands in the same canonical JSON shape as
  // tx.setProperty would have stored directly.
  const decoded = schema.codec.decode(encoded)
  try {
    return schema.codec.encode(decoded)
  } catch {
    // Lenient-read codec whose write side is stricter than its read side —
    // `enum` is the case that matters: `decode` deliberately accepts a value
    // whose option was later removed/renamed so it "still decodes and stays
    // editable" (codecs.ts), while `encode` rejects it. Canonicalizing through
    // the CURRENT option set would turn a value the codec intends to preserve
    // into "unparseable", and the caller (projection / B2 re-encode) would drop
    // the parent key — silent data loss on a config change, and a regression
    // against the cell era, which keeps such a value until it is re-set.
    // It decoded, so it is readable: keep the stored encoding as-is rather
    // than canonicalizing. A genuine shape error still throws out of `decode`.
    return encoded
  }
}

export const propertiesEqual = (
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean => jsonValuesEqual(a, b)

/** The names to drop and the assignments to set on ONE parent's cell — the
 *  divergent value-handling half of a definition re-key, computed by the
 *  caller from the parent's live children. */
export interface CellRekeyPlan {
  readonly oldNames: readonly string[]
  readonly assignments: ReadonlyArray<{name: string; value: unknown; unset?: boolean}>
}

/** Apply a swap-safe property-cell re-key to one parent — shared by the same-tx
 *  rename processor (`core.migratePropertyRename`) and the deferred codec-change
 *  batch (`Repo.runPropertyDefinitionMigrationBatch`). Owns the parts that must
 *  stay IDENTICAL across both, so the load-bearing invariant lives in one place:
 *   - the parent guard (skip a missing/deleted parent);
 *   - the SWAP-SAFE apply — drop EVERY old name before assigning ANY new one, so
 *     a name swap (`a<->b` in one tx) never leaves an intermediate `{b:<a>}` that
 *     clobbers b (and `propertiesEqual` skips the write when nothing changed).
 *  No ancestry gate exists anymore (§9 flat recognition): ANY block owning
 *  recognized field rows — value rows and field rows included — re-keys like
 *  every other owner; its `::` children are its field rows at any depth.
 *  `computePlan` receives the parent's live children and returns the drops +
 *  assignments — the ONLY part the two callers differ in (rename projects the
 *  first parseable value under the tx-start codec; the batch iterates all
 *  values, canonicalizes them under the possibly-new codec, and counts
 *  unconvertibles). The write is `skipMetadata` machinery, not a "last edited"
 *  bump. */
export const rekeyParentPropertyCell = async (
  tx: Tx,
  parentId: string,
  computePlan: (children: readonly BlockData[]) => Promise<CellRekeyPlan>,
): Promise<void> => {
  const parent = await tx.get(parentId)
  if (parent === null || parent.deleted) return
  const {oldNames, assignments} = await computePlan(
    await tx.childrenOf(parentId, undefined),
  )
  const next = {...parent.properties}
  for (const name of oldNames) delete next[name]
  for (const assignment of assignments) {
    if (assignment.unset) delete next[assignment.name]
    else next[assignment.name] = assignment.value
  }
  if (propertiesEqual(parent.properties, next)) return
  await tx.update(parentId, {properties: next}, {skipMetadata: true})
}

/** Shared by `isPropertyValueRow` / `resolvePropertyValueFieldSchema`: the
 *  field row `source` is a value child of, or null when `source` isn't a
 *  property value child at all — its parent, when that parent is a
 *  recognized field row AND `source` itself is not a `::` row (a marked
 *  child of a field row is that field row's own nested field row, never its
 *  value — §9's binding selection discipline). */
const propertyValueFieldRow = async (
  tx: Tx,
  source: Pick<BlockData, 'parentId' | 'workspaceId' | 'isFieldForm'>,
): Promise<BlockData | null> => {
  if (source.parentId === null) return null
  if (!isFieldValueChild(source)) return null
  const parent = await tx.get(source.parentId)
  if (parent === null) return null
  return (await isPropertyFieldRow(tx, parent)) ? parent : null
}

/**
 * Is `row` ITSELF a recognized property field row — the `::((fieldId))`
 * child that carries a property's identity on its owner (PR #288 §9)?
 * The flat predicate directly: bit ∧ non-null parent ∧ shadow-tolerant
 * definition resolution (`tx.isPropertyFieldDefinition`) ∧ flip gate.
 *
 * Write paths need this for the same reason they need the value-row check, one
 * level up: a field row's content IS the property's identity, so rewriting it
 * doesn't corrupt a value, it detaches the property from its owner entirely
 * (see `inlineDeletedBlockReferences` — deleting a DEFINITION block would
 * otherwise inline every field row keyed to it).
 */
export const isPropertyFieldRow = async (
  tx: Tx,
  row: Pick<BlockData, 'id' | 'parentId' | 'workspaceId' | 'referenceTargetId' | 'isFieldForm'>,
): Promise<boolean> => {
  // Cheap pre-filters first: the bit is stamped on every field row, so an
  // unmarked row can't be one and needs no flip probe.
  if (row.isFieldForm !== true) return false
  if (row.parentId === null) return false
  if (!(await tx.isPropertyChildBackedWorkspace(row.workspaceId))) return false
  return isPropertyFieldInstance(row, (fieldId) =>
    tx.isPropertyFieldDefinition(row.workspaceId, fieldId))
}

/**
 * Is `source` a property VALUE row — the direct non-`::` child of a
 * recognized field row (PR #288 §9)? Shared write-side primitive: a value
 * child's content IS
 * the property's value (ref-typed as `((targetId))`, scalar-typed as its
 * codec's canonical text), so any write path that rewrites `content` without
 * knowing this can corrupt a typed value or silently detach it from its
 * owner's projected cell (see `inlineDeletedBlockReferences` — #404 item 4 —
 * and the find-replace codec guard — #404 item 5 — for two call sites that
 * need exactly this question answered before they write).
 */
export const isPropertyValueRow = async (
  tx: Tx,
  source: Pick<BlockData, 'parentId' | 'workspaceId' | 'isFieldForm'>,
): Promise<boolean> => (await propertyValueFieldRow(tx, source)) !== null

/** If `source` is a property VALUE row, resolve the schema its field row is
 *  keyed to — null when `source` isn't a value row, OR when the field's
 *  fieldId doesn't resolve to an active schema (shadowed/orphaned/foreign-
 *  workspace definitions never project into a cell, per
 *  `tx.resolvePropertyFieldSchema`, so there is no live codec to validate
 *  against). Lets a write path check, BEFORE writing, whether a proposed new
 *  `content` would still decode under the owning property's codec (#404
 *  item 5 — `applyContentReplaceMutator` is the first caller). */
export const resolvePropertyValueFieldSchema = async (
  tx: Tx,
  source: Pick<BlockData, 'parentId' | 'workspaceId' | 'isFieldForm'>,
): Promise<AnyPropertySchema | null> => {
  const fieldRow = await propertyValueFieldRow(tx, source)
  const fieldId = fieldRow?.referenceTargetId ?? null
  if (fieldId === null) return null
  return tx.resolvePropertyFieldSchema(source.workspaceId, fieldId)
}
