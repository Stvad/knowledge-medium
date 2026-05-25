import { useEffect, useLayoutEffect, useRef } from 'react'
import type { FacetRuntime } from '@/extensions/facet.js'
import {
  type ActiveContextsMap,
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
  installDateKeyboardScrubListeners,
  type KeyboardScrubTarget,
} from './dateScrubGesture.ts'

const resolveKeyboardScrubTarget = (
  active: ActiveContextsMap,
  runtime: FacetRuntime,
): KeyboardScrubTarget | null => {
  const editDeps = active.get(ActionContextTypes.EDIT_MODE_CM) as
    CodeMirrorEditModeDependencies | undefined
  if (editDeps?.block && editDeps.editorView) {
    const blockAdapter = pickBlockDateAdapter(runtime, editDeps.block)
    if (blockAdapter && blockAdapter.id !== referenceDateAdapter.id) {
      return {block: editDeps.block}
    }

    const editorAdapter = createEditorReferenceDateAdapter(editDeps.editorView)
    if (editorAdapter.canHandle(editDeps.block)) {
      return {block: editDeps.block, adapter: editorAdapter}
    }
    return null
  }

  const normalDeps = active.get(ActionContextTypes.NORMAL_MODE) as
    BlockShortcutDependencies | undefined
  return normalDeps?.block ? {block: normalDeps.block} : null
}

export const DateKeyboardScrubController = () => {
  const runtime = useAppRuntime()
  const active = useActiveContextsState()
  const runtimeRef = useRef(runtime)
  const activeRef = useRef(active)

  useLayoutEffect(() => {
    runtimeRef.current = runtime
    activeRef.current = active
  }, [active, runtime])

  useEffect(() => {
    return installDateKeyboardScrubListeners(() =>
      resolveKeyboardScrubTarget(activeRef.current, runtimeRef.current),
    )
  }, [])

  return null
}
