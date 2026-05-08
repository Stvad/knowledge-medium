import { MouseEvent } from 'react'
import { Block } from '../data/block'
import { BlockContextType } from '@/types.ts'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.tsx'
import { buildAppHash } from '@/utils/routing.ts'
import { useNavigate } from '@/utils/navigation.ts'
import { cn } from '@/lib/utils.ts'

interface BreadcrumbListProps {
  parents: readonly Block[]
  workspaceId: string
  overrides: Partial<BlockContextType>
  // When provided, plain primary clicks call onSelect (e.g. inline unfurl)
  // instead of routing through navigate(). Shift-click still opens in a new
  // panel, and modifier/middle/right clicks fall through to the href so the
  // user can cmd-click for a new tab the way the rest of the app's links work.
  onSelect?: (parent: Block) => void
  className?: string
  itemClassName?: string
  separatorClassName?: string
}

const INNER_CLASS =
  'inline [&>*]:inline [&>p]:m-0 [&>*]:whitespace-nowrap [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:font-normal [&>*]:text-inherit'

export const BreadcrumbList = ({
  parents,
  workspaceId,
  overrides,
  onSelect,
  className,
  itemClassName,
  separatorClassName,
}: BreadcrumbListProps) => {
  const {panelId} = useBlockContext()
  const navigate = useNavigate()

  if (parents.length === 0) return null

  return (
    <div className={className}>
      {parents.map((parent) => (
        <span key={parent.id} className="flex items-center min-w-0">
          <a
            href={buildAppHash(workspaceId, parent.id)}
            // text-inherit so the link picks up the container's muted color
            // instead of the user-agent blue.
            className={cn('text-inherit', itemClassName)}
            onClick={(event: MouseEvent) => {
              // Stop propagation either way — without it, the event bubbles
              // to a surrounding block's click handler, which preventDefaults
              // and swallows the browser navigation.
              event.stopPropagation()
              if (event.shiftKey) {
                event.preventDefault()
                navigate({
                  blockId: parent.id,
                  workspaceId,
                  target: 'new-panel',
                  sourcePanelId: panelId,
                })
                return
              }
              if (event.metaKey || event.ctrlKey || event.altKey) return
              if (event.button !== 0) return
              event.preventDefault()
              if (onSelect) {
                onSelect(parent)
                return
              }
              // Plain primary click without an inline-unfurl callback —
              // navigate the panel the click came from. Side panel stays
              // local; main panel writes the URL hash.
              navigate({blockId: parent.id, workspaceId, target: 'focused', panelId})
            }}
          >
            <span className={INNER_CLASS}>
              <NestedBlockContextProvider overrides={overrides}>
                <BlockComponent blockId={parent.id}/>
              </NestedBlockContextProvider>
            </span>
          </a>
          <span className={separatorClassName}>›</span>
        </span>
      ))}
    </div>
  )
}
