import { MouseEvent, ReactNode } from 'react'
import { useBlockContext } from '@/context/block'
import { buildAppHash } from '@/utils/routing'

export function Wikilink({alias, blockId, workspaceId, children}: {
  alias: string
  blockId: string
  workspaceId: string
  children: ReactNode
}) {
  const {panelId} = useBlockContext()

  // Reference resolution is an invariant maintained by parseAndUpdateReferences
  // on every block.change(). If we ever land here without a blockId it's a
  // transient lookup miss — render the display text as plain text and let the
  // next edit reconcile it, rather than inventing a "broken link" UI state.
  if (!blockId) return <span>{children}</span>

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

  return (
    <a href={href} className="wikilink" data-alias={alias} onClick={onClick}>
      {children}
    </a>
  )
}
