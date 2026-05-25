import { useEffect, useLayoutEffect, useRef } from 'react'
import type { FacetRuntime } from '@/extensions/facet.js'
import {
  type ActiveContextsMap,
  useActiveContextsDispatch,
  useActiveContextsState,
} from '@/shortcuts/ActiveContexts.js'
import { ActionContextTypes } from '@/shortcuts/types.js'
import type {
  BlockShortcutDependencies,
  CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { pickBlockDateAdapter } from './blockDateAdapter.ts'
import {
  createEditorReferenceDateAdapter,
  referenceDateAdapter,
} from './referenceDateAdapter.ts'
import {
  finishDateKeyboardScrub,
  installDateWheelScrubListeners,
  registerDateKeyboardScrubStartHandler,
  startDateKeyboardScrub,
  type KeyboardScrubTarget,
} from './dateScrubGesture.ts'
import { DATE_SCRUB_CONTEXT } from './dateScrubActions.ts'

interface KeyboardScrubActivationTarget extends KeyboardScrubTarget {
  uiStateBlock: BlockShortcutDependencies['uiStateBlock']
}

const resolveKeyboardScrubTarget = (
  active: ActiveContextsMap,
  runtime: FacetRuntime,
): KeyboardScrubActivationTarget | null => {
  const editDeps = active.get(ActionContextTypes.EDIT_MODE_CM) as
    CodeMirrorEditModeDependencies | undefined
  if (editDeps?.block && editDeps.editorView) {
    const blockAdapter = pickBlockDateAdapter(runtime, editDeps.block)
    if (blockAdapter && blockAdapter.id !== referenceDateAdapter.id) {
      return {block: editDeps.block, uiStateBlock: editDeps.uiStateBlock}
    }

    const editorAdapter = createEditorReferenceDateAdapter(editDeps.editorView)
    if (editorAdapter.canHandle(editDeps.block)) {
      return {block: editDeps.block, adapter: editorAdapter, uiStateBlock: editDeps.uiStateBlock}
    }
    return null
  }

  const normalDeps = active.get(ActionContextTypes.NORMAL_MODE) as
    BlockShortcutDependencies | undefined
  return normalDeps?.block
    ? {block: normalDeps.block, uiStateBlock: normalDeps.uiStateBlock}
    : null
}

export const DateKeyboardScrubController = () => {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()
  const {activate, deactivate} = useActiveContextsDispatch()
  const runtimeRef = useRef(runtime)
  const activeRef = useRef(active)

  useLayoutEffect(() => {
    runtimeRef.current = runtime
    activeRef.current = active
  }, [active, runtime])

  useEffect(() => {
    const stopWheelScrub = installDateWheelScrubListeners(() =>
      resolveKeyboardScrubTarget(activeRef.current, runtimeRef.current),
    )

    const stopStartRequests = registerDateKeyboardScrubStartHandler(() => {
      const target = resolveKeyboardScrubTarget(activeRef.current, runtimeRef.current)
      if (!target) return

      const started = startDateKeyboardScrub(target, {
        onEnd: () => deactivate(DATE_SCRUB_CONTEXT),
      })
      if (!started) return

      activate(DATE_SCRUB_CONTEXT, {uiStateBlock: target.uiStateBlock})
    })

    return () => {
      stopStartRequests()
      stopWheelScrub()
      finishDateKeyboardScrub(false)
    }
  }, [activate, deactivate])

  return null
}
