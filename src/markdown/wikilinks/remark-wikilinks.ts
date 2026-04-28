import { Plugin } from 'unified'
import { visit, SKIP } from 'unist-util-visit'
import { Link, Literal, Parent, RootContent } from 'mdast'
import { parseReferences } from '@/utils/referenceParser'

export interface RemarkWikilinksOptions {
  resolveAlias: (alias: string) => string | undefined
}

const LINK_URL_RE = /^\[\[(.+)\]\]$/

// Matches `[display]([[alias]])` literally inside a text node. Used for the
// case where remark didn't parse this as a link node — typically because the
// alias contains spaces (CommonMark link destinations forbid bare spaces),
// e.g. `[name]([[April 30th, 2026]])`.
const LINK_FORM_RE = /\[([^[\]\n]*)\]\(\[\[([^[\]\n]+?)\]\]\)/g

const buildWikilinkNode = (
  alias: string,
  blockId: string,
  children: RootContent[],
  raw: string,
): RootContent => ({
  type: 'wikilink',
  value: raw,
  children,
  data: {
    hName: 'wikilink',
    hProperties: {alias, blockId},
  },
} as unknown as RootContent)

export const remarkWikilinks: Plugin<[RemarkWikilinksOptions?]> = (options) => (tree) => {
  const resolve = (alias: string) => options?.resolveAlias?.(alias) ?? ''

  // First pass: rewrite `[display]([[alias]])` markdown links so the display
  // text is preserved as the rendered children of the wikilink.
  visit(tree, 'link', (node: Link, index, parent: Parent | undefined) => {
    if (index === undefined || !parent) return
    const match = LINK_URL_RE.exec(node.url ?? '')
    if (!match) return
    const alias = match[1].trim()
    if (!alias) return

    parent.children.splice(index, 1, buildWikilinkNode(
      alias,
      resolve(alias),
      node.children as RootContent[],
      `[…](${node.url})`,
    ))
    return [SKIP, index + 1]
  })

  // Second pass: rewrite `[display]([[alias]])` written as plain text. Order
  // matters — must run before the bare scan, otherwise the bare scan would
  // chew the inner `[[alias]]` and lose the display text wrapper.
  visit(tree, 'text', (node: Literal, index, parent: Parent | undefined) => {
    if (index === undefined || !parent) return

    const src = node.value
    LINK_FORM_RE.lastIndex = 0
    const out: RootContent[] = []
    let last = 0
    let match: RegExpExecArray | null
    while ((match = LINK_FORM_RE.exec(src)) !== null) {
      const [whole, displayText, rawAlias] = match
      const alias = rawAlias.trim()
      if (!alias) continue
      if (match.index > last) {
        out.push({type: 'text', value: src.slice(last, match.index)})
      }
      out.push(buildWikilinkNode(
        alias,
        resolve(alias),
        [{type: 'text', value: displayText}],
        whole,
      ))
      last = match.index + whole.length
    }
    if (out.length === 0) return
    if (last < src.length) out.push({type: 'text', value: src.slice(last)})

    parent.children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })

  // Third pass: split bare `[[alias]]` spans inside text nodes.
  visit(tree, 'text', (node: Literal, index, parent: Parent | undefined) => {
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
      out.push(buildWikilinkNode(
        ref.alias,
        resolve(ref.alias),
        [{type: 'text', value: ref.alias}],
        src.slice(ref.startIndex, ref.endIndex),
      ))
      last = ref.endIndex
    }
    if (last < src.length) out.push({type: 'text', value: src.slice(last)})

    parent.children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })
}
