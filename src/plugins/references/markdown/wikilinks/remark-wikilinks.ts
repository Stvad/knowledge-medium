import { Plugin } from 'unified'
import { visit, SKIP } from 'unist-util-visit'
import { Link, Literal, Parent, RootContent } from 'mdast'
import {
  MAX_ALIAS_LENGTH,
  linkFormWrapperAround,
  parseOutermostReferences,
} from '../../referenceParser.ts'

/** Passes 3 and 4 below inherit `MAX_ALIAS_LENGTH` by scanning through
 *  `parseOutermostReferences`. So does pass 2 now (its wrapper is found
 *  around a scanned span rather than by its own regex), but it re-checks
 *  anyway — see below. Pass 1 matches the `[display]([[alias]])` wrapper
 *  with its OWN regex, which does not bound the alias, so it has to
 *  re-check or the cap would hold for a bare `[[…]]` and quietly not for
 *  the wrapped form.
 *  That gap is the exact inconsistency the cap exists to prevent: the
 *  renderer would emit a live-looking link for a span the reference
 *  index treats as literal text, and until the source is re-parsed it
 *  could even resolve through a stale edge left over from before the
 *  cap. Both shapes are reachable — a bare CommonMark destination
 *  carries any bracket-free run, and the angle-bracket form
 *  (`[x](<[[…]]>)`) additionally allows spaces. */
const withinAliasCap = (alias: string) => alias.length <= MAX_ALIAS_LENGTH

/** Degrade a rejected `[display]([[alias]])` link to literal markup while
 *  keeping its display content intact.
 *
 *  The display is REUSED as parsed nodes rather than flattened to a
 *  string. Flattening looked simpler but silently dropped any leaf that
 *  carries neither `value` nor `children` — an `image` is exactly that
 *  shape, so `[![alt](pic.png)]([[…]])` degraded to `[]([[…]])`, losing
 *  the picture and its alt text. Splicing the original
 *  children back in cannot lose content, and it preserves emphasis and
 *  inline code as rendered marks instead of as stringified source.
 *
 *  What degrades is the LINK, not the display: children stay rendered
 *  nodes rather than being flattened back to source text. That is the
 *  deliberate choice, and it sets the limit of this reconstruction — the
 *  destination is rebuilt from mdast's NORMALIZED `url` plus `title`, so
 *  a destination originally written in angle brackets
 *  (`[d](<[[a b]]>)`) comes back without them. mdast does not record that
 *  spelling, and recovering it would mean slicing the original source,
 *  which would also turn the display back into literal text and undo the
 *  content preservation above. The title IS recorded, so it is kept. */
const degradedLinkNodes = (node: Link): RootContent[] => [
  {type: 'text', value: '['},
  ...(node.children as RootContent[]),
  {type: 'text', value: `](${node.url ?? ''}${node.title ? ` "${node.title}"` : ''})`},
]

/** Stand-in for a node the reassembly pass must treat as opaque. Written as
 *  an ESCAPE, never a literal NUL: one raw NUL byte anywhere in a source file
 *  makes `grep`/`rg` classify the whole file as binary and report no matches
 *  in it at all — silently, which in a repo worked mostly by agents means the
 *  file simply stops being findable. */
const OPAQUE_SENTINEL = '\u0000'

export interface RemarkWikilinksOptions {
  resolveAlias: (alias: string) => string | undefined
}

const LINK_URL_RE = /^\[\[(.+)\]\]$/


const buildWikilinkNode = (
  alias: string,
  blockId: string,
  children: RootContent[],
  raw: string,
  hasCustomDisplay: boolean,
): RootContent => ({
  type: 'wikilink',
  value: raw,
  children,
  data: {
    hName: 'wikilink',
    hProperties: {alias, blockId, hasCustomDisplay},
  },
} as unknown as RootContent)

const buildPageEmbedNode = (
  alias: string,
  blockId: string,
  raw: string,
  occurrenceId: string,
): RootContent => ({
  type: 'pageembed',
  value: raw,
  children: [{type: 'text', value: raw}],
  data: {
    hName: 'pageembed',
    hProperties: {alias, blockId, occurrenceId},
  },
} as unknown as RootContent)

