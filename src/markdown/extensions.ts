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

export interface MarkdownRenderContext {
  block: Block
  blockContext: BlockContextType
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
  const components: Components = {}

  for (const extension of extensions) {
    const extensionConfig = extension(context)
    if (!extensionConfig) continue

    if (extensionConfig.remarkPlugins) {
      remarkPlugins.push(...extensionConfig.remarkPlugins)
    }

    if (extensionConfig.components) {
      Object.assign(components, extensionConfig.components)
    }
  }

  return {
    remarkPlugins,
    components,
  }
}

export const markdownExtensionsFacet = defineFacet<MarkdownExtension, MarkdownRenderConfigResolver>({
  id: 'core.markdown-extensions',
  combine: extensions => context => resolveMarkdownRenderConfig(extensions, context),
  empty: () => () => ({
    remarkPlugins: [],
    components: {},
  }),
  validate: isFunction<MarkdownExtension>,
})
