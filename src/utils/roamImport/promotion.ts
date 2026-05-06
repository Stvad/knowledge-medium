import type { RoamBlock } from './types'
import { explodePageTokens, normalizeRoamPropertyValue } from './properties'
import { stripRoamTodoContent } from './todo'

// Roam inline attribute: a block whose content matches `key:: value`.
// Keys in real graphs often contain spaces or punctuation (`Full
// Title`, `initial review date`, `muscle mass %`). Keep this anchored
// at the start of a single block and require a letter-first key so
// prose/code fragments like `6. Runs ::fix...` don't become props.
const INLINE_ATTR_RE = /^([^:\n]{1,100})::\s*(.*)$/
const INLINE_ATTR_KEY_RE = /^[A-Za-z][A-Za-z0-9 _%?'’()./-]*$/

export const detectInlineAttribute = (
  rawContent: string | undefined,
): {key: string, value: string} | null => {
  if (!rawContent) return null
  const content = stripRoamTodoContent(rawContent)
  if (content.includes('\n')) return null
  const match = INLINE_ATTR_RE.exec(content)
  if (!match) return null
  const key = match[1].trim()
  if (!INLINE_ATTR_KEY_RE.test(key)) return null
  return {key, value: match[2]}
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
 *   - `diagnostics` surfaces unusual structures (e.g. attr nesting
 *     deeper than two levels) so the post-import log can flag them.
 */
export interface PromotionResult {
  promoted: Record<string, unknown>
  diagnostics: string[]
  bubbled: Set<string>
}

export interface PromotionOptions {
  namespacePrefix?: string
  transformKey?: (key: string) => string
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
  const namespacePrefix = options.namespacePrefix ?? 'roam'
  const transformKey = options.transformKey ?? ((key: string) => key)

  const push = (key: string, value: unknown) => {
    const propName = `${namespacePrefix}:${transformKey(key)}`
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

    if (depth >= 2) {
      diagnostics.push(
        `Attribute "${attr.key}" hoisted from depth ${depth + 1} (uid ${block.uid}) — ` +
        `unusual nesting; review the source structure.`,
      )
    }

    newlyBubbled.add(block.uid)
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

  // Finalize: scalar for length-1, list for length>1, then post-process
  // any scalar that's a sequence of `[[X]]` tokens into a page list (case 3).
  const promoted: Record<string, unknown> = {}
  for (const [key, values] of accumulator) {
    if (values.length === 1) {
      const single = values[0]
      if (typeof single === 'string') {
        const exploded = explodePageTokens(single)
        promoted[key] = exploded ?? single
      } else {
        promoted[key] = single
      }
    } else {
      // Multi-value: keep each string item but flatten any page-token
      // strings so a mix like ['[[a]] [[b]]', '[[c]]'] becomes
      // ['[[a]]', '[[b]]', '[[c]]'].
      const flat: unknown[] = []
      for (const v of values) {
        if (typeof v === 'string') {
          const exploded = explodePageTokens(v)
          if (exploded) flat.push(...exploded)
          else flat.push(v)
        } else {
          flat.push(v)
        }
      }
      promoted[key] = flat
    }
  }

  return {promoted, diagnostics, bubbled: newlyBubbled}
}