// GFM autolink-literal runs at the parser stage and converts emails / URLs
// inside `[[…]]` into `link` siblings BEFORE any transformer sees the text.
// This predicate recognizes those nodes so the cross-node reassembly pass
// can treat them as transparent — their source-equivalent text is the
// single child's value.
//
// We distinguish autolink-literals from ordinary markdown links (which also
// produce `link` nodes) by source-range equality: an autolink-literal has
// no surrounding `[]`/`()`/`<>` syntax, so the link's position spans
// exactly the same offsets as its sole text child. The URL pattern is a
// sanity check that guards the (rare) case where both positions are
// absent (e.g. when remark drops positions inside synthesized contexts).
const isAutolinkLiteral = (node: RootContent): node is Link => {
  if (node.type !== 'link') return false
  if (node.children.length !== 1 || node.children[0].type !== 'text') return false

  const linkPos = node.position
  const childPos = node.children[0].position
  const positionsMatch =
    linkPos?.start.offset === childPos?.start.offset
    && linkPos?.end.offset === childPos?.end.offset
  if (!positionsMatch) return false

  const text = (node.children[0] as Literal).value
  const url = node.url ?? ''
  return url === `mailto:${text}`
    || url === `http://${text}`
    || url === `https://${text}`
    || url === text
}

// Returns the source-equivalent text for a child node when reassembling
// `[[…]]` spans that GFM split across siblings. Non-text, non-autolink
// nodes are opaque — we substitute a NUL placeholder so the `[[` / `]]`
// scan can't accidentally match across them.
const childSourceForReassembly = (node: RootContent): {text: string; opaque: boolean} => {
  if (node.type === 'text') return {text: (node as Literal).value, opaque: false}
  if (isAutolinkLiteral(node)) {
    return {text: (node.children[0] as Literal).value, opaque: false}
  }
  return {text: OPAQUE_SENTINEL, opaque: true}
}

