import type {Plugin} from 'unified'
import {SKIP, visit} from 'unist-util-visit'

interface ReferenceData {
  hProperties: {blockId: string; alias?: string; aliased?: boolean; occurrenceId?: string}
}

/** Number scope-bearing references after both parsers, in document order.
 *  State belongs to the ordinal within each (kind, target) group; moving a
 *  different target or changing surrounding text leaves that identity alone.
 *  Page aliases identify unresolved targets too. Refs and embeds are separate
 *  kinds because one is read-only and the other owns an editable subtree. */
// Preserving React instances across markdown-tree insertions belongs to the renderer; this pass stabilizes scopes.
export const remarkReferenceOccurrences: Plugin = () => tree => {
  const counts = new Map<string, number>()
  visit(tree, ['blockref', 'blockembed', 'pageembed'], node => {
    const {hProperties: props} = node.data as ReferenceData
    const target = node.type === 'pageembed' ? props.alias : props.blockId
    const key = JSON.stringify([node.type, target])
    const ordinal = counts.get(key) ?? 0
    counts.set(key, ordinal + 1)
    props.occurrenceId = JSON.stringify([node.type, target, ordinal])
    // Only aliased references render their parsed children.
    if (!props.aliased) return SKIP
  })
}
