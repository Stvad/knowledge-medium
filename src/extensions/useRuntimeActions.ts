import { useEffect, useMemo } from 'react'
import { readRuntimeActionContexts, readRuntimeActions } from '@/extensions/runtimeActions.ts'
import { useAppRuntime } from '@/extensions/runtimeContext.ts'
import { actionManager as defaultActionManager, ActionManager } from '@/shortcuts/ActionManager.ts'

export function useRuntimeActions(actionManager: ActionManager = defaultActionManager): void {
  const runtime = useAppRuntime()
  const contexts = useMemo(() => readRuntimeActionContexts(runtime), [runtime])
  const actions = useMemo(() => readRuntimeActions(runtime), [runtime])

  useEffect(() => {
    actionManager.registerContexts(contexts)
    actionManager.registerActions(actions)
  }, [actionManager, actions, contexts])
}
