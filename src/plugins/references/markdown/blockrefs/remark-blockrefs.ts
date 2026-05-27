import { Plugin } from 'unified'
import { visit, SKIP } from 'unist-util-visit'
import { Link, Literal, Parent, RootContent } from 'mdast'
import { parseBlockRefs, parseBlockRefTarget } from '../../referenceParser.ts'

const buildNode = (
  tag: 'blockref' | 'blockembed',
  blockId: string,
  raw: string,
  occurrenceId: string,
  children?: RootContent[],
): RootContent => ({
  type: tag,
  value: raw,
  children: children ?? [{type: 'text', value: raw}],
  data: {
    hName: tag,
    hProperties: {
      blockId,
      occurrenceId,
      ...(children ? {aliased: true} : {}),
    },
  },
} as unknown as RootContent)

export const remarkBlockrefs: Plugin = () => (tree) => {
  visit(tree, 'link', (node: Link, index, parent: Parent | undefined) => {
    if (index === undefined || !parent) return

    const blockId = parseBlockRefTarget(node.url ?? '')
    if (!blockId) return

    parent.children.splice(index, 1, buildNode(
      'blockref',
      blockId,
      `[…](${node.url})`,
      `link:${node.position?.start.offset ?? index}`,
      node.children as RootContent[],
    ))
    return [SKIP, index + 1]
  })

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
        `text:${(node.position?.start.offset ?? 0) + ref.startIndex}`,
        ref.label ? [{type: 'text', value: ref.label}] : undefined,
      ))
      last = ref.endIndex
    }
    if (last < src.length) out.push({type: 'text', value: src.slice(last)})

    parent.children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })
}
