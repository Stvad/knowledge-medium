import { useMemo, type MouseEvent } from 'react'
import type { Block } from '@/data/block'
import { Button } from '@/components/ui/button.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { useUIStateBlock } from '@/data/globalState.js'
import { dispatchActionWithDeps } from '@/shortcuts/runAction.js'
import { getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import {
  ActionContextTypes,
  type ActionConfig,
  type ActionIcon,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.js'

interface GroupHeaderActionButtonProps {
  actionId: string
  /** Blocks to pass as `selectedBlocks` to the resolved action. */
  sourceBlocks: readonly Block[]
  /** Falls back to the action's `icon` when omitted. */
  icon?: ActionIcon
  /** Falls back to the action's `description` when omitted. */
  label?: string
  /** Merged into the CustomEvent `detail` passed to the handler.
   *  Lets one action serve multiple buttons by carrying which
   *  variant the user picked. */
  triggerDetail?: Record<string, unknown>
}

/** Renders a single grouped-backlinks header button that invokes a
 *  registered `MULTI_SELECT_MODE` action with the group's blocks.
 *
 *  Resolves the action from the runtime at render time rather than
 *  at facet-contribution time so contributions don't have to be
 *  ordered with the action registration. If the action isn't
 *  registered, or its `isVisible` predicate rejects the synthesized
 *  deps, the button renders nothing — same affordance-hiding
 *  contract as the command palette. */
export const GroupHeaderActionButton = ({
  actionId,
  sourceBlocks,
  icon: iconOverride,
  label: labelOverride,
  triggerDetail,
}: GroupHeaderActionButtonProps) => {
  const runtime = useAppRuntime()
  const uiStateBlock = useUIStateBlock()

  const action = useMemo(
    () => {
      const effective = getEffectiveActions(runtime)
      return effective.find(
        candidate =>
          candidate.id === actionId &&
          candidate.context === ActionContextTypes.MULTI_SELECT_MODE,
      ) as
        | ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>
        | undefined
    },
    [runtime, actionId],
  )

  if (!action) return null

  const deps: MultiSelectModeDependencies = {
    selectedBlocks: sourceBlocks as Block[],
    anchorBlock: null,
    uiStateBlock,
  }
  if (action.isVisible && !action.isVisible(deps)) return null

  const Icon = iconOverride ?? action.icon
  const label = labelOverride ?? action.description

  const handleClick = (event: MouseEvent<HTMLButtonElement>): void => {
    event.stopPropagation()
    const trigger = new CustomEvent(`group-header:${actionId}`, {
      detail: triggerDetail,
    })
    // Route through the supplied-deps dispatch (resolveDeps validation +
    // canDispatch gate + error logging) rather than invoking the handler
    // directly. The button only renders once `isVisible` passed and the
    // synthesized MULTI_SELECT_MODE deps validate, so the action resolves; the
    // returned boolean is unused — an unclaimed click is a no-op, there's no
    // fallback to fall through to.
    dispatchActionWithDeps(actionId, deps, trigger)
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
      title={label}
      aria-label={label}
      onClick={handleClick}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
    </Button>
  )
}
