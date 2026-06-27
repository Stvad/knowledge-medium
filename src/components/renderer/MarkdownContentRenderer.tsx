import { Fragment, ReactNode } from 'react'
import { BlockRendererProps } from '@/types.js'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { useBlockContext } from '@/context/block.js'
import { useHandle } from '@/hooks/block.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { markdownExtensionsFacet } from '@/markdown/extensions.js'

const DEFAULT_CONTAINER_CLASS = 'min-h-[1.7em] whitespace-pre-wrap overflow-x-clip overflow-y-visible max-w-full'

// Force the inner Markdown render to stay inline — block-level elements
// (paragraph, lists, headings) inside an inline span would break flow with
// the surrounding text. The block-level paragraph wrapper collapses to a
// fragment; its children still get the configured remark/components
// treatment. (Previously hand-rolled inside `BlockRef`; centralised here so
// the unified raw-content path shares one inline-markdown definition.)
const inlineComponents: Components = {
  p: ({children}: {children?: ReactNode}) => <Fragment>{children}</Fragment>,
}

interface MarkdownContentRendererProps extends BlockRendererProps {
  contentTransform?: (content: string) => string
  containerClassName?: string
  containerElement?: 'div' | 'span'
}

export function MarkdownContentRenderer({
  block,
  inline = false,
  contentTransform,
  // Inline rendering implies a `span` container (a `div` can't sit in inline
  // flow); an explicit `containerElement` still wins for callers that pass it.
  containerClassName = inline ? '' : DEFAULT_CONTAINER_CLASS,
  containerElement: Container = inline ? 'span' : 'div',
}: MarkdownContentRendererProps) {
  const renderData = useHandle(block, {
    selector: doc => doc
      ? {
        content: doc.content,
        references: doc.references,
        workspaceId: doc.workspaceId,
      }
      : undefined,
  })
  const blockContext = useBlockContext()
  const runtime = useAppRuntime()

  if (!renderData) return null
  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const markdownConfig = resolveMarkdownConfig({block, blockContext})
  const components = inline
    ? {...markdownConfig.components, ...inlineComponents}
    : markdownConfig.components
  const content = contentTransform ? contentTransform(renderData.content) : renderData.content

  return (
    <Container className={containerClassName}>
      <Markdown
        remarkPlugins={markdownConfig.remarkPlugins}
        components={components}
      >
        {content}
      </Markdown>
    </Container>
  )
}
