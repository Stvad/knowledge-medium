import { MouseEvent } from 'react'
import { Block } from '@/data/block'
import { BlockContextType } from '@/types.ts'
import { BlockComponent } from '@/components/BlockComponent.tsx'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.tsx'
import { buildAppHash } from '@/utils/routing.ts'
import { handleBlockLinkClick, useNavigate } from '@/utils/navigation.ts'
import { cn } from '@/lib/utils.ts'

interface BreadcrumbListProps {
  parents: readonly Block[]
  workspaceId: string
  overrides: Partial<BlockContextType>
  // When provided, plain primary clicks call onSelect (e.g. inline unfurl).
  // Other clicks follow the same modifier policy as block links.
  onSelect?: (parent: Block) => void
  className?: string
  itemClassName?: string
  separatorClassName?: string
}

const INNER_CLASS =
  'pointer-events-none inline [&>*]:inline [&>p]:m-0 [&>*]:whitespace-nowrap [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:font-normal [&>*]:text-inherit'

export const BreadcrumbList = ({
  parents,
  workspaceId,
  overrides,
  onSelect,
  className,
  itemClassName,
  separatorClassName,
}: BreadcrumbListProps) => {
  const navigate = useNavigate()
  const {panelId} = useBlockContext()

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
            onClickCapture={(event: MouseEvent) => {
              // Capture before nested markdown links/block refs can stop the
              // event; the breadcrumb item owns clicks on its preview content.
              if (
                onSelect &&
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey
              ) {
                event.stopPropagation()
                event.preventDefault()
                onSelect(parent)
                return
              }

              handleBlockLinkClick(event, navigate, panelId, {
                blockId: parent.id,
                workspaceId,
              })
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
