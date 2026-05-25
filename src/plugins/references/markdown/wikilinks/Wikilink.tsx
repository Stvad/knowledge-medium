import { ReactNode } from 'react'
import { buildAppHash } from '@/utils/routing'
import { useOpenBlock } from '@/utils/navigation'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import {
  isWikilinkDisplayParts,
  resolveWikilinkDisplay,
} from './wikilinkDecorator.ts'
import type { Block } from '@/data/block'

export function Wikilink({alias, blockId, sourceBlock, workspaceId, hasCustomDisplay = false, children}: {
  alias: string
  blockId: string
  sourceBlock?: Block
  workspaceId: string
  /** True when the markdown source carried an explicit display label, as
   *  in `[display]([[alias]])`. Display-decorators are bypassed in that
   *  case so the author's intent isn't silently overridden. */
  hasCustomDisplay?: boolean
  children: ReactNode
}) {
  // Hooks must run before any early return so the caller's hook order
  // stays stable across renders. blockId may be empty during a transient
  // reference-resolution miss; the hook still binds to ('', workspaceId)
  // safely — it's never invoked in that branch since we render plain text.
  const onClick = useOpenBlock({blockId, workspaceId})
  const runtime = useAppRuntime()
  const decorated = hasCustomDisplay
    ? null
    : resolveWikilinkDisplay(runtime, {alias, blockId, sourceBlock, workspaceId, runtime})
  const decoratedParts = isWikilinkDisplayParts(decorated) ? decorated : null
  const display: ReactNode = decoratedParts
    ? decoratedParts.content
    : (decorated as ReactNode | null) ?? children
  const before = decoratedParts?.before
  const after = decoratedParts?.after

  // Reference resolution is an invariant maintained by parseAndUpdateReferences
  // on every block.change(). If we ever land here without a blockId it's a
  // transient lookup miss — render the display text as plain text and let the
  // next edit reconcile it, rather than inventing a "broken link" UI state.
  if (!blockId) return <span>{before}{display}{after}</span>

  return (
    <>
      {before}
      <a href={buildAppHash(workspaceId, blockId)} className="wikilink" data-alias={alias} onClick={onClick}>
        {display}
      </a>
      {after}
    </>
  )
}