export const remarkWikilinks: Plugin<[RemarkWikilinksOptions?]> = (options) => (tree) => {
  const resolve = (alias: string) => options?.resolveAlias?.(alias) ?? ''

  // First pass: rewrite `[display]([[alias]])` markdown links so the display
  // text is preserved as the rendered children of the wikilink.
  visit(tree, 'link', (node: Link, index, parent: Parent | undefined) => {
    if (index === undefined || !parent) return
    const match = LINK_URL_RE.exec(node.url ?? '')
    if (!match) return
    const alias = match[1]
    if (!alias) return
    if (!withinAliasCap(alias)) {
      // NOT a bare `return`. By the time this visitor runs, remark has
      // already turned the wrapper into an ordinary `link` node, so
      // declining to claim it leaves a live `<a href="[[alias]]">` in the
      // DOM: the app's anchor component only special-cases EXTERNAL hrefs
      // and react-markdown's default urlTransform passes a colon-less
      // string straight through, so clicking it is a plain relative
      // navigation AWAY from the page. Degrade to literal markup instead
      // — the same thing the bare scan does with a rejected span, and the
      // only outcome consistent with "this is not a link".
      const degraded = degradedLinkNodes(node)
      parent.children.splice(index, 1, ...degraded)
      return [SKIP, index + degraded.length]
    }

    parent.children.splice(index, 1, buildWikilinkNode(
      alias,
      resolve(alias),
      node.children as RootContent[],
      `[…](${node.url})`,
      true,
    ))
    return [SKIP, index + 1]
  })

  // Second pass: rewrite `[display]([[alias]])` written as plain text. Order
  // matters — must run before the bare scan, otherwise the bare scan would
  // chew the inner `[[alias]]` and lose the display text wrapper.
  visit(tree, 'text', (node: Literal, index, parent: Parent | undefined) => {
    if (index === undefined || !parent) return

    const src = node.value
    const out: RootContent[] = []
    let last = 0
    // The inner span is found by the SCANNER and the wrapper around it by
    // `linkFormWrapperAround` — the same function the rewriter uses to decide
    // what a pinned replacement may widen over. It used to be a regex whose
    // alias class excluded `[`/`]`, which is narrower than the grammar the
    // scanner accepts: after `closingDelimiterFor` let an alias close its own
    // bracket, `[short]([[Book [x]]])` stopped being recognized here and
    // rendered as literal markup with the author's display text lost. One
    // definition means the two sides cannot disagree again.
    for (const ref of parseOutermostReferences(src)) {
      // `continue` leaves `last` where it was, so a skipped span's text is
      // carried through verbatim by the next match's prefix slice (or the
      // trailing slice) — it renders as the literal markup it is, and a
      // non-wrapped span falls through to the bare scan in pass three.
      if (!ref.alias || !withinAliasCap(ref.alias)) continue
      const wrapper = linkFormWrapperAround(src, ref)
      if (wrapper === null) continue
      if (wrapper.start < last) continue
      if (wrapper.start > last) {
        out.push({type: 'text', value: src.slice(last, wrapper.start)})
      }
      out.push(buildWikilinkNode(
        ref.alias,
        resolve(ref.alias),
        [{type: 'text', value: wrapper.display}],
        src.slice(wrapper.start, wrapper.end),
        true,
      ))
      last = wrapper.end
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
    const refs = parseOutermostReferences(src)
    if (refs.length === 0) return

    const out: RootContent[] = []
    let last = 0
    for (const ref of refs) {
      // `![[alias]]` is a page-embed (Obsidian-style transclusion). When the
      // wikilink is preceded by `!` we consume it together with the bang and
      // emit a pageembed node instead of an inline wikilink.
      const isEmbed = ref.startIndex > 0 && src[ref.startIndex - 1] === '!'
      const spanStart = isEmbed ? ref.startIndex - 1 : ref.startIndex
      if (spanStart > last) {
        out.push({type: 'text', value: src.slice(last, spanStart)})
      }
      const raw = src.slice(spanStart, ref.endIndex)
      out.push(isEmbed
        ? buildPageEmbedNode(
            ref.alias,
            resolve(ref.alias),
            raw,
            `text:${(node.position?.start.offset ?? 0) + spanStart}`,
          )
        : buildWikilinkNode(
            ref.alias,
            resolve(ref.alias),
            [{type: 'text', value: ref.alias}],
            raw,
            false,
          ),
      )
      last = ref.endIndex
    }
    if (last < src.length) out.push({type: 'text', value: src.slice(last)})

    parent.children.splice(index, 1, ...out)
    return [SKIP, index + out.length]
  })

  // Fourth pass: reassemble `[[…]]` spans that GFM autolink-literal split
  // across sibling nodes during parsing. For `[[user@example.com]]` the
  // parser emits `text("[[") + link(mailto:…) + text("]]")` before any
  // transformer runs, so the bare-text pass above can't see the span.
  // We join each parent's children into a source-equivalent string, find
  // one cross-node `[[alias]]` span at a time, splice it back into a
  // single wikilink (or pageembed for `![[…]]`), and re-scan. The
  // re-scan keeps the index mappings consistent after each mutation.
  visit(tree, (node) => {
    const parent = node as Parent
    if (!Array.isArray((parent as {children?: unknown}).children)) return

    while (reassembleOneCrossNodeRef(parent, resolve)) {
      // Loop until no more cross-node refs remain.
    }
  })
}

const reassembleOneCrossNodeRef = (
  parent: Parent,
  resolve: (alias: string) => string,
): boolean => {
  const kids = parent.children as RootContent[]
  if (kids.length < 3) return false

  const pieces: string[] = []
  const opaqueFlags: boolean[] = []
  const starts: number[] = []
  let cursor = 0
  for (const child of kids) {
    starts.push(cursor)
    const {text, opaque} = childSourceForReassembly(child)
    pieces.push(text)
    opaqueFlags.push(opaque)
    cursor += text.length
  }
  const joined = pieces.join('')
  const refs = parseOutermostReferences(joined)
  if (refs.length === 0) return false

  for (const ref of refs) {
    let startChild = pieces.length - 1
    while (startChild > 0 && starts[startChild] > ref.startIndex) startChild--
    let endChild = startChild
    while (endChild < pieces.length - 1 && starts[endChild + 1] < ref.endIndex) endChild++
    if (startChild === endChild) continue  // single-node — third pass owned it

    let spansOpaque = false
    for (let i = startChild; i <= endChild; i++) {
      if (opaqueFlags[i]) { spansOpaque = true; break }
    }
    if (spansOpaque) continue

    const isEmbed = ref.startIndex > 0 && joined[ref.startIndex - 1] === '!'
    const spanStart = isEmbed ? ref.startIndex - 1 : ref.startIndex
    const prefix = pieces[startChild].slice(0, spanStart - starts[startChild])
    const suffix = pieces[endChild].slice(ref.endIndex - starts[endChild])
    const raw = joined.slice(spanStart, ref.endIndex)
    const parentOffset = parent.position?.start.offset ?? 0

    const replacement: RootContent[] = []
    if (prefix.length > 0) replacement.push({type: 'text', value: prefix})
    replacement.push(isEmbed
      ? buildPageEmbedNode(
          ref.alias,
          resolve(ref.alias),
          raw,
          `cross:${parentOffset + spanStart}`,
        )
      : buildWikilinkNode(
          ref.alias,
          resolve(ref.alias),
          [{type: 'text', value: ref.alias}],
          raw,
          false,
        ),
    )
    if (suffix.length > 0) replacement.push({type: 'text', value: suffix})

    kids.splice(startChild, endChild - startChild + 1, ...replacement)
    return true
  }

  return false
}
