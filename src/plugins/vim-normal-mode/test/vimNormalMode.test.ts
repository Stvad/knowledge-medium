import { describe, expect, it } from 'vitest'
import { actionsFacet } from '@/extensions/core.js'
import { readRuntimeActions } from '@/extensions/runtimeActions.js'
import { resolveFacetRuntimeSync } from '@/extensions/facet.js'
import { ActionConfig, ActionContextTypes } from '@/shortcuts/types.js'
import type { Repo } from '@/data/repo'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions'

const noop = () => undefined

describe('vim normal mode actions in the unified action surface', () => {
  it('owns the baseline hierarchical up and down movement bindings', () => {
    const actions = getVimNormalModeActions({repo: {} as Repo})

    expect(actions.find(action => action.id === 'move_down')?.defaultBinding?.keys).toEqual(['ArrowDown', 'k'])
    expect(actions.find(action => action.id === 'move_up')?.defaultBinding?.keys).toEqual(['ArrowUp', 'h'])
  })

  it('exposes normal-mode actions through the shared actions facet', () => {
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
      actionsFacet.of(normalModeAction as ActionConfig),
    ])

    expect(runtime.read(actionsFacet)).toEqual([globalAction, normalModeAction])
    expect(readRuntimeActions(runtime)).toEqual([globalAction, normalModeAction])
  })
})
