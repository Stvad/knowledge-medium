import { Plugin } from 'unified'
import { visit, SKIP } from 'unist-util-visit'
import { Literal, Parent, RootContent } from 'mdast'
import { parseBlockRefs } from '@/utils/referenceParser'

const buildNode = (
  tag: 'blockref' | 'blockembed',
  blockId: string,
  raw: string,
): RootContent => ({
  type: tag,
  value: raw,
  children: [{type: 'text', value: raw}],
  data: {
    hName: tag,
    hProperties: {blockId},
  },
} as unknown as RootContent)

export const remarkBlockrefs: Plugin = () => (tree) => {
  visit(tree, 'text', (node: Literal, index, parent: Parent | undefined) => {
    if (index === undefined || !parent) return

    const src = node.value
    const refs = parseBlockRefs(src)
    if (refs.length === 0) return

    const out: RootContent[] = []
    let last = 0
    for (const ref of refs) {
      if (ref.startIndex > last) {
        out.push({type: 'text', value: src.slice(last, ref.startIndex)})
      }
      out.push(buildNode(
        ref.embed ? 'blockembed' : 'blockref',
        ref.blockId,
        src.slice(ref.startIndex, ref.endIndex),
      ))
      last = ref.endIndex
    }
    if (last < src.length) out.push({type: 'text', value: src.slice(last)})

    parent.children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })
}
