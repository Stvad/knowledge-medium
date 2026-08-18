export type ExactReferenceBlockContent =
  | {kind: 'alias'; alias: string; fieldForm: boolean}
  | {kind: 'blockRef'; id: string; fieldForm: boolean}
  | {kind: 'aliasedBlockRef'; id: string; label: string; fieldForm: boolean}

// Exact reference blocks are allowed to target any concrete block id.
// Keep this broader grammar scoped to whole-block content; the inline
// references plugin intentionally stays UUID-only so prose like
// "((not a ref))" does not become a backlink. The aliased blockref form
// is the one exception: it mirrors the references plugin's
// ALIASED_BLOCK_REF_RE exactly (UUID-only id, no `]`/newline in the
// label) — that parser owns the form, and a whole-block reading that
// accepted more would diverge from every inline reader of the same text.
// Exported so other modules that need "what does a UUID-shaped id look
// like" (e.g. blockId.ts's write-boundary validator) reuse this
// SOURCE instead of copying the character class a third time. Case
// policy is a per-consumer choice, not baked in here: this file's own
// UUID_RE below adds the `i` flag (parsing existing content accepts and
// canonicalizes any case), while a stricter consumer can anchor the bare
// source without it to require lowercase.
export const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** Longest alias a `[[…]]` span may carry and still be read as a
 *  reference — by ANY reader of this text.
 *
 *  A runaway guard: nothing in the grammar bounds how far a `[[` may
 *  reach for its `]]`, and text carrying code supplies unbalanced openers
 *  for free (a regex character class opening `/[[`, a nested array
 *  literal). 4096 sits far above anything human-authored — the longest
 *  real alias measured across a ~31k-alias workspace was 322 chars — so it
 *  bounds a runaway without being a judgement about page names.
 *
 *  In core, not the plugin: both readers of this grammar must agree on
 *  what counts as a reference, and core cannot import the plugin — so the
 *  plugin re-exports this rather than declaring its own copy. */
export const MAX_ALIAS_LENGTH = 4096
/** Id class the WHOLE-BLOCK reading accepts inside `((…))` — any run
 *  without parens or whitespace, so a field row can address a block whose
 *  id came from a caller rather than being generated. The inline reading
 *  narrows this deliberately; see {@link blockRefSpanSource}. */
export const BROAD_BLOCK_REF_ID_SOURCE = '[^()\\s]+'

/** ──── Span shapes, shared by BOTH readers of this grammar ────
 *
 *  This module reads WHOLE-BLOCK content (one span, or nothing);
 *  `@/plugins/references/referenceParser` scans INLINE spans out of prose.
 *  The shapes must not drift, or a span is a reference to one reader and
 *  prose to the other — so they live here once, and each reader anchors
 *  and flags them for its own job.
 *
 *  Three divergences ARE deliberate, hence parameters rather than
 *  accidents:
 *   - the id class inside `((…))` — broad whole-block (above), UUID-only
 *     inline so prose like "((not an id))" never becomes a backlink;
 *   - trimming — whole-block trims its alias, inline takes the span
 *     verbatim (both bound by `MAX_ALIAS_LENGTH`, measured pre-trim so
 *     the two agree at the boundary);
 *   - nesting — inline emits nested spans, whole-block has none to emit.
 */
export const blockRefSpanSource = (idSource: string): string =>
  `\\(\\((${idSource})\\)\\)`

/** `[label](((id)))`. The label class excludes `]` and newlines, which is
 *  what makes the form unambiguous — `renderAliasedBlockref` strips both
 *  for exactly this reason. */
export const aliasedBlockRefSpanSource = (idSource: string): string =>
  `\\[([^\\]\\n]*)\\]\\(\\(\\((${idSource})\\)\\)\\)`

const UUID_RE = new RegExp(`^${UUID_RE_SOURCE}$`, 'i')
const EXACT_BLOCK_REF_RE = new RegExp(
  `^${blockRefSpanSource(BROAD_BLOCK_REF_ID_SOURCE)}$`,
)
const EXACT_ALIASED_BLOCK_REF_RE = new RegExp(
  `^${aliasedBlockRefSpanSource(UUID_RE_SOURCE)}$`, 'i',
)

