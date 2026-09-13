var e=`import { ChangeScope } from '@/data/api/index.js'
import { isCollapsedProp, topLevelBlockIdProp } from '@/data/properties.js'
import { actionsFacet } from '@/extensions/core.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'

// Toggle collapse on every visible descendant of the top-level block.
// Demonstrates a single action contribution with a default keybinding.
//
// NORMAL_MODE handlers receive the panel's ui-state block (panel-bound)
// directly as uiStateBlock, so the per-panel topLevelBlockId is reachable
// without walking into ui-state/panels.
//
// Note on key syntax: this app uses tinykeys. Use '$mod' for the
// platform-primary modifier (Cmd on macOS, Ctrl elsewhere); spell
// other modifiers as 'Control', 'Alt', 'Shift'.
const foldAllAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'user.fold-all',
  description: 'Fold/unfold every block in the current view',
  context: ActionContextTypes.NORMAL_MODE,
  // $mod+Shift+u — $mod+Shift+f is taken by Find-and-replace (global), so
  // pressing it would fire both. Pick a free chord for the demo.
  defaultBinding: { keys: '$mod+Shift+u' },
  handler: async ({ uiStateBlock }) => {
    const topLevelId = uiStateBlock.peekProperty(topLevelBlockIdProp)
    if (!topLevelId) return

    const repo = uiStateBlock.repo
    // repo.query.subtree hydrates the cache for every visited row, so per-block
    // peekProperty reads below are sync. The root is included in the subtree
    // and filtered out at the consumer boundary so the subtree query stays
    // includeRoot=true (the only shape we keep going forward).
    const subtreeWithRoot = await repo.query.subtree({id: topLevelId, hidePropertyChildren: true}).load()
    const subtree = subtreeWithRoot.filter(d => d.id !== topLevelId)
    // If anything is uncollapsed, collapse all; otherwise expand all.
    const anyExpanded = subtree.some(
      data => repo.block(data.id).peekProperty(isCollapsedProp) !== true,
    )
    await repo.tx(async tx => {
      for (const data of subtree) {
        await tx.setProperty(data.id, isCollapsedProp, anyExpanded)
      }
    }, { scope: ChangeScope.BlockDefault, description: 'fold all' })
  },
}

export default actionsFacet.of(foldAllAction)
`;export{e as default};
//# sourceMappingURL=foldAllAction.js.map