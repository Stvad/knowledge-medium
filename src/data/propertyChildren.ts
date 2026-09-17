/**
 * Pure helpers for properties-as-blocks field/value children
 * (docs/properties-as-blocks-migration.html §5/§9). A property on a block is a FIELD ROW —
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
  memberCodecOf,
  type AnyCodec,
  type AnyPropertySchema,
  type BlockData,
  type Tx,
} from '@/data/api'
import {
  FIELD_FORM_MARKER,
  isIdCarryingReference,
  isWholeContentReference,
  parseExactReferenceBlockContent,
  referenceBlockContentForId,
} from '@/data/referenceBlock'
import { jsonValuesEqual, persistedJsonKey } from '@/data/internals/jsonCanonical'
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
  // would silently project 0 over the cell. Blank is not the
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

/** Does this codec read `null` as a value? Answered by CALLING it, because no
 *  codec declares it — which means a required codec answers by constructing and
 *  throwing a `CodecError`, stack capture included. Memoized per codec: the
 *  member-grain paths ask once per MEMBER, so a workspace pass over every list
 *  cell would otherwise throw one Error per member of every list in the graph.
 *  Codecs are immutable and long-lived, so the cache is keyed on identity and
 *  never invalidated. */
const nullAcceptance = new WeakMap<AnyCodec, boolean>()
const codecAcceptsNull = (codec: AnyCodec): boolean => {
  const cached = nullAcceptance.get(codec)
  if (cached !== undefined) return cached
  let accepts: boolean
  try {
    codec.decode(null)
    accepts = true
  } catch {
    accepts = false
  }
  nullAcceptance.set(codec, accepts)
  return accepts
}

/** The codec ONE value child's content is encoded by: the MEMBER codec for a
 *  multi-valued property, the property's own codec otherwise.
 *
 *  The grain question asked in ONE place. Every path that touches a single
 *  value child — materialize, project, the deferred re-encode, find-replace's
 *  write guard — has to agree about it, and a site reaching for `schema.codec`
 *  directly would read a list codec's whole-array grammar against one member's
 *  text: `["a","b"]` and the string `a` are both "not an array", so the errors
 *  are silent rather than loud. */
const valueChildCodec = (schema: AnyPropertySchema): AnyCodec =>
  memberCodecOf(schema.codec) ?? schema.codec

/** The characters every reference span OPENS with. Escaping these is what
 *  makes {@link escapeContent}'s output inert to BOTH readers of the grammar:
 *  quoting alone only stops the whole-block parser, and the inline one
 *  (`plugins/references/referenceParser`) scans spans anywhere in content, so
 *  a merely-quoted `"[[Page]]"` is still an inline reference that a rename
 *  rewrites — silently editing the value. Stated as the opener set rather than
 *  by consulting the inline parser because core cannot import a plugin, and
 *  because no span form in either reader can begin any other way. */
