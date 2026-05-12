import { useIsMobile } from '@/utils/react.tsx'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { ExtensionRenderBoundary } from '@/extensions/ExtensionRenderBoundary.tsx'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { ActionContextTypes } from '@/shortcuts/types.ts'
import { mobileBottomNavItemsFacet } from './facet.ts'

function MobileBottomNavSurface() {
  const runtime = useAppRuntime()
  const items = runtime.read(mobileBottomNavItemsFacet)

  if (items.length === 0) return null

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
      style={{paddingBottom: 'env(safe-area-inset-bottom)'}}
      aria-label="Mobile navigation"
      data-block-interaction="ignore"
    >
      <div className="mx-auto flex h-16 max-w-md items-center justify-around">
        {items.map(({id, component: Item}) => (
          <ExtensionRenderBoundary key={id}>
            <Item/>
          </ExtensionRenderBoundary>
        ))}
      </div>
    </nav>
  )
}

export function MobileBottomNav() {
  const isMobile = useIsMobile()
  const activeContexts = useActiveContextsState()
  const isEditing =
    activeContexts.has(ActionContextTypes.EDIT_MODE_CM) ||
    activeContexts.has(ActionContextTypes.PROPERTY_EDITING)

  if (!isMobile || isEditing) return null

  return <MobileBottomNavSurface/>
}