/** The ids `((id))` content can actually round-trip — the same character class
 *  {@link EXACT_BLOCK_REF_RE} accepts inside the parens. */
const RENDERABLE_BLOCK_REF_ID_RE = new RegExp(`^${BROAD_BLOCK_REF_ID_SOURCE}$`)

/** The `::` field marker (properties-as-blocks §7 grammar box): trimmed
 *  content = `::` + one whole-block reference span, NO space between marker
 *  and span. Matching is on the trimmed whole; embeds (`!((id))`) never
 *  match any span form here. Exported for renderers composing the marked
 *  form; parsing goes through {@link parseExactReferenceBlockContent}. */
export const FIELD_FORM_MARKER = '::'

const parseReferenceSpan = (
  span: string,
  fieldForm: boolean,
): ExactReferenceBlockContent | null => {
  const blockRef = EXACT_BLOCK_REF_RE.exec(span)
  if (blockRef) {
    const id = blockRef[1]
    return {kind: 'blockRef', id: UUID_RE.test(id) ? id.toLowerCase() : id, fieldForm}
  }

  const aliased = EXACT_ALIASED_BLOCK_REF_RE.exec(span)
  if (aliased) {
    return {
      kind: 'aliasedBlockRef',
      id: aliased[2].toLowerCase(),
      label: aliased[1],
      fieldForm,
    }
  }

  if (!span.startsWith('[[') || !span.endsWith(']]')) return null
  // Measured BEFORE the trim, because that is the string the inline
  // parser sees for the same text — capping the trimmed value instead
  // would leave a hairline disagreement (`[[<cap a's> ]]` is at the cap
  // trimmed, one over untrimmed) exactly where the two readings must
  // agree.
  const raw = span.slice(2, -2)
  if (raw.length > MAX_ALIAS_LENGTH) return null
  const alias = raw.trim()
  if (!alias || alias.includes('[[') || alias.includes(']]')) return null
  return {kind: 'alias', alias, fieldForm}
}

/** The ID-CARRYING kinds: the span names a block id outright, so it
 *  resolves TEXTUALLY with no name lookup, no alias index, and no seat
 *  minting. `alias` is the odd one out — it names a NAME, and what that
 *  name resolves to is a fact about the workspace rather than about the
 *  text.
 *
 *  A named fragment because two sites branch on exactly this distinction
 *  and mean different things by it — `deriveReferenceColumns` takes the
 *  textual shortcut for these and falls through to the alias lookup
 *  otherwise; the ref-value decode ACCEPTS only these, because a ref
 *  property stores identity and must not follow a name (§9 value
 *  decoding). Neither is an exhaustive `switch`, so a fourth id-carrying
 *  variant added to {@link ExactReferenceBlockContent} would silently
 *  miss both call sites; here it's one line to update. */
export const isIdCarryingReference = (
  parsed: ExactReferenceBlockContent | null,
): parsed is Extract<ExactReferenceBlockContent, {kind: 'blockRef' | 'aliasedBlockRef'}> =>
  parsed !== null && (parsed.kind === 'blockRef' || parsed.kind === 'aliasedBlockRef')

/** Parse whole-block reference content: one reference span — exact ref
 *  `((id))` (broad-id grammar), wikilink `[[alias]]`, or aliased blockref
 *  `[label](((uuid)))` (plugin-mirrored, UUID-only) — optionally preceded by
 *  the `::` field marker (`fieldForm: true`; §7 grammar box). A `::` whose
 *  remainder is not exactly one span is not a reference at all (prose
 *  beginning with `::` never classifies), and the marker admits no space
 *  before the span (` :: [[x]]` trims outer whitespace only). */
export const parseExactReferenceBlockContent = (
  content: string,
): ExactReferenceBlockContent | null => {
  const trimmed = content.trim()
  if (trimmed.startsWith(FIELD_FORM_MARKER)) {
    // The marked read is definitive: no span form can itself start with
    // `::` (spans open with `((` or `[`), so there is no unmarked reading
    // to fall back to — `::not-a-span` is plain prose, null.
    return parseReferenceSpan(trimmed.slice(FIELD_FORM_MARKER.length), true)
  }
  return parseReferenceSpan(trimmed, false)
}

