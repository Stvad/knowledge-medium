import { useCallback, type MouseEvent } from 'react'
import type { Block } from '@/data/block'
import type { BlockContextType } from '@/types.js'
import { useBlockOpener } from '@/utils/navigation.js'
import { BreadcrumbList } from './BreadcrumbList.js'

interface PromotableBreadcrumbListProps {
  parents: readonly Block[]
  workspaceId: string
  overrides: Partial<BlockContextType>
  /** Plain primary click promotes (unfurls) the segment in place. */
  onPromote: (parent: Block) => void
  className?: string
  itemClassName?: string
  separatorClassName?: string
}

/** A `BreadcrumbList` wired for promote-in-place: a plain primary click
 *  promotes the segment (`onPromote`); modifier clicks fall through to the
 *  shared block opener (shift / shift+alt → sidebar / new panel). Used by
 *  both the backlink entries and the SRS review session. */
export const PromotableBreadcrumbList = ({
  parents,
  workspaceId,
  overrides,
  onPromote,
  className,
  itemClassName,
  separatorClassName,
}: PromotableBreadcrumbListProps) => {
  const openBlock = useBlockOpener()
  const handleLinkClick = useCallback((event: MouseEvent, parent: Block) => {
    openBlock(event, {blockId: parent.id, workspaceId})
  }, [openBlock, workspaceId])

  return (
    <BreadcrumbList
      parents={parents}
      workspaceId={workspaceId}
      overrides={overrides}
      onSelect={onPromote}
      onLinkClick={handleLinkClick}
      className={className}
      itemClassName={itemClassName}
      separatorClassName={separatorClassName}
    />
  )
}
