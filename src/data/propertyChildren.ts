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
 * (fieldId-keyed, shadow-tolerant). NOT gated on the workspace flip — the
 * backfill mints field and value rows while the workspace still reads cells,
 * so recognition has to answer the same either side of it. What the flip
 * column governs is the READ/WRITE direction (the processors, dormant
 * pre-flip), not whether a row IS machinery.
 *
 * Recognizing a row is not the same as HIDING it, and this file owns only the
 * first. Property children are ordinary blocks — that is the point of the
 * model, not a leak — so listing them is the default and exclusion is opt-IN
 * (`hidePropertyChildren`), which most queries do not even offer. The one
 * surface that hides ALL recognized rows today does so as an accepted interim
 * pending §10's tier-aware predicate; see `visibleChildren.ts`.
 * Content-intrinsic and
 * identical at every depth: a `::` child of ANY block — value rows included —
 * is that block's field row, and an unmarked ref targeting a definition is a
 * plain reference block, full stop (the bit is what makes ref-typed values
 * pointing at definitions unambiguous — no positional rule needed). Callers
 * own the read/write-DIRECTION gate (is the cell or the child the truth);
 * these helpers own the bit/column/definition half, flipped or not.
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
import {
  FIELD_FORM_MARKER,
  isGrammarShapedLabel,
  isIdCarryingReference,
  parseExactReferenceBlockContent,
  referenceBlockContentForId,
} from '@/data/referenceBlock'
import { jsonValuesEqual } from '@/data/internals/jsonCanonical'
import { hasLoneSurrogate } from '@/utils/string'

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

/** A field row's value set — `childrenOf` narrowed by `isFieldValueChild`.
 *
 *  One helper for both writers on purpose: `tx.setProperty`'s eager
 *  dual-write and the deferred materialize processor each select this set
 *  before overwriting or folding what they find in it, so they must not be
 *  able to disagree about what counts. Narrow it here, never at a call
 *  site. */
export const fieldValueChildren = async (
  tx: Pick<Tx, 'childrenOf'>,
  fieldRowId: string,
): Promise<BlockData[]> =>
  (await tx.childrenOf(fieldRowId, undefined)).filter(isFieldValueChild)


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

/** The characters every reference span OPENS with. Escaping these is what
 *  makes {@link escapeContent}'s output inert to BOTH readers of the grammar:
 *  quoting alone only stops the whole-block parser, and the inline one
 *  (`plugins/references/referenceParser`) scans spans anywhere in content, so
 *  a merely-quoted `"[[Page]]"` is still an inline reference that a rename
 *  rewrites — silently editing the value. Stated as the opener set rather than
 *  by consulting the inline parser because core cannot import a plugin, and
 *  because no span form in either reader can begin any other way. */
