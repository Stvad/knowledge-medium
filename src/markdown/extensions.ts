import type { Block } from '@/data/block.ts'
import { defineFacet } from '@/extensions/facet.ts'
import type { BlockContextType } from '@/types.ts'
import type { Components } from 'react-markdown'
import type { PluggableList } from 'unified'

export interface MarkdownRenderContext {
  block: Block
  blockContext: BlockContextType
}

type MarkdownExtensionValue<T> =
  | T
  | MarkdownExtensionResolver<T>

type MarkdownExtensionResolver<T> =
  (context: MarkdownRenderContext) => T | null | undefined | false

export interface MarkdownExtension {
  id: string
  appliesTo?: (context: MarkdownRenderContext) => boolean
  remarkPlugins?: MarkdownExtensionValue<PluggableList>
  components?: MarkdownExtensionValue<Components>
}

export interface MarkdownRenderConfig {
  remarkPlugins: PluggableList
  components: Components
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isMarkdownExtension = (value: unknown): value is MarkdownExtension =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  (value.appliesTo === undefined || typeof value.appliesTo === 'function') &&
  (value.remarkPlugins === undefined ||
    typeof value.remarkPlugins === 'function' ||
    Array.isArray(value.remarkPlugins)) &&
  (value.components === undefined ||
    typeof value.components === 'function' ||
    isRecord(value.components))

export const markdownExtensionsFacet = defineFacet<MarkdownExtension, readonly MarkdownExtension[]>({
  id: 'core.markdown-extensions',
  validate: isMarkdownExtension,
})

const resolveMarkdownExtensionValue = <T,>(
  value: MarkdownExtensionValue<T> | undefined,
  context: MarkdownRenderContext,
) => {
  if (value === undefined) return undefined

  if (typeof value === 'function') {
    return (value as MarkdownExtensionResolver<T>)(context)
  }

  return value
}

export const resolveMarkdownRenderConfig = (
  extensions: readonly MarkdownExtension[],
  context: MarkdownRenderContext,
): MarkdownRenderConfig => {
  const remarkPlugins: PluggableList = []
  const components: Components = {}

  for (const extension of extensions) {
    if (extension.appliesTo && !extension.appliesTo(context)) {
      continue
    }

    const extensionPlugins = resolveMarkdownExtensionValue(extension.remarkPlugins, context)
    if (extensionPlugins) {
      remarkPlugins.push(...extensionPlugins)
    }

    const extensionComponents = resolveMarkdownExtensionValue(extension.components, context)
    if (extensionComponents) {
      Object.assign(components, extensionComponents)
    }
  }

  return {
    remarkPlugins,
    components,
  }
}
