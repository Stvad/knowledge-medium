import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import type { Block } from '@/data/block.js'
import type { BlockContextType } from '@/types.js'
import { gfmMarkdownExtension } from '@/markdown/defaultMarkdownExtension.js'
import type { MarkdownRenderContext } from '@/markdown/extensions.js'

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

export const renderMarkdownHtml = (content: string): string => {
  const gfmConfig = gfmMarkdownExtension(staticMarkdownContext(content)) || {}
  return stripReactResourceHints(renderToStaticMarkup(
    <Markdown
      remarkPlugins={gfmConfig.remarkPlugins}
      components={{
        ...gfmConfig.components,
        img: StaticMarkdownImage,
      }}
    >
      {content}
    </Markdown>,
  ))
}
