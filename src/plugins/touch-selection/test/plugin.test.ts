// @vitest-environment happy-dom
// (only for `defaultActionsExtension`, which installs a `window` metrics hook)

import { describe, expect, it } from 'vitest'
import type { Repo } from '@/data/repo.js'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { defaultActionsExtension } from '@/shortcuts/defaultShortcuts.js'
import { actionRuntimeKey, getEffectiveActions } from '@/shortcuts/effectiveActions.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'
import type { PointerBindingSpec } from '@/shortcuts/canonicalizeChord.js'
import { moveBlocksPlugin } from '@/plugins/move-blocks'
import { vimNormalModeInteractionExtension } from '@/plugins/vim-normal-mode'
import { plainOutlinerPlugin } from '@/plugins/plain-outliner'
import { ENTER_BLOCK_EDIT_MODE_ACTION_ID } from '@/plugins/plain-outliner/clickToEditAction.js'
import { touchSelectionPlugin, touchSelectionToolbarItemsFacet } from '../index.ts'
import { toggleTappedBlockAction } from '../actions.ts'

const binds = (matches: (spec: PointerBindingSpec) => boolean) => (action: ActionConfig): boolean => {
  const spec = action.pointerBinding
  if (!spec) return false
  const specs: readonly PointerBindingSpec[] = Array.isArray(spec) ? spec : [spec]
  return specs.some(matches)
}
const bindsTouchTap = binds(spec => spec.kind === 'touch')
const bindsPlainClick = binds(spec => spec.kind === 'mouse' && (spec.mods ?? []).length === 0 && (spec.phase ?? 'click') === 'click')

describe('touchSelectionPlugin', () => {
  it('orders its tap ahead of vim\'s tap-to-edit, so a tap while selecting toggles', () => {
    // Both are block-pointer candidates for a tap, which `resolve` keeps in
    // effective-action order; the toggle declines when nothing is selected.
    const runtime = resolveFacetRuntimeSync([vimNormalModeInteractionExtension, touchSelectionPlugin])
    const tapActions = getEffectiveActions(runtime).filter(bindsTouchTap)

    expect(tapActions.length).toBeGreaterThan(1)
    expect(tapActions[0]?.id).toBe(toggleTappedBlockAction.id)
  })

  it('orders its click ahead of click-to-edit, so a slow tap or a tap beside the text while selecting toggles', () => {
    const runtime = resolveFacetRuntimeSync([plainOutlinerPlugin, touchSelectionPlugin])
    const clickActions = getEffectiveActions(runtime).filter(bindsPlainClick)

    expect(clickActions.map(action => action.id)).toContain(ENTER_BLOCK_EDIT_MODE_ACTION_ID)
    expect(clickActions[0]?.id).toBe(toggleTappedBlockAction.id)
  })

  it('every toolbar item resolves to an action with an icon on a default install', () => {
    const runtime = resolveFacetRuntimeSync([
      defaultActionsExtension({repo: {} as Repo}),
      moveBlocksPlugin,
      touchSelectionPlugin,
    ])
    const actions = new Map(getEffectiveActions(runtime).map(action => [actionRuntimeKey(action), action]))
    const unresolved = runtime.read(touchSelectionToolbarItemsFacet)
      .filter(item => !actions.get(actionRuntimeKey({
        id: item.actionId,
        context: item.context ?? ActionContextTypes.MULTI_SELECT_MODE,
      }))?.icon)
      .map(item => item.id)

    expect(unresolved).toEqual([])
  })
})
