import type { Block } from '@/data/internals/block'
import { defineFacet, isFunction } from '@/extensions/facet.ts'
import type { BlockContextType } from '@/types.ts'
import type { Components } from 'react-markdown'
import type { PluggableList } from 'unified'

export interface MarkdownRenderContext {
  block: Block
  blockContext: BlockContextType
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
