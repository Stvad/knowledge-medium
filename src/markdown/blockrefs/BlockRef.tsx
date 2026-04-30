import { Fragment, MouseEvent, ReactNode } from 'react'
import Markdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { useRepo } from '@/context/repo'
import { useBlockContext } from '@/context/block'
import { useContent, useData } from '@/hooks/block'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { markdownExtensionsFacet } from '@/markdown/extensions'
import { buildAppHash } from '@/utils/routing'
import { BlockRefAncestorsProvider, useBlockRefAncestors } from './cycleGuard'

// Force the inner Markdown render to stay inline — block-level elements
// (paragraph, lists, headings) inside a ref span would break flow with the
// surrounding text. Block-level wrappers collapse to fragments; their
// children still get the configured remark/components treatment.
const inlineComponents: Components = {
  p: ({children}: {children?: ReactNode}) => <Fragment>{children}</Fragment>,
}

export function BlockRef({blockId}: {blockId: string}) {
  const repo = useRepo()
  const {panelId} = useBlockContext()
  const ancestors = useBlockRefAncestors()
  const target = repo.block(blockId)
  const targetData = useData(target)
  const content = useContent(target)
  const runtime = useAppRuntime()

  if (!targetData) {
    return <span className="blockref blockref--unresolved">(({blockId.slice(0, 8)}…))</span>
  }

  if (ancestors.has(blockId)) {
    return <span className="blockref blockref--cycle" title="Cycle: this block already appears in the ref chain">↻ (({blockId.slice(0, 8)}…))</span>
  }

  const workspaceId = targetData.workspaceId
  const href = buildAppHash(workspaceId, blockId)

  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    e.stopPropagation()
    if (e.shiftKey) {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('open-panel', {
        detail: {blockId, sourcePanelId: panelId},
      }))
    }
  }

  const resolveMarkdownConfig = runtime.read(markdownExtensionsFacet)
  const baseConfig = resolveMarkdownConfig({block: target, blockContext: {panelId}})
  const markdownConfig = {
    ...baseConfig,
    components: {...baseConfig.components, ...inlineComponents},
  }

  return (
    <BlockRefAncestorsProvider ancestor={blockId}>
      <a
        href={href}
        className="blockref text-inherit no-underline cursor-pointer rounded-sm px-0.5 hover:bg-muted/60"
        data-block-id={blockId}
        onClick={onClick}
      >
        <Markdown
          remarkPlugins={markdownConfig.remarkPlugins}
          components={markdownConfig.components}
        >
          {content}
        </Markdown>
      </a>
    </BlockRefAncestorsProvider>
  )
}
