import { ReactNode } from 'react'
import { BlockComponent } from '@/components/BlockComponent'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block'
import { useRepo } from '@/context/repo'
import { useHandle } from '@/hooks/block'
import { embedRenderScopeId, outlineRenderScopeId } from '@/utils/renderScope.js'
import { BlockRefAncestorsProvider } from './cycleGuard'
import { useBlockRefAncestors } from './useBlockRefAncestors'
import { ReferenceLink } from './ReferenceLink'

const REFERENCE_CONTEXT_OVERRIDES = {isNestedSurface: true, isReference: true}

const hasDisplayChildren = (children: ReactNode) =>
  children !== undefined
  && children !== null
  && (!Array.isArray(children) || children.length > 0)

const shortBlockRef = (blockId: string) => `((${blockId.slice(0, 8)}…))`

/**
 * Inline block reference (`((id))`). A reference is the SAME block, rendered
 * through the one block-rendering pipeline with the reference layout (which
 * picks the block's raw content and wraps it in a navigating link). This thin
 * entry only handles the states that must short-circuit *before* mounting the
 * target: unresolved, cycle, and the alias case (where a human-typed display
 * string replaces the content, so there's no reason to mount the target at
 * all). Everything else flows into `BlockComponent`.
 */
export function BlockRef({
  blockId,
  sourceBlockId,
  occurrenceId,
  children,
}: {
  blockId: string
  sourceBlockId?: string
  occurrenceId?: string
  children?: ReactNode
}) {
  const repo = useRepo()
  const blockContext = useBlockContext()
  const ancestors = useBlockRefAncestors()
  const target = repo.block(blockId)
  // null once the target is confirmed missing; undefined while it loads.
  const targetState = useHandle(target, {selector: doc => doc === null ? 'missing' : doc ? 'exists' : 'loading'})
  const display = hasDisplayChildren(children) ? children : null

  if (targetState !== 'exists') {
    const missing = targetState === 'missing'
    return (
      <span
        className={`blockref blockref--unresolved${missing ? ' blockref--missing' : ''}`}
        title={missing ? `No block has the id ${blockId}` : undefined}
      >
        {display ?? shortBlockRef(blockId)}
      </span>
    )
  }

  if (ancestors.has(blockId)) {
    return (
      <span className="blockref blockref--cycle" title="Cycle: this block already appears in the ref chain">
        ↻ {display ?? shortBlockRef(blockId)}
      </span>
    )
  }

  // Alias short-circuit: the reference carries its own display string, so render
  // a plain navigating link and do NOT mount the target's content.
  if (display) {
    return <ReferenceLink block={target}>{display}</ReferenceLink>
  }

  const parentRenderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : outlineRenderScopeId(sourceBlockId ?? blockId)
  const renderScopeId = embedRenderScopeId(
    parentRenderScopeId,
    sourceBlockId ?? blockId,
    occurrenceId ?? 'unknown',
    blockId,
  )

  return (
    <BlockRefAncestorsProvider ancestor={blockId}>
      <NestedBlockContextProvider overrides={{...REFERENCE_CONTEXT_OVERRIDES, renderScopeId, scopeRootId: blockId}}>
        <BlockComponent blockId={blockId}/>
      </NestedBlockContextProvider>
    </BlockRefAncestorsProvider>
  )
}
