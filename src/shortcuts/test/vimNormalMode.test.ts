import { describe, expect, it } from 'vitest'
import { actionsFacet } from '@/extensions/core.ts'
import { readRuntimeActions } from '@/extensions/runtimeActions.ts'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.ts'
import { vimNormalModeActionsFacet } from '@/shortcuts/vimNormalMode.ts'

const noop = () => undefined

describe('vim normal mode actions facet', () => {
  it('keeps normal mode actions separate while exposing them in the runtime action surface', () => {
    const globalAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
      id: 'global.test',
      description: 'Global test action',
      context: ActionContextTypes.GLOBAL,
      handler: noop,
    }
    const normalModeAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
      id: 'normal.test',
      description: 'Normal mode test action',
      context: ActionContextTypes.NORMAL_MODE,
      handler: noop,
    }

    const runtime = resolveFacetRuntimeSync([
      actionsFacet.of(globalAction),
      vimNormalModeActionsFacet.of(normalModeAction),
    ])

    expect(runtime.read(actionsFacet)).toEqual([globalAction])
    expect(runtime.read(vimNormalModeActionsFacet)).toEqual([normalModeAction])
    expect(readRuntimeActions(runtime)).toEqual([globalAction, normalModeAction])
  })
})
