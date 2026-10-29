import { useRepo } from '@/context/repo.js'
import { useIsReadOnly } from '@/hooks/useIsReadOnly.js'
import { useActiveContextsState, type ActiveContextsMap } from '@/shortcuts/ActiveContexts.js'
import { useActionRefItems } from '@/shortcuts/actionRefItems.js'
import { dispatchActionWithDeps } from '@/shortcuts/runAction.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import { usePointerCoarse } from '@/utils/react.js'
import { POINTER_COARSE_QUERY } from '@/utils/viewport.js'
import { PANEL_BOTTOM_CLEARANCE } from '@/utils/panelClearance.js'
import { touchSelectionToolbarItemsFacet } from './facet.ts'

/** A hold on read-mode content belongs to the hold recognizer, so iOS must
 *  not start its own text selection or callout there. Same gate as the
 *  recognizer's `isEnabled`: a coarse pointer, a writable workspace, and a
 *  block that isn't being edited, whose editor keeps native selection. */
const HOLD_STYLES = `
@media ${POINTER_COARSE_QUERY} {
  .block-content:not(:has(.cm-editor)) {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
  }
}
`

function ToolbarButton({
  action,
  activeContexts,
}: {
  action: ActionConfig
  activeContexts: ActiveContextsMap
}) {
  const deps = activeContexts.get(action.context)
  const Icon = action.icon
  if (!Icon) return null

  // Dispatched with the active context's deps, as the bottom nav does, so
  // the dispatch path validates them and runs canDispatch.
  const handleClick = () => {
    if (!deps) return
    dispatchActionWithDeps(
      action.id,
      deps,
      new CustomEvent('touch-selection-toolbar-action', {detail: {actionId: action.id}}),
    )
  }

  return (
    <button
      type="button"
      className="flex h-14 min-w-0 flex-1 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-accent active:text-foreground disabled:pointer-events-none disabled:opacity-35"
      onClick={handleClick}
      disabled={!deps}
      title={action.description}
      aria-label={action.description}
    >
      <Icon className="h-6 w-6 stroke-[1.6]"/>
    </button>
  )
}

/** The toolbar's height: its h-16 row over the safe-area inset. */
const TOOLBAR_CLEARANCE = 'calc(env(safe-area-inset-bottom) + 4rem)'

/** The movement bar shown while blocks are selected on a touch-primary
 *  device. Fixed to the bottom at the bottom nav's height and above it, so
 *  on a phone it takes the nav's place (and its clearance) for as long as
 *  the selection lasts; from md up, where there is no nav, it reserves its
 *  own clearance in the panes. No keyboard is up while selecting, so the
 *  safe-area inset is the only offset it needs. Hidden while a block or
 *  property is edited, when the keyboard toolbar owns the bottom of the
 *  screen. */
function SelectionToolbar() {
  const activeContexts = useActiveContextsState()
  const resolved = useActionRefItems(touchSelectionToolbarItemsFacet, ActionContextTypes.MULTI_SELECT_MODE)
  const pointerCoarse = usePointerCoarse()
  const selecting = activeContexts.has(ActionContextTypes.MULTI_SELECT_MODE)
  const editing =
    activeContexts.has(ActionContextTypes.EDIT_MODE_CM) ||
    activeContexts.has(ActionContextTypes.PROPERTY_EDITING)

  if (!pointerCoarse || !selecting || editing) return null

  return (
    <>
      <style>{`:root { ${PANEL_BOTTOM_CLEARANCE}: ${TOOLBAR_CLEARANCE}; }`}</style>
      <div
        role="toolbar"
        aria-label="Selected blocks"
        className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background px-2"
        style={{paddingBottom: 'env(safe-area-inset-bottom)'}}
        data-block-interaction="ignore"
      >
        <div className="mx-auto flex h-16 max-w-md items-center justify-around">
          {resolved.map(({item, action}) =>
            action ? <ToolbarButton key={item.id} action={action} activeContexts={activeContexts}/> : null,
          )}
        </div>
      </div>
    </>
  )
}

/** App mount for touch selection: the read-mode hold styles and the
 *  selection toolbar. */
export function TouchSelectionLayer() {
  const readOnly = useIsReadOnly(useRepo())
  return (
    <>
      {!readOnly && <style>{HOLD_STYLES}</style>}
      <SelectionToolbar/>
    </>
  )
}
