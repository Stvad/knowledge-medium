import { useEffect } from 'react'
import { actionsFacet } from '@/extensions/core.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { actionManager as defaultActionManager, ActionManager } from '@/shortcuts/ActionManager.ts'

export function useRuntimeActions(actionManager: ActionManager = defaultActionManager): void {
  const runtime = useAppRuntime()
  const actions = runtime.read(actionsFacet)

  useEffect(() => {
    actionManager.registerActions(actions)
  }, [actionManager, actions])
}
