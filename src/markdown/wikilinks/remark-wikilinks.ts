import { Plugin } from 'unified'
import { visit, SKIP } from 'unist-util-visit'
import { Literal, Parent, RootContent } from 'mdast'
import { parseReferences } from '@/utils/referenceParser'

export interface RemarkWikilinksOptions {
  resolveAlias: (alias: string) => string | undefined
}

export const remarkWikilinks: Plugin<[RemarkWikilinksOptions?]> = (options) => (tree) => {
  const resolveAlias = options?.resolveAlias

  visit(tree, 'text', (node: Literal, index, parent: Parent) => {
    if (index === undefined || !parent) return

    const src = node.value
    const refs = parseReferences(src)
    if (refs.length === 0) return

    // parseReferences returns nested matches too; for inline rendering we
    // only want the outermost spans so the surrounding text splices line up.
    const topLevel: typeof refs = []
    let cursor = 0
    for (const ref of refs) {
      if (ref.startIndex < cursor) continue
      topLevel.push(ref)
      cursor = ref.endIndex
    }

    const out: RootContent[] = []
    let last = 0
    for (const ref of topLevel) {
      if (ref.startIndex > last) {
        out.push({type: 'text', value: src.slice(last, ref.startIndex)})
      }
      const blockId = resolveAlias?.(ref.alias) ?? ''
      out.push({
        type: 'wikilink',
        value: src.slice(ref.startIndex, ref.endIndex),
        data: {
          hName: 'wikilink',
          hProperties: {alias: ref.alias, blockId},
          hChildren: [{type: 'text', value: ref.alias}],
        },
      } as unknown as RootContent)
      last = ref.endIndex
    }
    if (last < src.length) out.push({type: 'text', value: src.slice(last)})

    parent.children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })
}
