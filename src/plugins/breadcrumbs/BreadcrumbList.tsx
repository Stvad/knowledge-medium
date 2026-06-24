import { MouseEvent } from 'react'
import { Block } from '@/data/block'
import { BlockContextType } from '@/types.js'
import { BlockComponent } from '@/components/BlockComponent.js'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { buildAppHash } from '@/utils/routing.js'
import { cn } from '@/lib/utils.js'
import { breadcrumbRenderScopeId } from '@/utils/renderScope.js'

interface BreadcrumbListProps {
  parents: readonly Block[]
  workspaceId: string
  overrides: Partial<BlockContextType>
  // When provided, plain primary clicks call onSelect (e.g. inline unfurl).
  onSelect?: (parent: Block) => void
  // Optional owner policy for clicks not consumed by onSelect. When omitted,
  // the anchor keeps its native href behavior after this component captures
  // the click away from preview content nested inside the breadcrumb.
  onLinkClick?: (event: MouseEvent, parent: Block) => void
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
  onLinkClick,
  className,
  itemClassName,
  separatorClassName,
}: BreadcrumbListProps) => {
  const blockContext = useBlockContext()
  const parentRenderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : 'breadcrumb-root'

  if (parents.length === 0) return null

  return (
    <div className={className}>
      {parents.map((parent, index) => (
        <span key={parent.id} className="flex items-center min-w-0">
          <a
            href={buildAppHash(workspaceId, parent.id)}
            // text-inherit so the link picks up the container's muted color
            // instead of the user-agent blue.
            className={cn('text-inherit', itemClassName)}
            onClickCapture={(event: MouseEvent) => {
              // Capture before nested markdown links/block refs can stop the
              // event; the breadcrumb item owns clicks on its preview content.
              event.stopPropagation()
              if (
                onSelect &&
                event.button === 0 &&
                !event.metaKey &&
                !event.ctrlKey &&
                !event.shiftKey &&
                !event.altKey
              ) {
                event.preventDefault()
                onSelect(parent)
                return
              }

              onLinkClick?.(event, parent)
            }}
          >
            <span className={INNER_CLASS}>
              <NestedBlockContextProvider
                overrides={{
                  ...overrides,
                  scopeRootId: parent.id,
                  renderScopeId: breadcrumbRenderScopeId(
                    parentRenderScopeId,
                    parent.id,
                    String(index),
                  ),
                }}
              >
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