export const referenceBlockContentForLabel = (label: string): string =>
  `[[${label.replace(/]]/g, '] ]')}]]`

/** Block-ref content addressing a block by id (`((id))`). Property field rows
 *  (PR #288 §7) point at their definition BY ID, not by name: the row's whole
 *  content is `((fieldId))`, so `reference_target_id` derives purely textually
 *  (no name→schema tier, no deferred resolution) and the human-readable name is
 *  recovered by resolving the id → definition (which owns the name). Rendering
 *  is unaffected — a definition block's own `content` is its name, and a
 *  block-ref renders the target's label. */
export const referenceBlockContentForId = (id: string): string => {
  // Never emit content the parser can't read back. Block ids are usually
  // UUIDs, but `tx.create` and the agent bridge's `create-block` accept a
  // caller-supplied id, and one containing whitespace or parentheses renders
  // as a `((…))` that `parseExactReferenceBlockContent` rejects. In a
  // child-backed workspace that lands as silent corruption rather than an
  // error: the value/field child is written with a prefilled
  // `referenceTargetId`, then `core.deriveReferenceTarget` runs afterwards,
  // fails to parse the same text, and clears the column — leaving a property
  // child that no longer projects and an owner cell that quietly loses the
  // key (PR #386 review).
  //
  // Throwing at the point of rendering turns that into a loud, local failure
  // on the write that caused it. Same instinct as `addSchema` rejecting a
  // `]]`-lossy property name: refuse to store what can't be read back.
  if (!RENDERABLE_BLOCK_REF_ID_RE.test(id)) {
    throw new Error(
      `[referenceBlockContentForId] cannot address block id ${JSON.stringify(id)} as `
      + '((id)) — block-ref content may not contain whitespace or parentheses, and an '
      + 'unparseable ref would silently drop the reference (and, for a property child, '
      + 'the property) at the next derive.',
    )
  }
  // Round-tripping is not just "does it parse" — it must parse back to the SAME
  // id. Today the one way that fails is UUID case: the parser canonicalizes
  // UUID-looking ids to lowercase, so a case-variant clears the check above and
  // still reads back as a DIFFERENT id — the derive then stamps
  // `reference_target_id` to the lowercase spelling, pointing the child at a
  // wrong or nonexistent block (PR #386 review). Strictly worse than the
  // unparseable case, which at least resolves to nothing.
  //
  // Asked by ACTUALLY round-tripping rather than by re-stating the parser's
  // canonicalization rule here — the same idiom as
  // `isRoundTrippableReferenceLabel` below. A second copy of that rule could
  // drift from the parser's; this can't, and it covers any future
  // canonicalization for free.
  //
  // Reject rather than normalize: emitting `((canonicalized))` for an id the
  // caller passed differently would silently paper over a real id mismatch at
  // the call site, and this function's whole contract is to refuse content it
  // can't read back.
  const content = `((${id}))`
  const parsed = parseExactReferenceBlockContent(content)
  if (parsed?.kind !== 'blockRef' || parsed.id !== id) {
    const readsAs = parsed?.kind === 'blockRef' ? JSON.stringify(parsed.id) : 'not a block ref'
    throw new Error(
      `[referenceBlockContentForId] block id ${JSON.stringify(id)} does not round-trip: `
      + `${JSON.stringify(content)} parses back as ${readsAs}. Ids are canonicalized on `
      + 'parse (UUID-shaped ids are lowercased), so pass the id in its canonical form.',
    )
  }
  return content
}

/** Does `label` survive the wikilink round trip intact? A name containing
 *  `]]` renders lossy (`foo]]bar` → `foo] ]bar`) so it can't be written as a
 *  clean `[[name]]` reference. `addSchema` and the rename flow reject
 *  non-round-trippable property names as name hygiene — field rows themselves
 *  are id-addressed (`((fieldId))`, PR #288 §7) and no longer embed the
 *  name. */
export const isRoundTrippableReferenceLabel = (label: string): boolean => {
  const parsed = parseExactReferenceBlockContent(referenceBlockContentForLabel(label))
  return parsed !== null && parsed.kind === 'alias' && parsed.alias === label
}

