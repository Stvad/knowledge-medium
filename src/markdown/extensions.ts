import type { Block } from '../data/block'
import { defineFacet, isFunction } from '@/facets/facet.js'
import type { BlockContextType } from '@/types.js'
import type { BlockData } from '@/data/api'
import type { Components } from 'react-markdown'
import type { PluggableList } from 'unified'

/** The reactive block-snapshot fields a markdown extension may read while
 *  building its render config. These are exactly the fields the renderer
 *  subscribes to (via its `useHandle` selector). */
export type MarkdownRenderData = Pick<BlockData, 'content' | 'references' | 'workspaceId'>

/** Values provided for a block's markdown by the components rendering around
 *  it, by key (`MarkdownInputProvider`). */
export type MarkdownInput = Readonly<Record<string, unknown>>

export interface MarkdownRenderContext {
  block: Block
  blockContext: BlockContextType
  /** Reactive input for extensions, the channel to use instead of block
   *  context. Every block renderer below memoizes its slots on block context,
   *  so a new value there remounts every embed and block ref in the content; a
   *  new value here only re-renders the markdown below it, and remounts just
   *  what the new tree itself moves. */
  input: MarkdownInput
  /** The reactive snapshot the renderer is currently displaying. Extensions
   *  MUST derive rendered output (e.g. a wikilink alias→id map) from this —
   *  NOT from `block.peek()`. Under React Compiler the resolver call is
   *  memoized on its referentially-stable inputs (`block` identity never
   *  changes for a given id), so a `peek()` read would be captured on the
   *  first render and never refreshed when the row's data later changes
   *  (e.g. the async `references` parse landing). Reading `data` keeps the
   *  config a tracked dependency, so it recomputes when the snapshot does. */
  data: MarkdownRenderData
}

export interface MarkdownRenderConfig {
  remarkPlugins: PluggableList
  /** Applied to the hast tree after remark, before it is mapped to React — so
   *  a transformation over the whole tree lives in one plugin instead of one
   *  `components` override per element type, and can add or remove nodes
   *  rather than only render the ones it is handed. */
  rehypePlugins: PluggableList
  /** Define each component once, at module scope, and read what it needs from
   *  the node or from context (`useMarkdownSource()` for the block being
   *  rendered): one built per resolve is a new element type each time, and
   *  React remounts its subtree, an embed's open editor included, whenever the
   *  block re-renders. */
  components: Components
}

export type MarkdownExtensionConfig =
  | Partial<MarkdownRenderConfig>
  | null
  | undefined
  | false

export type MarkdownExtension =
  (context: MarkdownRenderContext) => MarkdownExtensionConfig

export type MarkdownRenderConfigResolver =
  (context: MarkdownRenderContext) => MarkdownRenderConfig

export const resolveMarkdownRenderConfig = (
  extensions: readonly MarkdownExtension[],
  context: MarkdownRenderContext,
): MarkdownRenderConfig => {
  const remarkPlugins: PluggableList = []
  const rehypePlugins: PluggableList = []
  const components: Components = {}

  for (const extension of extensions) {
    const extensionConfig = extension(context)
    if (!extensionConfig) continue

    if (extensionConfig.remarkPlugins) {
      remarkPlugins.push(...extensionConfig.remarkPlugins)
    }

    if (extensionConfig.rehypePlugins) {
      rehypePlugins.push(...extensionConfig.rehypePlugins)
    }

    if (extensionConfig.components) {
      Object.assign(components, extensionConfig.components)
    }
  }

  return {
    remarkPlugins,
    rehypePlugins,
    components,
  }
}

export const markdownExtensionsFacet = defineFacet<MarkdownExtension, MarkdownRenderConfigResolver>({
  id: 'core.markdown-extensions',
  combine: extensions => context => resolveMarkdownRenderConfig(extensions, context),
  empty: () => () => ({
    remarkPlugins: [],
    rehypePlugins: [],
    components: {},
  }),
  validate: isFunction<MarkdownExtension>,
})
