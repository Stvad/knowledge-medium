import type {
  ActiveContextEntry,
  ActiveContextsMap,
} from '@/shortcuts/ActiveContexts.tsx'
import type {
  ActionContextType,
  ActionTrigger,
} from '@/shortcuts/types.ts'

const panelIdFromEventTarget = (target: EventTarget | null): string | null => {
  if (typeof Element === 'undefined') return null
  const element = target instanceof Element
    ? target
    : typeof Node !== 'undefined' && target instanceof Node
      ? target.parentElement
      : null
  return element?.closest<HTMLElement>('[data-panel-id]')?.dataset.panelId ?? null
}

export const selectActiveDependencies = (
  active: ActiveContextsMap,
  context: ActionContextType,
  trigger?: ActionTrigger,
): ActiveContextEntry['dependencies'] | undefined => {
  const entries = active.get(context)
  if (!entries?.length) return undefined

  const targetPanelId = typeof Event !== 'undefined' && trigger instanceof Event
    ? panelIdFromEventTarget(trigger.target)
    : null
  if (targetPanelId) {
    const scoped = [...entries]
      .reverse()
      .find(entry => {
        const maybeDeps = entry.dependencies as {uiStateBlock?: {id?: unknown}}
        return maybeDeps.uiStateBlock?.id === targetPanelId
      })
    if (scoped) return scoped.dependencies
  }

  return entries.at(-1)?.dependencies
}