const SPAN_OPENERS_RE = /[[(]/g
/** The same class without `g`, for `.test`. A global regex carries `lastIndex`
 *  across calls, so testing with one answers differently on alternate calls. */
const SPAN_OPENER_RE = /[[(]/

/** Would this text, stored VERBATIM as a value row's content, read back as
 *  something other than itself? A whole-content reference does — one of the
 *  two readers takes it as a pointer rather than text, EMBEDS included
 *  (`isWholeContentReference`, not `isGrammarShapedLabel`: the latter asks
 *  only the whole-block reader, which has no embed form, so `!((id))` was
 *  stored verbatim and a merge then rewrote it). A lone surrogate does too —
 *  the content column returns U+FFFD.
 *
 *  The ENCODER's question, and deliberately wider than
 *  {@link contentLosesPropertyValue}'s — see there for why the two differ. */
const verbatimContentLosesValue = (content: string): boolean =>
  isWholeContentReference(content) || hasLoneSurrogate(content)

/** Would writing this text into a value row DESTROY the property's value?
 *  For write paths that set `content` directly rather than encoding a typed
 *  value — find-replace is the one caller. They bypass
 *  `encodedValueToContent`, so they cannot escape, and must refuse instead.
 *
 *  NARROWER than {@link verbatimContentLosesValue} on purpose: only a MARKED
 *  span destroys anything — it stamps `is_field_form`, `isFieldValueChild`
 *  drops the row from the value set, and the owner's key goes with it,
 *  silently (#688). An UNMARKED span stays in the value set and decodes
 *  right back, so `Roadmap` → `[[Roadmap]]` must keep working.
 *
 *  The null SENTINEL is the third destroyer: bare `null` content IS the
 *  unset value to a codec that accepts one.
 *
 *  Scoped to the codecs that store content verbatim: everything else either
 *  emits machine-formatted text that cannot take these shapes, or (`ref`) is
 *  span-shaped by design and already refused by its own decode. */
export const contentLosesPropertyValue = (
  schema: AnyPropertySchema,
  content: string,
): boolean => {
  // At GRAIN (`valueChildCodec`): the row being rewritten is ONE value child,
  // so a `string-list` member is governed by the string rules its own content
  // was written under, not by the list codec's.
  const codec = valueChildCodec(schema)
  if (codec.type !== 'string' && codec.type !== 'url') return false
  if (content.trim() === 'null' && codecAcceptsNull(codec)) return true
  return parseExactReferenceBlockContent(content)?.fieldForm === true
    || hasLoneSurrogate(content)
}

/** Store `s` as content that reads back as exactly `s` and as nothing else.
 *  `JSON.stringify` carries the value (and spells lone surrogates as ASCII
 *  escapes); the extra opener escaping neutralizes the reference grammar.
 *  `JSON.parse` undoes both, so the decode needs no counterpart — only
 *  {@link isEscapedEnvelope} to know it is looking at one. */
const escapeContent = (s: string): string =>
  JSON.stringify(s).replace(SPAN_OPENERS_RE,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

/** Could `trimmed` have come out of {@link escapeContent}? A JSON string
 *  literal carrying no literal span opener — the two properties escapeContent
 *  guarantees, and the second is what makes the shape self-identifying rather
 *  than merely quote-shaped. Necessary, not sufficient: the caller still
 *  confirms it parses and that the payload was worth escaping. */
const isEscapedEnvelope = (trimmed: string): boolean =>
  trimmed.startsWith('"') && trimmed.endsWith('"') && !SPAN_OPENER_RE.test(trimmed)

/** Would `s`, written VERBATIM as a value child's content, read back as
 *  something other than `s`? These codecs (`string` | `url`) store a value as
 *  raw content, so any divergence is silent value loss — the projection reads
 *  the child back and writes THAT over the owner's cell. Only strings that hit
 *  one of the three cases are escaped; every other string stays verbatim in
 *  the tree.
 *   - the encoded-null SENTINEL: bare `null` content IS the null value to a
 *     codec that accepts one. Gated on `codecAcceptsNull` — elsewhere there is
 *     no collision, and the string stays verbatim.
 *   - anything {@link verbatimContentLosesValue} names, which is where those
 *     two shapes and why they lose the value are written down.
 *
 *  Recursive on the quoted form, or a value that is ITSELF a JSON string
 *  literal of an escapable string would decode one level short. The recursion
 *  is unbounded but the ESCAPE is applied once: `escapeContent`'s output opens
 *  with `"`, carries no span opener and no raw surrogate, so it can never be
 *  MISREAD once stored.
 *
 *  That is not the same as "escaping is idempotent", which it is not: fed back
 *  in as a VALUE, an envelope escapes again (the quoted-form recursion, and
 *  correctly so — a value that happens to look like an envelope is still a
 *  value). Nothing double-escapes today because every re-encode path decodes
 *  first (`runPropertyDefinitionMigrationBatch`, the materialize processor).
 *  A future one must too; content is not a value. */
const needsEscape = (codec: AnyCodec, s: string): boolean => {
  const trimmed = s.trim()
  if (trimmed === 'null' && codecAcceptsNull(codec)) return true
  if (verbatimContentLosesValue(s)) return true
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed === 'string') return needsEscape(codec, parsed)
    } catch {
      // not valid JSON — falls through to "no escaping needed"
    }
  }
  return false
}

const encodedValueToContent = (codec: AnyCodec, encoded: unknown): string => {
  if (encoded === undefined) return ''
  if (encoded === null) return codecAcceptsNull(codec) ? 'null' : ''
  if (codec.type === 'ref') {
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
    // the same silent property-loss that guard exists to prevent.
    if (encoded === '') return ''
    return referenceBlockContentForId(encoded)
  }
  if (
    codec.type === 'string'
    || codec.type === 'url'
  ) {
    if (typeof encoded !== 'string') return JSON.stringify(encoded)
    return needsEscape(codec, encoded) ? escapeContent(encoded) : encoded
  }
  if (codec.type === 'date') {
    if (typeof encoded !== 'string') return JSON.stringify(encoded)
    return encoded
  }
  if (codec.type === 'number' || codec.type === 'boolean') {
    return String(encoded)
  }
  const serialized = JSON.stringify(encoded)
  return serialized === undefined ? '' : serialized
}

const contentToEncodedValue = (
  codec: AnyCodec,
  content: string,
): unknown => {
  // Unwrap ONLY what `escapeContent` could have produced. Quote-wrapping alone
  // is not that signature: a person can type `"[[Page]]"` into a value row, and
  // find-replace can turn the inside of an ordinary quoted value into a span —
  // both then decoded to the unquoted string, silently dropping the quotes the
  // user wrote. The discriminator is free, because escaping openers is already
  // what makes the envelope inert: a real envelope carries NO literal `[` or
  // `(`, so content that has one was written by someone else and is text.
  if (
    (codec.type === 'string' || codec.type === 'url')
    && isEscapedEnvelope(content.trim())
  ) {
    try {
      const parsed: unknown = JSON.parse(content.trim())
      if (typeof parsed === 'string' && needsEscape(codec, parsed)) return parsed
    } catch {
      // not valid JSON — falls through to the sentinel/default handling below
    }
  }
  if (content.trim() === 'null' && codecAcceptsNull(codec)) {
    return codec.encode(codec.decode(null))
  }
  switch (codec.type) {
    case 'ref': {
      // The gate is this content's FORM, never `reference_target_id`'s
      // nullness (§9). The column is not the "is this a ref
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

/** Encode ONE value child's content, at {@link valueChildCodec} grain — a
 *  whole scalar value, or one member of a multi-valued property. */
export const encodedToValueChildContent = (
  schema: AnyPropertySchema,
  encoded: unknown,
): string => encodedValueToContent(valueChildCodec(schema), encoded)

/** Why the materialize direction cannot carry `encoded` as a value of
 *  `schema`, or null when it can.
 *
 *  ONE owner for the question `MATERIALIZE_PROPERTY_CHILDREN_PROCESSOR`
 *  rejects a write over, so a producer that wants to refuse a value BEFORE
 *  the write asks exactly what the processor will ask rather than a
 *  hand-rolled decode that drifts from it. Content promotion is one such
 *  producer.
 *
 *  TWO legs, because the processor takes two steps on a cell value that can
 *  fail. The second is not redundant: `codecs.ref().decode` accepts any
 *  string, while `referenceBlockContentForId` refuses one that cannot be read
 *  back as `((id))` — so a ref-typed key meeting `Some Person` passes the
 *  decode and throws at the render. It asks for EVERY value child the value
 *  implies, so a refList naming one unrenderable member is refused rather than
 *  silently losing that member at materialize time.
 *
 *  Note what that does NOT cover: `Mary` is refused by neither leg, so a
 *  ref-typed key can still take a one-word value and store it as a block id
 *  nothing resolves. This asks exactly what the processor asks, and the
 *  processor accepts that — a stricter rule belongs in a producer's own
 *  acceptance check, never here, or the two would disagree about what a write
 *  may contain. */
export interface PropertyCellValueRejection {
  readonly reason: 'decode' | 'content'
  readonly cause: unknown
}

export const propertyCellValueRejection = (
  schema: AnyPropertySchema,
  encoded: unknown,
): PropertyCellValueRejection | null => {
  try {
    schema.codec.decode(encoded)
  } catch (cause) {
    return {reason: 'decode', cause}
  }
  try {
    encodedPropertyValueToChildContents(schema, encoded)
  } catch (cause) {
    return {reason: 'content', cause}
  }
  return null
}

/** Parse ONE value child's content back into its canonical encoded form, at
 *  {@link valueChildCodec} grain. Throws when the content cannot be
 *  interpreted under that codec.
 *
 *  A function of `content` ALONE — for every codec including `ref`, which
 *  parses the id out of the id-carrying span rather than reading the derived
 *  column (see the `ref` case). That makes this decode answerable about
 *  PROPOSED content, which is what find-replace's value guard needs, and
 *  independent of whether a row's stamp has landed yet. */
export const valueChildContentToEncoded = (
  schema: AnyPropertySchema,
  content: string,
): unknown => {
  const codec = valueChildCodec(schema)
  const encoded = contentToEncodedValue(codec, content)
  // Decode and re-encode so tolerant user text ("1" for number,
  // date strings, etc.) lands in the same canonical JSON shape as
  // tx.setProperty would have stored directly.
  const decoded = codec.decode(encoded)
  try {
    return codec.encode(decoded)
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

/**
 * The content of EVERY value child backing one encoded property value, in
 * sibling order — one for a single-valued property, one PER MEMBER for a
 * multi-valued one (§5/§9: a refList is N sibling `((id))` values, not a JSON
 * array in one child). Sibling order IS list order; the reconciler that writes
 * these keeps the two the same and the projection reads them back in it.
 *
 * MULTIPLICITY IS PRESERVED: `[2, 2, 3]` is three value children, and a member
 * repeated in the value is a repeated sibling. The value children are NOT
 * deduped, though the scalar rule one grain up does fold equal-content
 * siblings — there they are redundant copies of ONE value, so folding loses
 * nothing, while here they are two members and folding would silently rewrite
 * the user's list.
 *
 * Its cost is that two devices concurrently writing `[a, b]` and `[a, c]`
 * converge to `[a, b, a, c]`. That is a conflict left VISIBLE for the user to
 * resolve by deleting a row, which is what the scalar rule does with a
 * divergent peer instead of silently choosing. Properties that are genuinely
 * sets (`types`, `alias`) get that from their WRITERS, not from storage.
 */
export const encodedPropertyValueToChildContents = (
  schema: AnyPropertySchema,
  encoded: unknown,
): string[] => {
  const member = memberCodecOf(schema.codec)
  if (member === undefined) return [encodedValueToContent(schema.codec, encoded)]
  // Callers reach here only past their own decode gate, which a list codec
  // fails on anything but an array — so this is a broken-codec assertion, not
  // a user-reachable path.
  if (!Array.isArray(encoded)) throw new CodecError('array', encoded)
  // `undefined` is ABSENCE to a scalar codec, which renders it as empty
  // content. An array ELEMENT cannot be absent: `JSON.stringify` writes it as
  // `null`, so that is what the cell already stores for it, and rendering it as
  // empty content instead would make the same `setProperty` call succeed before
  // the flip and fail after it. Normalize to the persisted form first.
  //
  // `Array.from`, never `map`: a SPARSE array is the second spelling of that
  // same absence, and `map` skips a hole without calling its callback — so the
  // normalization right above would be bypassed for exactly the element that
  // needs it, and `[, 'x']` would store what `[null, 'x']` does not.
  const members = Array.from(encoded, item => (item === undefined ? null : item))
  const contents = members.map(item => encodedValueToContent(member, item))
  // EVERY member must read back as itself. A scalar can afford a content that
  // does not round-trip — empty content is how `codecs.ref` spells a CLEARED
  // ref, and a scalar may be cleared — but a list member may not: the
  // projection reads the content, so a member that comes back as anything else
  // is silently a different list, one member shorter or one member changed,
  // with no error anywhere.
  //
  // Stated as the round trip rather than as its symptoms, because the symptoms
  // arrive one per codec: a `null` member of a `string` list renders EMPTY and
  // reads back as `''`, which the earlier "is the content empty and
  // unparseable?" test let through — the cell kept `[null]` while the child
  // said `''`, and the next projection published the `''` over it.
  //
  // HERE and not in `codecs.refList().encode`: a refList's member IS the scalar
  // ref codec, so refusing a value in the list that the member codec accepts
  // would break the `Codec.member` contract. Pre-flip, where no value child is
  // written at all, the cell → children pass reports such a key instead.
  for (const [i, content] of contents.entries()) {
    let readBack: unknown
    try {
      readBack = contentToEncodedValue(member, content)
    } catch {
      throw new CodecError('a list member that reads back from its content', members[i])
    }
    if (!jsonValuesEqual(readBack, members[i])) {
      throw new CodecError('a list member that reads back from its content', members[i])
    }
  }
  return contents
}

/**
 * Aggregate a field row's value children back into the property's encoded
 * value — `undefined` when nothing parses, which the projection reads as
 * §9's "key unset, rows stay visible and fixable".
 *
 * Single-valued: first parseable wins, unparseable siblings skipped (a
 * divergent peer is a surfaced conflict, and the cell shows the winner).
 * Multi-valued: every parseable member, in sibling order, multiplicity and all
 * ({@link encodedPropertyValueToChildContents} says why the members are not a
 * set). An unparseable MEMBER
 * drops only itself — the same rule `decodeRefListIds` already applies to a
 * malformed element of a stored list (#189), for the same reason: one bad
 * member must not strip the whole field.
 *
 * CALLED ONLY WHEN A LIVE FIELD ROW WAS OBSERVED, which is what lets a
 * multi-valued property with no parseable member answer `[]` rather than
 * `undefined`: the field row's existence IS the difference between an
 * explicitly empty list and an unset key, and removing the field row is how a
 * property is unset. Every caller gates on that first — the projection on
 * `fieldRows.length`, the rename and the deferred re-encode on `sawFieldRow` —
 * so the rule lives here rather than at each of them, and they cannot drift
 * into disagreeing about what an empty field row means.
 *
 * NO whole-list canonicalization: members are canonicalized one at a time, and
 * the `member` contract (`encode` is element-wise) makes the array of
 * canonical members the canonical array. Doing it again through the list codec
 * would also make one member's shape error throw away every other member.
 */
export const childContentsToEncodedPropertyValue = (
  schema: AnyPropertySchema,
  contents: Iterable<string>,
): unknown | undefined => {
  if (memberCodecOf(schema.codec) === undefined) {
    for (const content of contents) {
      try {
        return valueChildContentToEncoded(schema, content)
      } catch {
        // Invalid child text should not preserve a stale parent cell
        // projection. Skip it; if none parse the key is left unset.
      }
    }
    return undefined
  }
  const members: unknown[] = []
  for (const content of contents) {
    try {
      members.push(valueChildContentToEncoded(schema, content))
    } catch {
      // Drop only this member — see the note above.
    }
  }
  return members
}

/** What a value row is, for comparison. `denotesValue` is false when the row's
 *  text does not decode: such a row denotes NOTHING, which is why its `key` is
 *  its own identity and equal to nothing — not even to another row carrying the
 *  same broken text. Two rows both edited to `not a reference` are two
 *  independently fixable blocks; unlike two equal VALID members, neither is in
 *  the projected cell, so nothing can recreate one that was folded or reaped. */
export interface MemberKey {
  readonly key: string
  readonly denotesValue: boolean
}

export interface MemberKeys {
  row: (row: Pick<BlockData, 'id' | 'content'>) => MemberKey
  /** A DESIRED member's key, from the content the cell implies. Always a value
   *  key in practice — it came from the encoder — and the fallback is shaped so
   *  it can never equal a row key. */
  content: (content: string) => string
}

/** How one property's value children are compared to EACH OTHER: by decoded
 *  value for a multi-valued property, by raw text otherwise. ONE factory,
 *  because every place that folds equal value rows asks — the cross-field-row
 *  union below, the member reconciler, and the duplicate-field-row collapse —
 *  and a disagreement between any two of them is silent in both directions. */
export const memberKeysFor = (schema: AnyPropertySchema | null): MemberKeys => {
  if (schema === null || memberCodecOf(schema.codec) === undefined) {
    // Single-valued: text IS the comparison, unchanged, and equal-content
    // duplicates are copies of one value rather than occurrences.
    return {
      row: row => ({key: `c${row.content}`, denotesValue: true}),
      content: content => `c${content}`,
    }
  }
  const valueKey = (content: string): string | undefined => {
    try {
      return `v${persistedJsonKey(valueChildContentToEncoded(schema, content))}`
    } catch {
      return undefined
    }
  }
  return {
    row: row => {
      const key = valueKey(row.content)
      return key === undefined
        ? {key: `r${row.id}`, denotesValue: false}
        : {key, denotesValue: true}
    },
    content: content => valueKey(content) ?? `c${content}`,
  }
}

/**
 * Fold one definition's value rows ACROSS its field rows, into the order the
 * owner's cell reads them in.
 *
 * THE cross-field-row rule. Duplicate field rows are a transient conflict that
 * `collapseDuplicateFieldRow` resolves by folding a duplicate's member into an
 * equal one under the survivor and moving a divergent one over as a peer — so
 * this is the UNION the collapse will produce, never a concatenation.
 * Concatenating predicts a list the collapse never builds: two field rows
 * carrying the same members (two offline devices materializing one value)
 * double it, and the doubled cell is then what the reconciler is asked to
 * reproduce, minting a member to match. Every caller that aggregates a cell
 * from children comes through here for that reason — the projection, the
 * rename re-key and the deferred re-encode — because a site that skips it
 * turns a transient duplicate into permanent multiplicity.
 *
 * WITHIN one field row multiplicity is KEPT, because there two equal rows are
 * two members ({@link encodedPropertyValueToChildContents} says why).
 *
 * Each entry carries the content the caller will PUBLISH, which is not always
 * the row's stored text — the re-encode pass canonicalizes a member first, and
 * passes the canonical form so what it unions is what it publishes.
 */
export const unionValuesAcrossFieldRows = <T extends Pick<BlockData, 'id' | 'content'>>(
  schema: AnyPropertySchema | null,
  perFieldRow: readonly (readonly T[])[],
): T[] => {
  const keys = memberKeysFor(schema)
  const unioned: T[] = []
  const seen = new Set<string>()
  for (const values of perFieldRow) {
    // Each row is judged against the rows BEFORE it and never against itself,
    // which is what keeps within-row multiplicity a property of every row
    // rather than only the first: a later row's `[b, b]` is two members, and
    // marking `b` seen as we went folded the second into the first.
    const rowKeys: string[] = []
    for (const value of values) {
      const {key} = keys.row(value)
      rowKeys.push(key)
      if (seen.has(key)) continue
      unioned.push(value)
    }
    for (const key of rowKeys) seen.add(key)
  }
  return unioned
}

/** This definition's value rows under `siblings`, GROUPED BY FIELD ROW and each
 *  group in `(order_key, id)` order — or `null` when the owner carries no field
 *  row for it, which is the precondition
 *  {@link childContentsToEncodedPropertyValue} is called under.
 *
 *  Grouped, not flat, because the caller's next step is
 *  {@link unionValuesAcrossFieldRows} and a flat list has already lost the
 *  boundary that rule turns on. */
export const fieldRowValues = async (
  tx: Pick<Tx, 'childrenOf'>,
  siblings: readonly BlockData[],
  fieldId: string,
  isFieldDefinition: IsPropertyFieldDefinition,
): Promise<BlockData[][] | null> => {
  const groups: BlockData[][] = []
  for (const sibling of siblings) {
    // Field-row content is `::((fieldId))` — id-addressed and rename-stable
    // (§7). The fieldId equality picks THIS definition's rows; the shared §9
    // recognizer supplies the bit + root + resolvability conditions.
    if (getPropertyFieldTargetId(sibling) !== fieldId) continue
    if (!isPropertyFieldInstance(sibling, isFieldDefinition)) continue
    groups.push(await fieldValueChildren(tx, sibling.id))
  }
  return groups.length === 0 ? null : groups
}

/**
 * Does `encoded` come back UNCHANGED through the value-child machinery?
 *
 * The machinery's own question, asked by running it rather than by reasoning
 * about what a value looks like: encode it into the children it implies, then
 * project those back. `propertyDefinitionSynthesis` needs it to prove a preset
 * can carry a key's stored values before applying a definition retroactively.
 *
 * At WHOLE-PROPERTY grain, so a multi-valued schema is asked about all of its
 * members at once.
 */
export const valueSurvivesChildRoundTrip = (
  schema: AnyPropertySchema,
  encoded: unknown,
): boolean => {
  try {
    const contents = encodedPropertyValueToChildContents(schema, encoded)
    return jsonValuesEqual(childContentsToEncodedPropertyValue(schema, contents), encoded)
  } catch {
    return false
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
 *  assignments — the ONLY part the two callers differ in. Both project through
 *  the same pair, `unionValuesAcrossFieldRows` then
 *  `childContentsToEncodedPropertyValue`, which own what a definition's value
 *  is across its field rows and at either grain; neither caller restates those
 *  rules. They differ in the CODEC: the rename reads the values under the
 *  tx-start one, while the batch re-encodes each under the possibly-new one and
 *  counts unconvertibles. The write is `skipMetadata` machinery, not a "last
 *  edited" bump. */
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
 * child that carries a property's identity on its owner (docs/properties-as-blocks-migration.html §9)?
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
  return isPropertyFieldInstance(row, (fieldId) =>
    tx.isPropertyFieldDefinition(row.workspaceId, fieldId))
}

/**
 * Is `source` a property VALUE row — the direct non-`::` child of a
 * recognized field row (docs/properties-as-blocks-migration.html §9)? Shared write-side primitive: a value
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
