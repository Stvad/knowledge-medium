import type { RoamBlock } from './types'
import { explodePageTokens, normalizeRoamPropertyValue } from './properties'
import { stripRoamTodoContent } from './todo'
import { stripSrsScheduleMetadataFromValue } from './srsMarkers'

// Roam inline attribute: a block whose content matches `key:: value`.
// Keys in real graphs often contain spaces or punctuation (`Full
// Title`, `initial review date`, `muscle mass %`). Keep this anchored
// at the start of a single block and require a letter-first key so
// prose/code fragments like `6. Runs ::fix...` don't become props.
const INLINE_ATTR_RE = /^([^:\n]{1,100})::\s*(.*)$/
const INLINE_ATTR_KEY_RE = /^[\p{L}][\p{L}\p{N} _%?'’().,;/-]*$/u
const PAGE_REF_ATTR_KEY_RE = /^\[\[[^\n]+\]\]$/

const isInlineAttrKey = (key: string): boolean =>
  INLINE_ATTR_KEY_RE.test(key) || PAGE_REF_ATTR_KEY_RE.test(key)

export const detectInlineAttribute = (
  rawContent: string | undefined,
): {key: string, value: string} | null => {
  if (!rawContent) return null
  const content = stripRoamTodoContent(rawContent)
  if (content.includes('\n')) return null
  const match = INLINE_ATTR_RE.exec(content)
  if (!match) return null
  const key = match[1].trim()
  if (!isInlineAttrKey(key)) return null
  return {key, value: stripSrsScheduleMetadataFromValue(match[2])}
}

/**
 * Promotion result for a parent block's direct children.
 *
 *   - `promoted` is the namespaced property bag to merge onto the
 *     parent. Single-value entries are scalars; multi-value entries
 *     are arrays (case 2: same-key siblings, case 4: list-children of
 *     an attr block).
 *   - `bubbled` lists uids whose values were pulled into `promoted`
 *     (directly or recursively through an attr -> attr chain). A
 *     deeper promotion pass on a kept intermediate block consults
 *     this set so it doesn't re-bubble the same descendants onto
 *     itself and produce duplicate property entries.
 *   - `declined` lists uids whose key `acceptValue` withdrew. They are
 *     NOT bubbled — their bullets stay — but a caller that walks deeper
 *     must go on treating them as decided, together with `bubbled`. A
 *     deeper pass sees fewer of the key's values (one branch of the tree
 *     rather than all of them), so it can accept what this level refused
 *     and hoist the bullet onto a parent that is itself about to be
 *     dropped — destroying the text this withdrawal just rescued.
 *   - `diagnostics` surfaces unusual structures (e.g. attr nesting
 *     deeper than two levels) so the post-import log can flag them.
 */
export interface PromotionResult {
  promoted: Record<string, unknown>
  diagnostics: string[]
  bubbled: Set<string>
  declined: Set<string>
}

export interface PromotionOptions {
  namespacePrefix?: string
  transformKey?: (key: string) => string
  /** Decline to promote a key whose namespaced name this rejects. The source
   *  block is then left completely untouched — not marked bubbled, so a
   *  consumer doing SUBTRACTIVE promotion still keeps the bullet. That is the
   *  point: a name no definition can be registered for (see
   *  `isRegistrablePropertyName`) must not become a property, and the
   *  decision has to happen HERE, before bubbling, because dropping the
   *  property afterwards would destroy the only remaining copy of the text. */
  acceptKey?: (propName: string) => boolean
  /** Decline a key whose FINALIZED value this rejects — the value half of
   *  `acceptKey`, and the only one that can answer, since a key's value is not
   *  known until every sibling and child bullet has been folded into it
   *  (scalar vs list, page-token explosion).
   *
   *  A declined key is withdrawn whole: it never enters `promoted`, and every
   *  uid that fed it moves from `bubbled` to `declined`, so a SUBTRACTIVE
   *  consumer keeps those bullets and the text survives verbatim.
   *
   *  Two obligations on that consumer, both load-bearing:
   *  - carry `declined` into the deeper passes alongside `bubbled` (see
   *    {@link PromotionResult});
   *  - keep a BUBBLED node that still has children, since a withdrawn bullet
   *    can sit under one. `bubbled` says its own text was hoisted, never that
   *    its subtree is expendable.
   *
   *  What a caller passes: `promotedValueAcceptorFor(repo)` — the value has to
   *  be one its key's existing definition can carry, or post-flip the
   *  materialize processor rejects the whole writing transaction (#594).
   *
   *  Weaker than `acceptKey` in one respect, because it can only answer once
   *  the whole chain has been walked: a declined key's SUB-attributes have
   *  already been hoisted to this parent under their own keys, whereas
   *  `acceptKey` returns before recursing and leaves them for the deeper pass
   *  to hoist onto the declined block itself. Same tree, different owner,
   *  decided by which decline fired. Nothing is lost either way. */
  acceptValue?: (propName: string, value: unknown) => boolean
}

/** Walk a parent's direct children and compute case-1/2/3/4 promotion.
 *  No tree edits: every source block survives as a descendant of its
 *  original parent. The promotion is purely additive.
 *
 *  `alreadyBubbled` is a set of uids whose values were already pulled
 *  up by an ancestor's promotion pass. Without it, an intermediate
 *  kept attr block (along an `attr -> attr` chain) would re-bubble the
 *  same descendants onto itself when buildBlock recurses into it. */
export const computePromotedFromChildren = (
  children: ReadonlyArray<RoamBlock>,
  alreadyBubbled: ReadonlySet<string>,
  options: PromotionOptions = {},
): PromotionResult => {
  const accumulator = new Map<string, unknown[]>()
  const diagnostics: string[] = []
  const newlyBubbled = new Set<string>()
  /** propName → the bubbled uids that fed it. A bubbled uid feeds exactly one
   *  key (its own `key::`), so a withdrawal is exact rather than approximate. */
  const sourceUids = new Map<string, Set<string>>()
  const namespacePrefix = options.namespacePrefix ?? 'roam'
  const transformKey = options.transformKey ?? ((key: string) => key)
  const acceptKey = options.acceptKey ?? (() => true)
  const acceptValue = options.acceptValue ?? (() => true)
  const nameOf = (key: string): string => `${namespacePrefix}:${transformKey(key)}`
  const accepts = (key: string): boolean => acceptKey(nameOf(key))

  const push = (key: string, value: unknown) => {
    const propName = nameOf(key)
    const list = accumulator.get(propName) ?? []
    list.push(typeof value === 'string' ? normalizeRoamPropertyValue(value) : value)
    accumulator.set(propName, list)
  }

  // `depth` is the bubbling distance from the original parent
  // (0 = direct child of parent).
  const consume = (block: RoamBlock, depth: number): void => {
    if (alreadyBubbled.has(block.uid) || newlyBubbled.has(block.uid)) return
    const attr = detectInlineAttribute(block.string)
    if (!attr) return
    // Before `newlyBubbled` — a declined key must leave the block intact.
    if (!accepts(attr.key)) return

    if (depth >= 2) {
      diagnostics.push(
        `Attribute "${attr.key}" hoisted from depth ${depth + 1} (uid ${block.uid}) — ` +
        `unusual nesting; review the source structure.`,
      )
    }

    newlyBubbled.add(block.uid)
    const propName = nameOf(attr.key)
    const sources = sourceUids.get(propName) ?? new Set<string>()
    sources.add(block.uid)
    sourceUids.set(propName, sources)
    if (attr.value.trim() !== '') push(attr.key, attr.value)

    for (const sub of block.children ?? []) {
      if (detectInlineAttribute(sub.string)) {
        // Sub-attr: bubble it up to the original parent through the
        // attr chain. Recurses arbitrarily deep; depth→2 logs above.
        consume(sub, depth + 1)
      } else {
        // Non-attr sub-bullet: contributes its raw string as another
        // value for the enclosing attr's key (case 4).
        push(attr.key, stripRoamTodoContent(sub.string))
      }
    }
  }

  for (const child of children) consume(child, 0)

  const promoted: Record<string, unknown> = {}
  const declined = new Set<string>()
  for (const [key, values] of accumulator) {
    const value = finalizeValue(values)
    if (!acceptValue(key, value)) {
      // Withdraw the whole key and give its bullets back. All-or-nothing per
      // key because the cell is: one key holds one value, so a batch with one
      // unusable member has no partial form to keep.
      for (const uid of sourceUids.get(key) ?? []) {
        newlyBubbled.delete(uid)
        declined.add(uid)
      }
      diagnostics.push(
        `Declined to promote "${key}": its value cannot be stored under that ` +
        `name. Left as ordinary content.`,
      )
      continue
    }
    promoted[key] = value
  }

  return {promoted, diagnostics, bubbled: newlyBubbled, declined}
}

/** Fold a key's accumulated values into the single value the cell will hold:
 *  scalar for length-1, list for length>1, and either way a scalar that is a
 *  sequence of `[[X]]` tokens becomes a page list (case 3). */
const finalizeValue = (values: readonly unknown[]): unknown => {
  if (values.length === 1) {
    const single = values[0]
    if (typeof single !== 'string') return single
    return explodePageTokens(single) ?? single
  }
  // Multi-value: keep each string item but flatten any page-token strings so a
  // mix like ['[[a]] [[b]]', '[[c]]'] becomes ['[[a]]', '[[b]]', '[[c]]'].
  const flat: unknown[] = []
  for (const v of values) {
    if (typeof v !== 'string') { flat.push(v); continue }
    const exploded = explodePageTokens(v)
    if (exploded) flat.push(...exploded)
    else flat.push(v)
  }
  return flat
}
