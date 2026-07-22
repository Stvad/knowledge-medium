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
  type Tx,
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
 *   - the §9 ancestry gate — a parent whose chain passes through a field row is
 *     property-subtree interior (its children are values/comments, never field
 *     rows), so it is never re-keyed;
 *   - the SWAP-SAFE apply — drop EVERY old name before assigning ANY new one, so
 *     a name swap (`a<->b` in one tx) never leaves an intermediate `{b:<a>}` that
 *     clobbers b (and `propertiesEqual` skips the write when nothing changed).
 *  `computePlan` receives the parent's live children and returns the drops +
 *  assignments — the ONLY part the two callers differ in (rename projects the
 *  first parseable value under the tx-start codec; the batch iterates all
 *  values, canonicalizes them under the possibly-new codec, and counts
 *  unconvertibles). The write is `skipMetadata` machinery, not a "last edited"
 *  bump. */
export const rekeyParentPropertyCell = async (
  tx: Tx,
  parentId: string,
  isFieldDefinition: IsPropertyFieldDefinition,
  memo: Map<string, boolean>,
  computePlan: (children: readonly BlockData[]) => Promise<CellRekeyPlan>,
): Promise<void> => {
  const parent = await tx.get(parentId)
  if (parent === null || parent.deleted) return
  if (await isInsidePropertySubtreeWalk(
    parentId, (id) => tx.get(id), isFieldDefinition, memo,
  )) return
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
 *  property value child at all. Recognition reuses the canonical
 *  visible-children exclusion (`hidePropertyChildren`) rather than
 *  re-deriving `isPropertyFieldInstance` + the ancestry walk by hand — a
 *  parent qualifies as "the field row a value hangs off of" exactly when the
 *  visible view (which already encodes the flip gate, definition-ness, and
 *  the §9 ancestry rule) excludes it from its own parent's children. */
const propertyValueFieldRow = async (
  tx: Tx,
  source: Pick<BlockData, 'parentId' | 'workspaceId'>,
): Promise<BlockData | null> => {
  if (source.parentId === null) return null
  const parent = await tx.get(source.parentId)
  if (parent === null) return null
  return (await isPropertyFieldRow(tx, parent)) ? parent : null
}

/**
 * Is `row` ITSELF a recognized property field row — the `((fieldId))` child
 * that carries a property's identity on its owner (PR #288 §9)?
 *
 * Same canonical recognition as `isPropertyValueRow` (which is defined in
 * terms of this): a field row is exactly a child the visible view filters out
 * of its own parent's children, so the flip gate, definition-ness, and the §9
 * ancestry rule all come along.
 *
 * Write paths need this for the same reason they need the value-row check, one
 * level up: a field row's content IS the property's identity, so rewriting it
 * doesn't corrupt a value, it detaches the property from its owner entirely
 * (see `inlineDeletedBlockReferences` — deleting a DEFINITION block would
 * otherwise inline every field row keyed to it).
 */
export const isPropertyFieldRow = async (
  tx: Tx,
  row: Pick<BlockData, 'id' | 'parentId' | 'workspaceId' | 'referenceTargetId'>,
): Promise<boolean> => {
  if (row.parentId === null) return false
  // Cheap pre-filter: the recognition column is stamped on every field row, so
  // an unstamped row can't be one and needs no sibling query.
  if (row.referenceTargetId === null) return false
  if (!(await tx.isPropertyChildBackedWorkspace(row.workspaceId))) return false
  const siblings = await tx.childrenOf(
    row.parentId, row.workspaceId, {hidePropertyChildren: true},
  )
  return !siblings.some(sibling => sibling.id === row.id)
}

/**
 * Is `source` a property VALUE row — the direct child of a recognized field
 * row (PR #288 §9)? Shared write-side primitive: a value child's content IS
 * the property's value (ref-typed as `((targetId))`, scalar-typed as its
 * codec's canonical text), so any write path that rewrites `content` without
 * knowing this can corrupt a typed value or silently detach it from its
 * owner's projected cell (see `inlineDeletedBlockReferences` — #404 item 4 —
 * and the find-replace codec guard — #404 item 5 — for two call sites that
 * need exactly this question answered before they write).
 *
 * Recognition is the canonical one: a field row is exactly a child the
 * visible view filters out, so this asks that view rather than re-deriving
 * the rule (flip gate, definition-ness, and the §9 ancestry rule all come
 * with it — including "nothing inside a property subtree is a field row",
 * which is why a comment BENEATH a value keeps ordinary content semantics).
 */
export const isPropertyValueRow = async (
  tx: Tx,
  source: Pick<BlockData, 'parentId' | 'workspaceId'>,
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
  source: Pick<BlockData, 'parentId' | 'workspaceId'>,
): Promise<AnyPropertySchema | null> => {
  const fieldRow = await propertyValueFieldRow(tx, source)
  const fieldId = fieldRow?.referenceTargetId ?? null
  if (fieldId === null) return null
  return tx.resolvePropertyFieldSchema(source.workspaceId, fieldId)
}
