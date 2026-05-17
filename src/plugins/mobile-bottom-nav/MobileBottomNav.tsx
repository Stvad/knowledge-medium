import { useIsMobile } from '@/utils/react.tsx'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { useActiveContextsState } from '@/shortcuts/ActiveContexts.tsx'
import { useRunAction } from '@/shortcuts/runAction.ts'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { mobileBottomNavItemsFacet } from './facet.ts'
import { MobileBottomNavButton } from './Button.tsx'

function MobileBottomNavActionButton({
  action,
  disabled,
}: {
  action: ActionConfig
  disabled: boolean
}) {
  const runAction = useRunAction()
  const handleClick = () => {
    void runAction(
      action.id,
      new CustomEvent('mobile-bottom-nav-action', {detail: {actionId: action.id}}),
    )
  }

  if (!action.icon) return null

  return (
    <MobileBottomNavButton
      label={action.description}
      icon={action.icon}
      onClick={handleClick}
      disabled={disabled}
    />
  )
}

function MobileBottomNavSurface() {
  const runtime = useAppRuntime()
  const items = runtime.read(mobileBottomNavItemsFacet)
  const actionsById = new Map(
    getEffectiveActions(runtime)
      .filter(action => action.context === ActionContextTypes.GLOBAL)
      .map(action => [action.id, action]),
  )
  const activeContexts = useActiveContextsState()

  if (items.length === 0) return null

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
      style={{paddingBottom: 'env(safe-area-inset-bottom)'}}
      aria-label="Mobile navigation"
      data-block-interaction="ignore"
    >
      <div className="mx-auto flex h-16 max-w-md items-center justify-around">
        {items.map(({id, actionId}) => {
          const action = actionsById.get(actionId)
          if (!action) return null
          return (
            <MobileBottomNavActionButton
              key={id}
              action={action}
              disabled={!activeContexts.has(action.context)}
            />
          )
        })}
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
