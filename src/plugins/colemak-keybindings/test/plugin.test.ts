import { describe, expect, it } from 'vitest'
import type { Repo } from '@/data/repo'
import { resolveAppRuntimeSync } from '@/extensions/resolveAppRuntime'
import { getBoundary } from '@/extensions/togglable'
import { ActionContextTypes, type ActionConfig, type ActionContextType } from '@/shortcuts/types'
import { keybindingOverridesFacet } from '@/shortcuts/keybindingOverrides'
import { applyKeybindingOverrides } from '@/shortcuts/applyKeybindingOverrides'
import { getDefaultActions } from '@/shortcuts/defaultShortcuts'
import { getVimNormalModeActions } from '@/plugins/vim-normal-mode/actions'
import { getSpatialNavigationActions } from '@/plugins/spatial-navigation/actions'
import {
  DATE_SCRUB_CONTEXT,
  DATE_SCRUB_DAY_BACKWARD_ACTION_ID,
  DATE_SCRUB_DAY_FORWARD_ACTION_ID,
  DATE_SCRUB_WEEK_BACKWARD_ACTION_ID,
  DATE_SCRUB_WEEK_FORWARD_ACTION_ID,
  dateScrubActions,
} from '@/plugins/daily-notes/dateScrubActions'
import {
  COLEMAK_KEYBINDINGS_PLUGIN_ID,
  colemakKeybindingsPlugin,
} from '../index'

const fakeRepo = {} as Repo

const actionUniverse = (): readonly ActionConfig[] => [
  ...getDefaultActions({repo: fakeRepo}),
  ...getVimNormalModeActions({repo: fakeRepo}),
  ...getSpatialNavigationActions(),
  ...dateScrubActions,
] as readonly ActionConfig[]

const bindingFor = (
  actions: readonly ActionConfig[],
  context: ActionContextType,
  id: string,
): NonNullable<ActionConfig['defaultBinding']>['keys'] => {
  const action = actions.find(candidate => candidate.context === context && candidate.id === id)
  if (!action) throw new Error(`Missing action ${context}:${id}`)
  if (!action.defaultBinding) throw new Error(`Action ${context}:${id} has no binding`)
  return action.defaultBinding.keys
}

describe('colemakKeybindingsPlugin', () => {
  it('is a disabled-by-default system plugin', () => {
    const boundary = getBoundary(colemakKeybindingsPlugin)

    expect(boundary).toMatchObject({
      id: COLEMAK_KEYBINDINGS_PLUGIN_ID,
      name: 'Colemak movement keybindings',
      defaultEnabled: false,
      kind: 'system',
    })
  })

  it('contributes no keybinding overrides until enabled', () => {
    const runtime = resolveAppRuntimeSync(
      [colemakKeybindingsPlugin],
      {overrides: new Map()},
    )

    expect(runtime.read(keybindingOverridesFacet)).toEqual([])
  })

  it('leaves source action defaults on QWERTY movement bindings', () => {
    const actions = actionUniverse()

    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_down')).toEqual(['ArrowDown', 'j'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_up')).toEqual(['ArrowUp', 'k'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_left')).toEqual(['ArrowLeft', 'h'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_right')).toEqual(['ArrowRight', 'l'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'extend_selection_up')).toEqual(['Shift+ArrowUp', 'Shift+k'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'extend_selection_down')).toEqual(['Shift+ArrowDown', 'Shift+j'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'normal.move_block_up')).toEqual(['$mod+Shift+ArrowUp', '$mod+Shift+k'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'normal.move_block_down')).toEqual(['$mod+Shift+ArrowDown', '$mod+Shift+j'])

    expect(bindingFor(actions, ActionContextTypes.EDIT_MODE_CM, 'move_block_up_cm')).toEqual(['$mod+Shift+ArrowUp', '$mod+Shift+k'])
    expect(bindingFor(actions, ActionContextTypes.EDIT_MODE_CM, 'move_block_down_cm')).toEqual(['$mod+Shift+ArrowDown', '$mod+Shift+j'])

    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.extend_selection_up')).toEqual(['ArrowUp', 'k', 'Shift+k', 'Shift+ArrowUp'])
    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.extend_selection_down')).toEqual(['ArrowDown', 'j', 'Shift+j', 'Shift+ArrowDown'])
    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.move_block_up')).toEqual(['$mod+Shift+ArrowUp', '$mod+Shift+k'])
    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.move_block_down')).toEqual(['$mod+Shift+ArrowDown', '$mod+Shift+j'])

    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_DAY_FORWARD_ACTION_ID)).toEqual(['ArrowUp', 'k'])
    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_DAY_BACKWARD_ACTION_ID)).toEqual(['ArrowDown', 'j'])
    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_WEEK_FORWARD_ACTION_ID)).toEqual(['ArrowRight', 'l'])
    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_WEEK_BACKWARD_ACTION_ID)).toEqual(['ArrowLeft', 'h'])
  })

  it('restores the Colemak movement bindings when enabled', () => {
    const runtime = resolveAppRuntimeSync(
      [colemakKeybindingsPlugin],
      {overrides: new Map([[COLEMAK_KEYBINDINGS_PLUGIN_ID, true]])},
    )
    const actions = applyKeybindingOverrides(
      actionUniverse(),
      runtime.read(keybindingOverridesFacet),
    )

    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_down')).toEqual(['ArrowDown', 'k'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_up')).toEqual(['ArrowUp', 'h'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_left')).toEqual(['ArrowLeft', 'j'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'move_right')).toEqual(['ArrowRight', 'l'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'extend_selection_up')).toEqual(['Shift+ArrowUp', 'Shift+h'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'extend_selection_down')).toEqual(['Shift+ArrowDown', 'Shift+k'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'normal.move_block_up')).toEqual(['$mod+Shift+ArrowUp', '$mod+Shift+h'])
    expect(bindingFor(actions, ActionContextTypes.NORMAL_MODE, 'normal.move_block_down')).toEqual(['$mod+Shift+ArrowDown', '$mod+Shift+k'])

    expect(bindingFor(actions, ActionContextTypes.EDIT_MODE_CM, 'move_block_up_cm')).toEqual(['$mod+Shift+ArrowUp', '$mod+Shift+h'])
    expect(bindingFor(actions, ActionContextTypes.EDIT_MODE_CM, 'move_block_down_cm')).toEqual(['$mod+Shift+ArrowDown', '$mod+Shift+k'])

    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.extend_selection_up')).toEqual(['ArrowUp', 'h', 'Shift+h', 'Shift+ArrowUp'])
    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.extend_selection_down')).toEqual(['ArrowDown', 'k', 'Shift+k', 'Shift+ArrowDown'])
    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.move_block_up')).toEqual(['$mod+Shift+ArrowUp', '$mod+Shift+h'])
    expect(bindingFor(actions, ActionContextTypes.MULTI_SELECT_MODE, 'multi_select.move_block_down')).toEqual(['$mod+Shift+ArrowDown', '$mod+Shift+k'])

    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_DAY_FORWARD_ACTION_ID)).toEqual(['ArrowUp', 'h'])
    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_DAY_BACKWARD_ACTION_ID)).toEqual(['ArrowDown', 'k'])
    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_WEEK_FORWARD_ACTION_ID)).toEqual(['ArrowRight', 'l'])
    expect(bindingFor(actions, DATE_SCRUB_CONTEXT, DATE_SCRUB_WEEK_BACKWARD_ACTION_ID)).toEqual(['ArrowLeft', 'j'])
  })
})
