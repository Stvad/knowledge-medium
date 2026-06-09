import { useIsMobile } from '@/utils/react.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useActiveContextsState, type ActiveContextsMap } from '@/shortcuts/ActiveContexts.js'
import { actionRuntimeKey, getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { dispatchActionWithDeps } from '@/shortcuts/runAction.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { mobileBottomNavItemsFacet } from './facet.ts'
import { MobileBottomNavButton } from './Button.tsx'

function MobileBottomNavActionButton({
  action,
  activeContexts,
  disabled,
}: {
  action: ActionConfig
  activeContexts: ActiveContextsMap
  disabled: boolean
}) {
  const handleClick = () => {
    const deps = activeContexts.get(action.context)
    if (!deps) return
    // Route through the supplied-deps dispatch (resolveDeps validation +
    // canDispatch gate + error logging) rather than invoking the handler
    // directly. The button is disabled unless its context is active, so `deps`
    // is the active context's set; handing it in as supplied keeps the dispatch
    // path uniform without requiring the resolver to treat the context as
    // keyboard-active.
    dispatchActionWithDeps(
      action.id,
      deps,
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
  const actionsByKey = new Map(
    getEffectiveActions(runtime).map(action => [actionRuntimeKey(action), action]),
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
        {items.map(({id, actionId, context}) => {
          const action = actionsByKey.get(
            actionRuntimeKey({id: actionId, context: context ?? ActionContextTypes.GLOBAL}),
          )
          if (!action) return null
          return (
            <MobileBottomNavActionButton
              key={id}
              action={action}
              activeContexts={activeContexts}
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
