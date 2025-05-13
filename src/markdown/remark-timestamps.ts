import { Plugin } from 'unified'
import { visit } from 'unist-util-visit'
import { Literal, Parent, RootContent } from 'mdast'

export const TS_RE =
  /(?:(\d{1,3}):)?([0-5]?\d):([0-5]\d)(?:\.(\d{1,3}))?\b/g

export const remarkTimestamps: Plugin = () => (tree) => {
  visit(tree, 'text', (node: Literal, index, parent: Parent) => {
    const src = node.value
    const out: Array<RootContent> = []
    let last = 0

    for (const m of src.matchAll(TS_RE)) {
      if (m.index > last) out.push({type: 'text', value: src.slice(last, m.index)})

      out.push({
        type: 'timestamp',
        value: m[0],
        data: {
          hName: 'time-stamp',
          hProperties: {hms: m[0]},
          hChildren: [{type: 'text', value: m[0]}],
        },
      })

      last = m.index + m[0].length
    }

    if (out.length) {
      if (last < src.length) out.push({type: 'text', value: src.slice(last)})
      parent.children.splice(index!, 1, ...out)
      return index! + out.length
    }
  })
}
