import { ReactNode } from 'react'
import { Block } from '@/data/block'
import { useRepo } from '@/context/repo'
import { useWorkspaceId } from '@/hooks/block'
import { buildAppHash } from '@/utils/routing'
import { useOpenBlock } from '@/utils/navigation'

/**
 * The navigating anchor a block reference wraps its content in: a
 * workspace-scoped link that opens the target block on click. Shared by the
 * reference layout (wrapping the target's raw content) and `BlockRef`'s alias
 * short-circuit (wrapping the alias text, without mounting the target), so the
 * href / open-block behaviour lives in one place.
 */
export function ReferenceLink({block, children}: {block: Block; children: ReactNode}) {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const onClick = useOpenBlock({blockId: block.id, workspaceId})
  const href = buildAppHash(workspaceId, block.id)

  return (
    <a
      href={href}
      className="blockref text-inherit no-underline cursor-pointer rounded-sm px-0.5 hover:bg-muted/60"
      data-block-id={block.id}
      onClick={onClick}
    >
      {children}
    </a>
  )
}
