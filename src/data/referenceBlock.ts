export type ExactReferenceBlockContent =
  | {kind: 'alias'; alias: string}
  | {kind: 'blockRef'; id: string}

// Exact reference blocks are allowed to target any concrete block id.
// Keep this broader grammar scoped to whole-block content; the inline
// references plugin intentionally stays UUID-only so prose like
// "((not a ref))" does not become a backlink.
const UUID_RE_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp(`^${UUID_RE_SOURCE}$`, 'i')
const EXACT_BLOCK_REF_RE = /^\(\(([^()\s]+)\)\)$/

/** The ids `((id))` content can actually round-trip — the same character class
 *  {@link EXACT_BLOCK_REF_RE} accepts inside the parens. */
const RENDERABLE_BLOCK_REF_ID_RE = /^[^()\s]+$/

export const parseExactReferenceBlockContent = (
  content: string,
): ExactReferenceBlockContent | null => {
  const trimmed = content.trim()
  const blockRef = EXACT_BLOCK_REF_RE.exec(trimmed)
  if (blockRef) {
    const id = blockRef[1]
    return {kind: 'blockRef', id: UUID_RE.test(id) ? id.toLowerCase() : id}
  }

  if (!trimmed.startsWith('[[') || !trimmed.endsWith(']]')) return null
  const alias = trimmed.slice(2, -2).trim()
  if (!alias || alias.includes('[[') || alias.includes(']]')) return null
  return {kind: 'alias', alias}
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
  return `((${id}))`
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