const SPAN_OPENERS_RE = /[[(]/g

/** Would this text, stored VERBATIM as a value row's content, be read as
 *  something other than the text it is — losing the value (#688)? Two shapes:
 *  a §7 reference span, which `deriveReferenceColumns` classifies instead of
 *  storing (marked, it stamps `is_field_form`, and `isFieldValueChild` then
 *  drops the row from the value set, taking the owner's key with it); and a
 *  lone surrogate, which the content column returns as U+FFFD.
 *
 *  One definition, two callers with opposite remedies, which is the reason it
 *  is named rather than inlined into `needsEscape`: a writer going through
 *  `encodedValueToContent` ESCAPES (below), while a writer that rewrites
 *  content directly cannot escape without changing what the user asked for,
 *  and must REFUSE — see {@link contentLosesPropertyValue}. */
const verbatimContentLosesValue = (content: string): boolean =>
  isGrammarShapedLabel(content) || hasLoneSurrogate(content)

/** The refusal half of {@link verbatimContentLosesValue}, for write paths that
 *  set a value row's `content` DIRECTLY rather than encoding a typed value —
 *  find-replace is the one caller. Those bypass `encodedValueToContent`, so
 *  they get no escaping and the value is silently lost instead.
 *
 *  Scoped to the codecs that store content verbatim: everything else either
 *  emits machine-formatted text that cannot take these shapes, or (`ref`) is
 *  span-shaped by design and already refused by its own decode. */
export const contentLosesPropertyValue = (
  schema: AnyPropertySchema,
  content: string,
): boolean =>
  (schema.codec.type === 'string' || schema.codec.type === 'url')
  && verbatimContentLosesValue(content)

/** Store `s` as content that reads back as exactly `s` and as nothing else.
 *  `JSON.stringify` carries the value (and spells lone surrogates as ASCII
 *  escapes); the extra opener escaping neutralizes the reference grammar.
 *  `JSON.parse` undoes both, so `contentToEncodedValue` needs no counterpart. */
const escapeContent = (s: string): string =>
  JSON.stringify(s).replace(SPAN_OPENERS_RE,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** Would `s`, written VERBATIM as a value child's content, read back as
 *  something other than `s`? These codecs (`string` | `url`) store a value as
 *  raw content, so any divergence is silent value loss — the projection reads
 *  the child back and writes THAT over the owner's cell. Only strings that hit
 *  one of the three cases are escaped; every other string stays verbatim in
 *  the tree.
 *   - the encoded-null SENTINEL: bare `null` content IS the null value to a
 *     codec that accepts one. Gated on `codecAcceptsNull` — elsewhere there is
 *     no collision, and the string stays verbatim.
 *   - a reference SPAN (§7): `deriveReferenceColumns` reads such content
 *     instead of storing it. Marked, it stamps `is_field_form`, which
 *     `isFieldValueChild` filters out of the value set — the projection finds
 *     nothing and drops the owner's key (#688). Unmarked, it becomes a live
 *     reference rather than text.
 *   - a LONE SURROGATE: the content column returns U+FFFD, and the projection
 *     writes that back over the cell. Measured as the ONLY mangling shape —
 *     NUL, C0 controls, newlines and padding all round-trip verbatim — so the
 *     test is well-formedness, not a character blacklist.
 *
 *  Recursive on the quoted form, or a value that is ITSELF a JSON string
 *  literal of an escapable string would decode one level short. The recursion
 *  is unbounded but the ESCAPE is applied once: `escapeContent`'s output opens
 *  with `"`, carries no span opener and no raw surrogate, so it can never
 *  itself need escaping. */
const needsEscape = (schema: AnyPropertySchema, s: string): boolean => {
  const trimmed = s.trim()
  if (codecAcceptsNull(schema) && trimmed === 'null') return true
  if (verbatimContentLosesValue(s)) return true
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
    return needsEscape(schema, encoded) ? escapeContent(encoded) : encoded
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
    case 'ref': {
      // The gate is this content's FORM, never `reference_target_id`'s
      // nullness (§9; PR #417 review). The column is not the "is this a ref
      // value" signal it looks like: `core.deriveReferenceTarget` stamps it
      // for a whole-block `[[alias]]` too, and a `[[alias]]` nothing claims
      // MINTS a seat and then resolves. So trusting any non-null target
      // silently coerced prose typed into a ref property — `[[Mary]]`, or a
      // typo'd `[[Marry]]` binding a fresh empty seat — into whatever that
      // name pointed at, overwriting the id the property held.
      //
      // `isIdCarryingReference` is the same fragment `deriveReferenceColumns`
      // branches on, and those forms resolve TEXTUALLY there — no lookup, no
      // minting — so `exact.id` is exactly what the column would hold,
      // computed from the same parser rather than as a second policy. Reading
      // it here also means a row whose stamp hasn't landed yet (raw write,
      // sync arrival before the derive seam) projects correctly instead of
      // reading unset.
      //
      // Refusing a name row is the whole point: the row keeps its text and
      // stays visible/fixable in the tree while the cell key reads unset.
      // Refs are identity, and a ref property that silently followed a name
      // would be a different feature. For a REQUIRED ref this clause is
      // defence in depth — `codecs.ref`'s own `decode(undefined)` throws
      // downstream anyway — but for `optionalRef` it is the only thing that
      // refuses: `decode(undefined)` there returns undefined, which
      // `firstProjectedFieldValue` reads as "nothing parsed", so it would
      // stop scanning and skip a LATER value child that does name an id.
      //
      // `fieldForm` is refused because `::((id))` is a FIELD ROW (§7),
      // machinery rather than a value. Reachable through find-replace, whose
      // value guard asks this function whether the PROPOSED content still
      // decodes — a replace that prepends `::` to a ref value would otherwise
      // pass the guard, get written, leave the value set (the bit stamps
      // same-tx), and drop the owner's key with no error.
      const exact = parseExactReferenceBlockContent(content)
      if (!isIdCarryingReference(exact) || exact.fieldForm) {
        throw new CodecError('id-carrying reference', content)
      }
      return exact.id
    }
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
 *  A function of `content` ALONE — for every codec including `ref`, which
 *  parses the id out of the id-carrying span rather than reading the derived
 *  column (see the `ref` case). That makes this decode answerable about
 *  PROPOSED content, which is what find-replace's value guard needs, and
 *  independent of whether a row's stamp has landed yet. */
export const propertyChildContentToEncodedValue = (
  schema: AnyPropertySchema,
  content: string,
): unknown => {
  const encoded = contentToEncodedValue(schema, content)
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
 * definition resolution (`tx.isPropertyFieldDefinition`). Not flip-gated —
 * see the module header: the backfill mints these rows before the flip, and
 * these consumers REWRITE CONTENT, so a gate here is a window in which
 * deleting a definition or a linked page mangles real property machinery.
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
  // One cheap pre-filter, and it earns its place: the bit is stamped on every
  // field row, so an unmarked row is decided without the async definition
  // lookup. The remaining conditions (non-null parent, resolvable definition)
  // are the composed predicate's own — restating them here would just be a
  // second copy to keep in sync.
  if (row.isFieldForm !== true) return false
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
