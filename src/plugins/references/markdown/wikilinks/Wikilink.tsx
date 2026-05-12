import { ReactNode } from 'react'
import { buildAppHash } from '@/utils/routing'
import { useBlockLinkClick } from '@/utils/navigation'

export function Wikilink({alias, blockId, workspaceId, children}: {
  alias: string
  blockId: string
  workspaceId: string
  children: ReactNode
}) {
  // Hooks must run before any early return so the caller's hook order
  // stays stable across renders. blockId may be empty during a transient
  // reference-resolution miss; the hook still binds to ('', workspaceId)
  // safely — it's never invoked in that branch since we render plain text.
  const onClick = useBlockLinkClick({blockId, workspaceId})

  // Reference resolution is an invariant maintained by parseAndUpdateReferences
  // on every block.change(). If we ever land here without a blockId it's a
  // transient lookup miss — render the display text as plain text and let the
  // next edit reconcile it, rather than inventing a "broken link" UI state.
  if (!blockId) return <span>{children}</span>

  return (
    <a href={buildAppHash(workspaceId, blockId)} className="wikilink" data-alias={alias} onClick={onClick}>
      {children}
    </a>
  )
}
