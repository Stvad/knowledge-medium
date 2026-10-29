import { useIsMobile } from '@/utils/react.js'
import { useActiveContextsState, type ActiveContextsMap } from '@/shortcuts/ActiveContexts.js'
import { useActionRefItems } from '@/shortcuts/actionRefItems.js'
import { dispatchActionWithDeps } from '@/shortcuts/runAction.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { mobileBottomNavItemsFacet } from './facet.ts'
import { MobileBottomNavButton } from './Button.tsx'

/** A bar button for an action ref: drawn from the action's icon and
 *  description, enabled while the action's context is active, and dispatched
 *  with that context's deps through the supplied-deps path (deps validation,
 *  `canDispatch`, error logging). `trigger` names the synthesized event. */
export function ActionRefBarButton({
  action,
  activeContexts,
  trigger,
}: {
  action: ActionConfig
  activeContexts: ActiveContextsMap
  trigger: string
}) {
  const deps = activeContexts.get(action.context)
  if (!action.icon) return null

  const handleClick = () => {
    if (!deps) return
    dispatchActionWithDeps(action.id, deps, new CustomEvent(trigger, {detail: {actionId: action.id}}))
  }

  return (
    <MobileBottomNavButton
      label={action.description}
      icon={action.icon}
      onClick={handleClick}
      disabled={!deps}
    />
  )
}

function MobileBottomNavSurface() {
  const resolved = useActionRefItems(mobileBottomNavItemsFacet, ActionContextTypes.GLOBAL)
  const activeContexts = useActiveContextsState()

  if (resolved.length === 0) return null

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:hidden"
      style={{paddingBottom: 'env(safe-area-inset-bottom)'}}
      aria-label="Mobile navigation"
      data-block-interaction="ignore"
    >
      <div className="mx-auto flex h-16 max-w-md items-center justify-around">
        {resolved.map(({item, action}) =>
          action ? (
            <ActionRefBarButton
              key={item.id}
              action={action}
              activeContexts={activeContexts}
              trigger="mobile-bottom-nav-action"
            />
          ) : null,
        )}
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
