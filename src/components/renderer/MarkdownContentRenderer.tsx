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
  contentTransform,
  containerClassName,
  containerElement,
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

  // Inline flow is a property of the rendering surface, not a synthetic flag:
  // the same read content renders as a block by default and INLINE inside a
  // reference (`isReference`), where it sits in the surrounding text as a
  // citation. Inline implies a `span` container (a `div` can't sit in inline
  // flow) + collapsing the block-level paragraph wrapper to a fragment. An
  // explicit `containerElement`/`containerClassName` (e.g. the breadcrumb
  // preview) still wins.
  const inline = blockContext.isReference === true
  const Container = containerElement ?? (inline ? 'span' : 'div')
  const className = containerClassName ?? (inline ? '' : DEFAULT_CONTAINER_CLASS)

  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const markdownConfig = resolveMarkdownConfig({block, blockContext})
  const components = inline
    ? {...markdownConfig.components, ...inlineComponents}
    : markdownConfig.components
  const content = contentTransform ? contentTransform(renderData.content) : renderData.content

  return (
    <Container className={className}>
      <Markdown
        remarkPlugins={markdownConfig.remarkPlugins}
        components={components}
      >
        {content}
      </Markdown>
    </Container>
  )
}