/**
 * Would `label`, written as a block's WHOLE content, read back as a
 * reference span instead of prose (PR #288 §7 name hygiene)?
 *
 * Several flows mirror a human-supplied label into block content — a type
 * definition's block is titled with its label, a property-schema block with
 * its name, a seed with its seed name, an alias seat with the alias text.
 * A label that is itself grammar-shaped turns that mirror into an accident:
 * `::((<some definition id>))` as a type label mints a block that IS a
 * recognized property field row of the Types page, silently attaching a
 * property to it and hiding the type from the outline; `[[Foo]]` as a
 * property name mints a row that resolves to whatever claims "Foo".
 *
 * Rejecting at the mirror is the cheap fix: these labels are all
 * user-authored at a point where an error message is actionable, and no
 * legitimate name needs to look like a reference. The check is the PARSER
 * itself rather than a second copy of the grammar, so it can't drift — and
 * it covers marked and unmarked forms alike, since an unmarked
 * `((definitionId))` title is equally a lie about what the block is.
 */
export const isGrammarShapedLabel = (label: string): boolean =>
  parseExactReferenceBlockContent(label) !== null

/** A label a name-mirroring flow refuses to store.
 *
 *  A BASE class, not a marker: UI callers catch this to tell a refused
 *  rename from a failed write and revert the field, and catching the base
 *  means a new refusal reason is handled the moment it is added rather
 *  than after someone remembers to widen an `instanceof` chain. Two
 *  reasons exist today — grammar-shaped and non-round-trippable — and
 *  they were added a round apart, which is the argument for the base. */
export abstract class UnwritableLabelError extends Error {}

/** A label that would read back as a reference span rather than a name. */
export class GrammarShapedLabelError extends UnwritableLabelError {
  constructor(public readonly label: string, context: string) {
    super(
      `${context}: ${JSON.stringify(label)} reads as a block reference, not a name. `
      + 'Names are written as block content or rendered as `[[name]]`, so one shaped '
      + 'like "((id))", "[[name]]" or a "::"-marked span would read as a reference to '
      + 'another block — and a marked one would turn its block into property machinery.',
    )
    this.name = 'GrammarShapedLabelError'
  }
}

/** Throwing form of {@link isGrammarShapedLabel} — the one place the refusal
 *  and its explanation live, so the mirrors that enforce it don't each carry
 *  their own copy. `context` names the caller for the message. */
export const assertNotGrammarShapedLabel = (label: string, context: string): void => {
  if (isGrammarShapedLabel(label)) throw new GrammarShapedLabelError(label, context)
}

/** A label that cannot be written as a clean `[[label]]` and read back as
 *  itself — `]]`-lossy, or longer than `MAX_ALIAS_LENGTH`. */
export class LossyLabelError extends UnwritableLabelError {
  constructor(public readonly label: string, context: string) {
    super(
      `${context}: ${JSON.stringify(label)} cannot be written as a "[[name]]" reference `
      + 'and read back unchanged, so anything that links to it by name would resolve '
      + `somewhere else or not at all. Names containing "]]" render lossily, and names `
      + `longer than ${MAX_ALIAS_LENGTH} characters are not read as references at all.`,
    )
    this.name = 'LossyLabelError'
  }
}

/** Throwing form of {@link isRoundTrippableReferenceLabel}, for the flows
 *  whose label DOUBLES as a `[[label]]` page — a type definition, a
 *  property schema. For those the name is not an arbitrary string: it is
 *  also the only way to address the block by name, so one that can't be
 *  expressed as a wikilink leaves the thing unlinkable.
 *
 *  The grammar-shaped check is NOT a substitute and the two are always
 *  applied together: `((id))` round-trips perfectly while reading as a
 *  reference, and `foo]]bar` is unmistakably a name while rendering
 *  lossily. Property names already ran both; type labels ran only the
 *  first, so a `]]`-bearing type label claimed an alias nothing could
 *  link to — a gap that predates the length cap and that the cap widened
 *  (Codex on PR #540). */
export const assertRoundTrippableReferenceLabel = (
  label: string,
  context: string,
): void => {
  if (!isRoundTrippableReferenceLabel(label)) throw new LossyLabelError(label, context)
}
