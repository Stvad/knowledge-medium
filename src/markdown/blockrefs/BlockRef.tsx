import { MouseEvent } from 'react'
import Markdown from 'react-markdown'
import { useRepo } from '@/context/repo'
import { useBlockContext } from '@/context/block'
import { useContent, useData } from '@/hooks/block'
import { useAppRuntime } from '@/extensions/runtimeContext'
import { markdownExtensionsFacet } from '@/markdown/extensions'
import { buildAppHash } from '@/utils/routing'
import { BlockRefAncestorsProvider, useBlockRefAncestors } from './cycleGuard'

export function BlockRef({blockId}: {blockId: string}) {
  const repo = useRepo()
  const {panelId} = useBlockContext()
  const ancestors = useBlockRefAncestors()
  const target = repo.find(blockId)
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
  const markdownConfig = resolveMarkdownConfig({block: target, blockContext: {panelId}})

  return (
    <BlockRefAncestorsProvider ancestor={blockId}>
      <a href={href} className="blockref" data-block-id={blockId} onClick={onClick}>
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
