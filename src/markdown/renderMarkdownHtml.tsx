import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { Block } from '@/data/block.js'
import type { FacetRuntime } from '@/facets/facet.js'
import { AppRuntimeContextProvider } from '@/extensions/runtimeContext.js'
import type { BlockContextType } from '@/types.js'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.js'
import {
  markdownExtensionsFacet,
  resolveMarkdownRenderConfig,
  type MarkdownRenderConfig,
  type MarkdownRenderContext,
} from '@/markdown/extensions.js'

export type RenderMarkdownHtmlMode = 'app' | 'external'

export interface RenderMarkdownHtmlOptions {
  /** `app` uses the runtime markdown facet; `external` uses the minimal GFM
   *  export profile. When omitted, runtime+context imply `app`, otherwise the
   *  helper falls back to `external` for backwards-compatible standalone use. */
  mode?: RenderMarkdownHtmlMode
  runtime?: FacetRuntime
  context?: MarkdownRenderContext
}

const staticMarkdownContext = (content: string): MarkdownRenderContext => ({
  block: {} as Block,
  blockContext: {} as BlockContextType,
  data: {content, references: [], workspaceId: ''},
})

const StaticMarkdownImage: Components['img'] = ({node: _node, ...props}) => {
  void _node
  return <img {...props} />
}

/** React 19's static markup renderer emits preload hints for images. They are
 *  useful for a full HTML response but invalid when callers need a content
 *  fragment, such as API payloads posted to another service. */
const stripReactResourceHints = (html: string): string =>
  html.replace(/<link rel="preload" as="image" href="[^"]*"\/>/g, '')

const contextForContent = (
  content: string,
  context: MarkdownRenderContext | undefined,
): MarkdownRenderContext => {
  if (!context) return staticMarkdownContext(content)
  return {
    ...context,
    data: {
      ...context.data,
      content,
    },
  }
}

const externalMarkdownConfig = (context: MarkdownRenderContext): MarkdownRenderConfig =>
  resolveMarkdownRenderConfig([gfmMarkdownExtension], context)

const markdownConfigFor = (
  content: string,
  options: RenderMarkdownHtmlOptions | undefined,
): {config: MarkdownRenderConfig, mode: RenderMarkdownHtmlMode} => {
  const mode = options?.mode ??
    (options?.runtime && options.context ? 'app' : 'external')
  const context = contextForContent(content, options?.context)

  if (mode === 'app') {
    if (!options?.runtime || !options.context) {
      throw new Error('renderMarkdownHtml mode "app" requires runtime and context')
    }
    return {
      config: options.runtime.read(markdownExtensionsFacet)(context),
      mode,
    }
  }

  return {
    config: externalMarkdownConfig(context),
    mode,
  }
}

export const renderMarkdownHtml = (
  content: string,
  options?: RenderMarkdownHtmlOptions,
): string => {
  const {config, mode} = markdownConfigFor(content, options)
  const components = mode === 'external'
    ? {
      ...config.components,
      img: StaticMarkdownImage,
    }
    : config.components
  const markdown = (
    <Markdown
      remarkPlugins={config.remarkPlugins}
      components={components}
    >
      {content}
    </Markdown>
  )
  const element = mode === 'app' && options?.runtime
    ? (
      <AppRuntimeContextProvider value={options.runtime}>
        {markdown}
      </AppRuntimeContextProvider>
    )
    : markdown

  return stripReactResourceHints(renderToStaticMarkup(element))
}
