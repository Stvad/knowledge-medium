import { KeyboardOff, Maximize2, PanelRightOpen, Plus, Redo2, Scissors, Settings, Undo2, ZoomIn } from 'lucide-react'
import { defaultActionContextConfigs } from './defaultContexts.ts'
import {
  ActionContextTypes,
  BaseShortcutDependencies,
  ActionConfig,
  BlockShortcutDependencies,
  MultiSelectModeDependencies,
  CodeMirrorEditModeDependencies,
  PropertyEditingDependencies,
  ActionTrigger,
} from './types'
import { Block } from '@/data/block'
import { Repo } from '@/data/repo'
import {
  merge as mergeMutator,
  setContent as setContentMutator,
  createChild as createChildMutator,
} from '@/data/mutators'
import { ChangeScope } from '@/data/api'
import {
  nextVisibleBlock,
  previousVisibleBlock,
  getRootBlock,
  blockAfterSubtreeRemoval,
} from '@/utils/selection.js'
import { importState } from '@/utils/state.js'
import { withMoveTransition } from '@/utils/viewTransition.js'
import {
  focusBlock,
  isCollapsedProp,
  topLevelBlockIdProp,
  editorSelection,
  setIsEditing,
} from '@/data/properties.js'
import { structuralEditPolicyForBlock } from '@/data/structuralEditPolicy.js'
import { insertExampleExtensionsUnder } from '@/extensions/exampleExtensions.js'
import { selectionStateProp } from '@/data/properties'
import { applyToAllBlocksInSelection, makeMultiSelect } from './utils'
import {
  BlockAction,
  bindBlockActionContext,
  createSharedBlockActions,
  extendSelectionDown,
  extendSelectionUp,
} from './blockActions.ts'
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import {
  isOnFirstVisualLine,
  isOnLastVisualLine,
  getCaretRect,
  cursorIsAtEnd,
  cursorIsAtStart,
} from '@/utils/codemirror.js'
import { cutBlockIdsToClipboard, copySelectedBlocksToClipboard } from '@/utils/copy.js'
import {
  deleteBlockThroughUi,
  deleteBlocksThroughUi,
  ensureDeletableThroughUi,
} from '@/utils/deleteBlockThroughUi.js'
import { pasteOrMove, type PasteOrMoveResult } from '@/paste/pasteOrMove.js'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.js'
import { AppExtension } from '@/facets/facet.js'
import { refreshAppRuntime } from '@/facets/runtimeEvents.js'
import { systemToggle } from '@/facets/togglable.js'
import { getLayoutSessionBlock, getUserPrefsBlock } from '@/data/stateBlocks.js'
import { isMobileViewport } from '@/utils/viewport.js'
import {
  navigate,
  navigateFromGlobalCommand,
  resolveActivePanelRow,
} from '@/utils/navigation.js'
import {
  deletePanelRow,
  panelBlockId,
  togglePanelMaximized,
} from '@/utils/panelLayoutProjection.js'
import { ensureMetricsConsoleHook } from '@/data/metricsConsoleHook.js'
import { showProgress } from '@/utils/toast.js'
import {
  chooseRawSqliteExportFile,
  downloadBlob,
  exportRawSqliteDb,
  exportRawSqliteDbToFile,
  importRawSqliteDb,
  rawSqliteDbExportFilename,
} from '@/utils/exportSqliteDb.js'
import { openDialog } from '@/utils/dialogs.js'
import { WipeLocalDataDialog } from '@/shortcuts/WipeLocalDataDialog.js'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.js'
import { focusPropertyRow } from '@/utils/propertyNavigation.js'
import { reloadInSafeMode } from '@/utils/safeMode.js'
import { panelRenderScopeId } from '@/utils/renderScope.js'

const splitCodeMirrorBlockAtCursor = async (
  block: Block,
  editorView: EditorView,
): Promise<Block> => {
  const doc = editorView.state.doc
  const cursorPos = editorView.state.selection.main.head

  const beforeCursor = doc.sliceString(0, cursorPos)
  const afterCursor = doc.sliceString(cursorPos)
  const repo = block.repo

  // Push the suffix into the editor synchronously so its debounced
  // pushChange re-arms with the post-split text. Without this the
  // pending debounce would later flush the pre-split full content
  // and clobber the suffix that core.split wrote to SQL.
  editorView.dispatch({
    changes: {from: 0, to: doc.length, insert: afterCursor},
    selection: EditorSelection.cursor(0),
  })

  // core.split creates a new sibling BEFORE self with before-text, and
  // leaves self as the after-text block. Pass the live before/after
  // strings — the mutator does NOT slice persisted content, since a
  // debounced editor can leave SQL stale.
  await repo.mutate.split({
    id: block.id,
    before: beforeCursor,
    after: afterCursor,
  })
  return block
}

/**
 * Mid-text split when the edited block is the *scope root* (a backlink
 * entry, embed, or zoomed panel root). `core.split` would push the
 * before-cursor text into a preceding sibling — which lives outside the
 * visible surface, silently burying the first half (the same class as
 * the "invisible block" bug for `o`/`O`). Instead the root keeps the
 * before-text and the continuation becomes its first child, mirroring
 * the reading order (root = first half, child = the rest).
 *
 * Returns the new child's id.
 */
const splitScopeRootIntoFirstChild = async (
  block: Block,
  editorView: EditorView,
): Promise<string> => {
  const doc = editorView.state.doc
  const cursorPos = editorView.state.selection.main.head
  const beforeCursor = doc.sliceString(0, cursorPos)
  const afterCursor = doc.sliceString(cursorPos)
  const repo = block.repo

  // Re-arm the editor (and its debounced pushChange) with the prefix that
  // stays in the root, so a later flush can't clobber the SQL we write
  // below — same precaution as splitCodeMirrorBlockAtCursor.
  editorView.dispatch({
    changes: {from: 0, to: doc.length, insert: beforeCursor},
    selection: EditorSelection.cursor(beforeCursor.length),
  })

  return repo.tx(async tx => {
    await tx.run(setContentMutator, {id: block.id, content: beforeCursor})
    return tx.run(createChildMutator, {
      parentId: block.id,
      content: afterCursor,
      position: {kind: 'first'},
      revealParent: true,
    })
  }, {scope: ChangeScope.BlockDefault, description: 'split scope root into first child'})
}

export const CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID = 'create_node_in_active_panel'
export const OPEN_PREFERENCES_ACTION_ID = 'open_preferences'
export const RELOAD_IN_SAFE_MODE_ACTION_ID = 'reload_in_safe_mode'

const createNodeInActivePanelFromGlobalContext = async (
  uiStateBlock: Block,
): Promise<void> => {
  const repo = uiStateBlock.repo
  if (repo.isReadOnly) return

  const layoutSessionBlock = await getLayoutSessionBlock(uiStateBlock, repo.activeLayoutSessionId)
  // Shared with the navigation resolver rather than re-derived: this CREATES a
  // block in the pane it picks, and the copy that used to live here indexed
  // raw row order, so a maximized pane meant the new node landed in a page the
  // user could not see.
  const activePanelRow = await resolveActivePanelRow(layoutSessionBlock)
  if (!activePanelRow) return

  const activeTopLevelBlockId = panelBlockId(activePanelRow)
  if (!activeTopLevelBlockId) return

  const newId = await repo.mutate.createChild({
    parentId: activeTopLevelBlockId,
    position: {kind: 'last'},
  })
  await focusBlock(repo.block(activePanelRow.id), newId, {
    edit: true,
    renderScopeId: panelRenderScopeId(activePanelRow.id, activeTopLevelBlockId),
  })
}

export function getDefaultActionGroups({repo}: { repo: Repo }) {
  // Idempotent metrics console hook — surfaces
  // `__omniliner.metrics.print()` / `.reset()` / `.snapshot()` and
  // `__omniliner.repo` for ad-hoc cold-start investigation.
  ensureMetricsConsoleHook(repo)

  const {
    indentBlock,
    outdentBlock,
    moveBlockUp,
    moveBlockDown,
    deleteBlock,
    togglePropertiesDisplay,
    toggleBlockCollapse,
    extendSelectionUp: extendSelectionUpBlock,
    extendSelectionDown: extendSelectionDownBlock,
    copyBlock,
    copyBlockRef,
    copyBlockEmbed,
    copyBlockContent,
    copyBlockLink,
  } = createSharedBlockActions({repo})

  const indentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock)
  const outdentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, outdentBlock)
  const moveBlockUpAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockUp)
  const moveBlockDownAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockDown)
  const deleteBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, deleteBlock)
  const togglePropertiesDisplayAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, togglePropertiesDisplay)
  const toggleBlockCollapseAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleBlockCollapse)
  const extendSelectionUpAction = {
    ...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionUpBlock),
    defaultBinding: {
      ...extendSelectionUpBlock.defaultBinding,
      keys: ['Shift+ArrowUp', 'Shift+k'],
    },
  }
  const extendSelectionDownAction = {
    ...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionDownBlock),
    defaultBinding: {
      ...extendSelectionDownBlock.defaultBinding,
      keys: ['Shift+ArrowDown', 'Shift+j'],
    },
  }
  const copyBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlock)
  const copyBlockRefAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockRef)
  const copyBlockEmbedAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockEmbed)
  const copyBlockContentAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockContent)
  const copyBlockLinkAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockLink)

  // Block-bound actions that operate on the focused/edited block in a
  // panel. Declared as BlockActions and bound below to both NORMAL_MODE
  // and EDIT_MODE_CM — in either context `block` is the active block
  // and `uiStateBlock` is the panel block (panel-bound).
  const zoomInBlock: BlockAction = {
    id: 'zoom_in',
    description: 'Zoom into focused block',
    icon: ZoomIn,
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      // Through navigate() so zoom is observable/interceptable via
      // navigationVerb; target 'panel' swaps this panel's content (the swap
      // still wraps in withMoveTransition inside navigateInPanel) and marks this
      // panel active (it's the one being interacted with) — a benign addition
      // over the old direct navigateInPanel.
      await navigate(repo, {target: 'panel', panelId: uiStateBlock.id, blockId: block.id, origin: 'zoom'})
    },
    defaultBinding: {
      keys: '$mod+.',
    },
  }

  const zoomOutBlock: BlockAction = {
    id: 'zoom_out',
    description: 'Zoom out to parent of current view',
    handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
      const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
      if (!topLevelBlockId) return

      await repo.load(topLevelBlockId, {ancestors: true})
      const parent = repo.block(topLevelBlockId).parent
      if (!parent) return

      await navigate(repo, {target: 'panel', panelId: uiStateBlock.id, blockId: parent.id, origin: 'zoom'})
    },
    defaultBinding: {
      keys: '$mod+,',
    },
  }

  const openFocusedInPanelBlock: BlockAction = {
    id: 'open_focused_in_panel',
    description: 'Open focused block in a side panel',
    icon: PanelRightOpen,
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      navigate(repo, {
        blockId: block.id,
        target: 'new-panel',
        sourcePanelId: uiStateBlock.id,
        origin: 'open-in-panel',
      })
    },
    defaultBinding: {
      // event.key for shift+. is '>' on US layout, but event.code stays
      // 'Period' regardless — code-form keeps the binding correct under
      // any layout where the user can press the shifted period.
      keys: '$mod+Shift+Period',
    },
  }

  const closeCurrentPanelBlock: BlockAction = {
    id: 'close_current_panel',
    description: 'Close current panel',
    handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
      await deletePanelRow(repo, uiStateBlock.id)
    },
    defaultBinding: {
      keys: 'Control+w',
      eventOptions: {preventDefault: true},
    },
  }

  const toggleMaximizePanelBlock: BlockAction = {
    id: 'toggle_maximize_panel',
    description: 'Maximize / restore current panel',
    icon: Maximize2,
    handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
      // uiStateBlock IS the panel row in panel contexts. The viewport read
      // stays with the caller (see `maximizeWouldHideSomething`).
      await togglePanelMaximized(repo, uiStateBlock.id, {canRenderSplit: !isMobileViewport()})
    },
    defaultBinding: {
      keys: '$mod+Shift+Backslash',
      eventOptions: {preventDefault: true},
    },
  }

  const insertExampleExtensionsBlock: BlockAction = {
    id: 'insert_example_extensions',
    description: 'Insert example extensions under current block',
    handler: async ({block, uiStateBlock, renderScopeId}: BlockShortcutDependencies) => {
      const created = await insertExampleExtensionsUnder(block)
      if (created[0]) await focusBlock(uiStateBlock, created[0].id, {renderScopeId})
    },
  }

  /** Normal-mode single-block counterpart to `cut_selected_blocks`: marks
   *  just the focused block as a pending move — see that action's doc for
   *  the full mechanics. `$mod+x` is also bound in MULTI_SELECT_MODE
   *  (`cut_selected_blocks`); the two never race since only one context is
   *  active at a time. */
  const cutBlock: BlockAction = {
    id: 'cut_block',
    description: 'Cut block (mark for move)',
    icon: Scissors,
    handler: async ({block}: BlockShortcutDependencies) => {
      await cutBlockIdsToClipboard([block.id], repo)
    },
    defaultBinding: {
      keys: '$mod+x',
      eventOptions: {preventDefault: true},
    },
  }

  const normalModeActions: ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] = [
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, zoomInBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, zoomOutBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, openFocusedInPanelBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, closeCurrentPanelBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleMaximizePanelBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, insertExampleExtensionsBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, cutBlock),
    copyBlockAction,
    copyBlockRefAction,
    copyBlockEmbedAction,
    copyBlockContentAction,
    copyBlockLinkAction,
    // Promoted out of the vim plugin, like the copy actions above it: an action
    // has to be IN THE REGISTRY to be dispatchable at all, and the block/swipe
    // menu and command palette dispatch by id with supplied deps rather than
    // through an active keyboard context. Defined only by vim (an opt-in
    // plugin), `delete_block` was absent on a default install, so the menu's
    // Delete button logged "not registered" and did nothing —
    // `DEFAULT_QUICK_ACTION_ITEMS` names exactly these three.
    //
    // They live in this group, inside `system:default-actions`, so turning that
    // toggle off takes them with it. Deliberate: everything roots in a toggle.
    // The keys still only fire in NORMAL_MODE, which only the vim plugin
    // activates.
    {...deleteBlockAction, defaultBinding: {keys: ['Delete', 'Backspace', 'd d']}},
    togglePropertiesDisplayAction,
    toggleBlockCollapseAction,
  ]

  // CodeMirror versions of move actions
  const moveBlockUpCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockUp),
    id: 'move_block_up_cm',
    description: 'Move block up',
  }

  const moveBlockDownCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockDown),
    id: 'move_block_down_cm',
    description: 'Move block down',
  }

  const globalActions: ActionConfig<typeof ActionContextTypes.GLOBAL>[] = [
    {
      id: 'undo',
      description: 'Undo',
      context: ActionContextTypes.GLOBAL,
      icon: Undo2,
      handler: async () => { await repo.undo() },
      defaultBinding: {
        keys: '$mod+z',
        eventOptions: {preventDefault: true},
      },
    },
    {
      id: 'redo',
      description: 'Redo',
      context: ActionContextTypes.GLOBAL,
      icon: Redo2,
      handler: async () => { await repo.redo() },
      defaultBinding: {
        // $mod+Shift+z is the macOS (Cmd+Shift+Z) and Windows/Linux
        // (Ctrl+Shift+Z) primary; Control+y is the additional
        // Windows/Linux convention (and matches what the legacy
        // UndoRedoManager bindings used).
        keys: ['$mod+Shift+z', 'Control+y'],
        eventOptions: {preventDefault: true},
      },
    },
    {
      id: OPEN_PREFERENCES_ACTION_ID,
      description: 'Open preferences',
      context: ActionContextTypes.GLOBAL,
      icon: Settings,
      handler: async () => {
        const workspaceId = repo.activeWorkspaceId
        if (!workspaceId) return
        const prefsBlock = await getUserPrefsBlock(repo, workspaceId, repo.user)
        navigateFromGlobalCommand(repo, {blockId: prefsBlock.id, workspaceId})
      },
    },
    {
      id: CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID,
      description: 'New node',
      context: ActionContextTypes.GLOBAL,
      icon: Plus,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        await createNodeInActivePanelFromGlobalContext(uiStateBlock)
      },
    },
    {
      id: 'refresh_extensions',
      description: 'Reload extensions',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        refreshAppRuntime()
        console.log('Runtime extensions reloaded')
      },
    },
    {
      id: RELOAD_IN_SAFE_MODE_ACTION_ID,
      description: 'Reload in safe mode',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        reloadInSafeMode()
      },
    },
    {
      id: 'export_document',
      description: 'Export current document',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        await repo.load(uiStateBlock.id, {ancestors: true})
        const root = getRootBlock(repo.block(uiStateBlock.id))
        // The visible outline, not raw storage: property field rows are a
        // per-workspace representation of the cell, and `importState` replays
        // only content/structure — so exported machinery would land in the
        // target as ordinary `((fieldId))` rows rather than as properties.
        const blocks = await repo.query.subtree({id: root.id, hidePropertyChildren: true}).load()
        const data = JSON.stringify({blocks}, null, 2)

        const downloadLink = document.createElement('a')
        downloadLink.download = `document-state-${new Date().toUTCString()}.json`
        downloadLink.href = `data:application/json;charset=utf-8,${encodeURIComponent(data)}`
        downloadLink.click()
      },
    },
    {
      id: 'import_document',
      description: 'Import document',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json'

        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return

          const reader = new FileReader()
          reader.onload = async (e) => {
            const content = e.target?.result
            if (typeof content !== 'string') return

            try {
              const data = JSON.parse(content)
              const blockMap = await importState(data, repo)
              const block = blockMap.values().next().value
              if (block) {
                // Imported blocks default to repo.activeWorkspaceId in
                // repo.create, so the freshly-imported root lives in the
                // current workspace. Import is gated by an open workspace,
                // so activeWorkspaceId is set here.
                navigateFromGlobalCommand(repo, {blockId: block.id})
              }
            } catch (err) {
              console.error('Failed to import document:', err)
            }
          }
          reader.readAsText(file)
        }

        input.click()
      },
    },
    {
      id: 'export_sqlite_db',
      description: 'Download raw SQLite database (.db)',
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        const suggestedFilename = rawSqliteDbExportFilename(repo)
        let destination: FileSystemFileHandle | undefined
        try {
          destination = await chooseRawSqliteExportFile(suggestedFilename)
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return
          console.warn('[export-db] save picker unavailable; falling back to browser download:', err)
        }

        const banner = showProgress('Exporting SQLite database…')
        try {
          if (destination) {
            const {filename, size} = await exportRawSqliteDbToFile(repo, destination)
            banner.done(`Exported ${filename} (${(size / 1024 / 1024).toFixed(1)} MiB)`)
          } else {
            const {blob, filename, cleanup} = await exportRawSqliteDb(repo)
            downloadBlob(blob, filename, cleanup)
            banner.done(`Exported ${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MiB)`)
          }
        } catch (err) {
          console.error('[export-db] failed:', err)
          banner.fail(`SQLite export failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      },
    },
    {
      id: 'import_sqlite_db',
      description: 'Replace database with uploaded SQLite file (.db)',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.db,application/vnd.sqlite3,application/octet-stream'

        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return

          const sizeMiB = (file.size / 1024 / 1024).toFixed(1)
          const ok = window.confirm(
            `Replace this device's database with "${file.name}" (${sizeMiB} MiB)?\n\n` +
            `Any local data not already synced to the server will be lost. ` +
            `The page will reload after the import.`,
          )
          if (!ok) return

          const banner = showProgress(`Importing SQLite database (${sizeMiB} MiB)…`)
          try {
            await importRawSqliteDb(repo, file)
            banner.update('Import complete — reloading…')
            window.location.reload()
          } catch (err) {
            console.error('[import-db] failed:', err)
            banner.fail(`SQLite import failed: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        input.click()
      },
    },
    {
      id: 'lock_and_wipe_local_data',
      description: 'Wipe local data on this device (guided)',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        // Panic wipe. We can't reliably destroy origin storage from JS, and
        // can't emit a Clear-Site-Data header on GitHub Pages (a service worker
        // can't synthesize one — see docs/clear-site-data-spike/). So the dialog
        // reads this device's unsynced-change count to WARN if a wipe would lose
        // work, then guides the user to the browser/OS "clear site data" control,
        // which does the actual wipe + sign-out from outside the page context.
        // (Background sync handles uploads, so there's nothing to drain here.)
        void openDialog(WipeLocalDataDialog, { userId: repo.user.id })
      },
    },
    {
      id: 'navigate_back',
      description: 'Go back in navigation history',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.history.back()
      },
      defaultBinding: {
        keys: '$mod+[',
      },
    },
    {
      id: 'navigate_forward',
      description: 'Go forward in navigation history',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.history.forward()
      },
      defaultBinding: {
        keys: '$mod+]',
      },
    },
  ]

  // Shift+Arrow selection in edit mode is a two-stage gesture: while the
  // caret is inside the block, CodeMirror's native shift-selection must run;
  // only once it reaches the block edge do we leave edit mode and escalate to
  // block selection. Vertical motion here relies on the browser's native
  // default action (see move_up_from_cm_start), so an unconditional
  // preventDefault would swallow intra-block shift-selection. Bind with
  // preventDefault: false and take over by hand only on the escalation path —
  // mirroring move_up_from_cm_start. (The base extendSelection*Block actions
  // keep preventDefault: true for NORMAL_MODE, where there's no editor caret to
  // extend; bindBlockActionContext would inherit that here, hence the explicit
  // override.)
  //
  // At the block edge the caret is already at head 0 / doc end, so the native
  // Shift+Arrow is a no-op (nothing to select past the edge, and each block is
  // its own editor) — which means preventDefault timing doesn't matter here. We
  // can therefore resolve the escalation first and take over (suppress the key
  // + leave edit mode) ONLY when there's actually a neighbour to select. At the
  // first/last visible block there's no target, so we stay in edit mode rather
  // than dropping the user into a dead state (out of edit mode, nothing
  // selected, keystroke eaten). The `clearEditing` flag folds the
  // isEditing→false write into the selection's transaction, so there's no
  // intermediate render where the block is both editing and selected.
  const extendSelectionUpEdit = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionUpBlock, {idPrefix: 'edit.cm'}),
    handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
      if (!cursorIsAtStart(deps.editorView)) return
      const extended = await extendSelectionUp(
        deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen, /* clearEditing */ true,
      )
      if (extended) trigger.preventDefault()
    },
    defaultBinding: {
      keys: 'Shift+ArrowUp',
      eventOptions: {
        preventDefault: false,
      },
    },
  }
  const extendSelectionDownEdit = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionDownBlock, {idPrefix: 'edit.cm'}),
    handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
      if (!cursorIsAtEnd(deps.editorView)) return
      const extended = await extendSelectionDown(
        deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen, /* clearEditing */ true,
      )
      if (extended) trigger.preventDefault()
    },
    defaultBinding: {
      keys: 'Shift+ArrowDown',
      eventOptions: {
        preventDefault: false,
      },
    },
  }
  // CodeMirror-specific edit mode actions
  const editModeCMActions: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>[] = [
    {
      id: 'exit_edit_mode_cm',
      description: 'Exit edit mode',
      context: ActionContextTypes.EDIT_MODE_CM,
      icon: KeyboardOff,
      handler: async (deps: CodeMirrorEditModeDependencies) => setIsEditing(deps.uiStateBlock, false),
      defaultBinding: {
        keys: 'Escape',
      },
    },
    // Roam-style keyboard fold while editing — the non-vim analogue of vim's
    // `z` (vim makes `z` work because it has a focused-block normal mode; the
    // default config has no such mode, so fold lives here in edit mode). Cmd/
    // Ctrl+Up collapses, Cmd/Ctrl+Down expands. preventDefault overrides
    // CodeMirror's doc-start/doc-end caret jump — acceptable since blocks are
    // short and the chevron / swipe menu remain for the mouse path.
    {
      id: 'collapse_block_cm',
      description: 'Collapse block',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async ({block}: CodeMirrorEditModeDependencies) => {
        if (!block) return
        await withMoveTransition(async () => { await block.set(isCollapsedProp, true) })
      },
      defaultBinding: {
        keys: '$mod+ArrowUp',
        eventOptions: {preventDefault: true},
      },
    },
    {
      id: 'expand_block_cm',
      description: 'Expand block',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async ({block}: CodeMirrorEditModeDependencies) => {
        if (!block) return
        await withMoveTransition(async () => { await block.set(isCollapsedProp, false) })
      },
      defaultBinding: {
        keys: '$mod+ArrowDown',
        eventOptions: {preventDefault: true},
      },
    },
    {
      id: 'split_block_cm',
      description: 'Split block at cursor',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies) => {
        const {block, editorView, uiStateBlock, scopeRootId} = deps
        if (!block || !editorView || !uiStateBlock) return

        // NOTE: Enter-accepts-an-open-completion is handled INSIDE the editor
        // (acceptCompletionBeforeIOSDefer capture handler + CM's completion
        // keymap), which swallow the key before it reaches this window-level
        // shortcut. So this shortcut stays completion-unaware and just splits.
        if (!scopeRootId) return

        const policy = await structuralEditPolicyForBlock(block, scopeRootId)

        const selection = editorView.state.selection.main
        const doc = editorView.state.doc
        const cursorPos = selection.head

        const createSiblingBelow = async () => {
          const newId = await repo.mutate.createSiblingBelow({siblingId: block.id})
          if (newId) await focusBlock(uiStateBlock, newId, {edit: true, renderScopeId: deps.renderScopeId})
        }

        // Case 1: Cursor is in middle of text
        if (cursorPos < doc.length) {
          // At the scope root a normal split would bury the before-text in
          // an invisible preceding sibling — keep it in the root and push
          // the continuation into a new first child instead.
          if (policy.isScopeRoot) {
            const childId = await splitScopeRootIntoFirstChild(block, editorView)
            await uiStateBlock.set(editorSelection, {blockId: childId, start: 0})
            await focusBlock(uiStateBlock, childId, {edit: true, renderScopeId: deps.renderScopeId})
          } else {
            const blockInFocus = await splitCodeMirrorBlockAtCursor(block, editorView)
            await uiStateBlock.set(editorSelection, {
              blockId: blockInFocus.id,
              start: 0,
            })
            await focusBlock(uiStateBlock, blockInFocus.id, {edit: true, renderScopeId: deps.renderScopeId})
          }
        }
        // Case 2: Cursor at end and the new block belongs as a first
        // child — either the block shows children, or it's the scope
        // root (where a sibling would land outside the surface).
        else if (cursorPos === doc.length && policy.createBelowPlacement === 'child-first') {
          const newId = await repo.mutate.createChild({
            parentId: block.id,
            position: {kind: 'first'},
            revealParent: true,
          })
          if (newId) await focusBlock(uiStateBlock, newId, {edit: true, renderScopeId: deps.renderScopeId})
        }
        // Repeated empty blocks creation - outdents the new block.
        // outdent returns false if the block is at the surface boundary
        // (parent === scopeRootId) or already at workspace root — fall
        // back to creating a sibling below. The scope root itself can't
        // outdent (canOutdent false), so it falls back too.
        // Unwrapped (see indent/outdent in blockActions): the
        // root-level crossfade ghosts the shifting siblings, which
        // reads as blur. The unwrapped shift is cleaner.
        else if (editorView.state.doc.length === 0) {
          const moved = policy.canOutdent && await repo.mutate.outdent({id: block.id, scopeRootId})
          if (!moved) await createSiblingBelow()
        }
        // Cursor at end, no children or they are collapsed
        else {
          await createSiblingBelow()
        }
      },
      defaultBinding: {
        keys: 'Enter',
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'move_up_from_cm_start',
      description: 'Move to previous block when cursor is at start of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock, scopeRootId} = deps
        if (!block || !editorView || !uiStateBlock) return

        if (!scopeRootId || !isOnFirstVisualLine(editorView)) return

        // Capture caret x and call preventDefault BEFORE the async hop. The
        // hotkeys-js handler runs during the bubble phase but the browser's
        // default ArrowUp on the contenteditable still fires (we ask for
        // preventDefault: false because preventing it unconditionally would
        // also block intra-block arrow movement). Once we await, the browser
        // collapses the editor caret to position 0, so a later
        // `getCaretRect(editorView)` would read x at the editor's left edge
        // and the new block's cursor would land at column 0 instead of the
        // visual column the user came from. preventDefault here, before any
        // await, suppresses the native move just in time. ArrowDown mirrors
        // this — without it, the caret collapses to doc end and the next
        // block lands past its first line's end.
        const caretX = getCaretRect(editorView)?.left
        trigger.preventDefault()

        const prevVisible = await previousVisibleBlock(block, scopeRootId)
        if (!prevVisible) return
        const data = block.peek() ?? await block.load()
        if (data?.parentId === prevVisible.id && focusPropertyRow(prevVisible.id, 'last')) {
          setIsEditing(uiStateBlock, false)
          return
        }

        await uiStateBlock.set(editorSelection, {
          blockId: prevVisible.id,
          line: 'last',
          x: caretX,
        })

        await focusBlock(uiStateBlock, prevVisible.id, {edit: true, renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: 'ArrowUp',
        eventOptions: {
          preventDefault: false,
        },
      },
    },
    {
      id: 'move_down_from_cm_end',
      description: 'Move to next block when cursor is at end of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock, scopeRootId} = deps
        if (!block || !editorView || !uiStateBlock) return

        if (!scopeRootId || !isOnLastVisualLine(editorView)) return

        // Capture caret x and call preventDefault BEFORE the async hop —
        // see move_up_from_cm_start for the full rationale. Without this,
        // the browser's native ArrowDown collapses the editor caret to doc
        // end before we read the rect, so x ends up at the right edge of
        // the source block's last line and the next block's cursor lands
        // past the end of its first visual line instead of at the column
        // the user came from.
        const caretX = getCaretRect(editorView)?.left
        trigger.preventDefault()

        if (focusPropertyRow(block.id, 'first')) {
          setIsEditing(uiStateBlock, false)
          return
        }

        const nextVisible = await nextVisibleBlock(block, scopeRootId, deps.scopeRootForcesOpen)
        if (!nextVisible) return

        await uiStateBlock.set(editorSelection, {
          blockId: nextVisible.id,
          x: caretX,
        })

        await focusBlock(uiStateBlock, nextVisible.id, {edit: true, renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: 'ArrowDown',
      },
    },
    {
      id: 'move_left_from_cm_start',
      description: 'Move to previous block when cursor is at start of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock, scopeRootId} = deps
        if (!block || !editorView || !uiStateBlock) return

        const selection = editorView.state.selection.main
        if (!(selection.empty && selection.head === 0)) return

        if (!scopeRootId) return

        trigger.preventDefault()

        const prevVisible = await previousVisibleBlock(block, scopeRootId)
        if (!prevVisible) return

        const prevData = await prevVisible.load()
        await uiStateBlock.set(editorSelection, {
          blockId: prevVisible.id,
          start: prevData?.content.length ?? 0,
        })

        await focusBlock(uiStateBlock, prevVisible.id, {edit: true, renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: 'ArrowLeft',
      },
    },
    {
      id: 'move_right_from_cm_end',
      description: 'Move to next block when cursor is at end of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock, scopeRootId} = deps
        if (!block || !editorView || !uiStateBlock) return

        const selection = editorView.state.selection.main
        if (!(selection.empty && selection.head === editorView.state.doc.length)) return

        if (!scopeRootId) return

        trigger.preventDefault()

        const nextVisible = await nextVisibleBlock(block, scopeRootId, deps.scopeRootForcesOpen)
        if (!nextVisible) return

        await uiStateBlock.set(editorSelection, {
          blockId: nextVisible.id,
          start: 0,
        })

        await focusBlock(uiStateBlock, nextVisible.id, {edit: true, renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: 'ArrowRight',
      },
    },
    {
      id: 'delete_empty_block_cm',
      description: 'Backspace at block start: delete empty / merge into previous',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock, scopeRootId} = deps
        if (!block || !uiStateBlock || !editorView) return

        // Only act when the cursor is at position 0 with no selection;
        // otherwise codemirror's default backspace handles it.
        const sel = editorView.state.selection.main
        if (!(sel.empty && sel.from === 0)) return

        if (!scopeRootId) return

        // Don't merge the scope root into a block outside the surface —
        // there's no visible previous block to merge into here.
        const {canMergeUp} = await structuralEditPolicyForBlock(block, scopeRootId)

        // Live content from the editor — SQL may lag (pushChange is debounced).
        const liveContent = editorView.state.doc.toString()

        // Empty block: delete it and move focus up. Both branches are gated on
        // `canMergeUp` because both are the same gesture — "consume this block
        // and put the cursor on the previous visible one" — and at the scope
        // root there is no such block. That's a statement about Backspace, not
        // about deletability: explicit Delete on the scope root IS allowed
        // (page deletion), it just isn't something Backspace should trigger on
        // an accidentally-emptied page.
        if (liveContent === '') {
          if (!canMergeUp) return
          trigger.preventDefault()
          // Ask the deletion guards BEFORE moving focus — a refused delete that
          // had already moved the cursor would look like the block vanished.
          // This path deletes the block's whole subtree, so it needs the same
          // veto as `delete_block`; emptying a daily note's title and pressing
          // Backspace used to destroy it straight past the guard.
          if (!await ensureDeletableThroughUi([block])) return
          const prevVisible = await previousVisibleBlock(block, scopeRootId)
          if (prevVisible) {
            const prevData = await prevVisible.load()
            await uiStateBlock.set(editorSelection, {
              blockId: prevVisible.id,
              start: prevData?.content.length ?? 0,
            })
            await focusBlock(uiStateBlock, prevVisible.id, {edit: true, renderScopeId: deps.renderScopeId})
          }
          await deleteBlockThroughUi(block)
          return
        }

        // Non-empty block: merge into the previous visible block (Roam-style).
        // Refuse if there is none, or if the previous visible block is the
        // panel's top-level block (don't merge into the page/view header).
        // Refuse to merge the scope root upward — its previous visible
        // block lives outside the surface.
        if (!canMergeUp) return

        const prevVisible = await previousVisibleBlock(block, scopeRootId)
        if (!prevVisible || prevVisible.id === scopeRootId) return

        // Roam rule: refuse when both blocks have independent children — the
        // children would have to be reconciled in a way the user didn't ask
        // for. When the source is the target's only child, there is no
        // independent target subtree: source children replace source's slot.
        await Promise.all([block.load(), prevVisible.load()])
        const fromChildIds = await block.childIds.load()
        const intoChildIds = await prevVisible.childIds.load()
        const intoHasIndependentChildren = intoChildIds.some(childId => childId !== block.id)
        if (fromChildIds.length > 0 && intoHasIndependentChildren) return

        // Vestigial, and kept only because it costs nothing: every branch above
        // awaits, so the event has finished dispatching by now and the browser
        // default has already run — `move_up_from_cm_start` states that rule
        // and calls preventDefault BEFORE its async hop for exactly this
        // reason. There is nothing to suppress in any case: block editors pass
        // `defaultKeymap: false`, so Backspace has no CodeMirror command, and
        // native backspace at offset 0 of the editing host does nothing.
        trigger.preventDefault()

        const intoContentBefore = prevVisible.peek()?.content ?? ''
        const joinOffset = intoContentBefore.length
        const prevId = prevVisible.id

        // A merge DESTROYS `from` (core.merge soft-deletes it), so it needs the
        // same veto as an outright delete — otherwise Backspace at offset 0 of a
        // guarded page merges it away while `Delete` on it is refused.
        if (!await ensureDeletableThroughUi([block])) return

        // Single tx: flush the editor's live content into `from` first so
        // core.merge concatenates the latest text, then run the merge.
        // tx.run sees writes from the same tx via SQL.
        await repo.tx(async tx => {
          await tx.update(block.id, {content: liveContent})
          await tx.run(mergeMutator, {intoId: prevId, fromId: block.id})
        }, {scope: ChangeScope.BlockDefault, description: 'merge into previous block'})

        await uiStateBlock.set(editorSelection, {
          blockId: prevId,
          start: joinOffset,
        })
        await focusBlock(uiStateBlock, prevId, {edit: true, renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: 'Backspace',
      },
    },
    {
      id: 'merge_next_block_cm',
      description: 'Delete at block end: merge the next block into this one (CodeMirror)',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock, scopeRootId} = deps
        if (!block || !uiStateBlock || !editorView) return

        // Mirror of delete_empty_block_cm in the down direction: Backspace
        // at a block's start folds it into the previous visible block;
        // Delete at a block's end folds the next visible block into this
        // one. Both collapse the same boundary at the same join point.

        // Only act when the cursor is at the very end with no selection;
        // otherwise codemirror's default forward-delete handles it.
        const sel = editorView.state.selection.main
        if (!(sel.empty && sel.to === editorView.state.doc.length)) return

        if (!scopeRootId) return

        // Backspace refuses to merge *into* the scope root (the page/view
        // header). Delete pulls the next block up *into* this one, so the
        // mirror refusal is: don't absorb a child up into the scope root.
        if (block.id === scopeRootId) return

        // The next visible block is the one that folds away — the same block
        // Backspace would merge upward if the caret sat at its start
        // (previousVisibleBlock and nextVisibleBlock are inverses over the
        // visible-order list, so this stays at the same boundary).
        const nextVisible = await nextVisibleBlock(block, scopeRootId, deps.scopeRootForcesOpen)
        if (!nextVisible) return

        // Roam rule (mirror of Backspace): refuse when both blocks have
        // independent children — reconciling two child lists isn't what the
        // user asked for. When `next` is this block's only child there is no
        // independent target subtree: next's children take next's slot.
        await Promise.all([block.load(), nextVisible.load()])
        const intoChildIds = await block.childIds.load()
        const fromChildIds = await nextVisible.childIds.load()
        const intoHasIndependentChildren = intoChildIds.some(childId => childId !== nextVisible.id)
        if (fromChildIds.length > 0 && intoHasIndependentChildren) return

        // Ask the deletion guards BEFORE any side effect — the merge destroys
        // `nextVisible`, so a guarded page must not be folded away. This has to
        // precede the editor re-arm below: that dispatch is a real doc change,
        // so CodeMirror's onChange fires and `pushChange` persists the
        // concatenated text ~300ms later. Guarding after it left the refusal
        // path writing the merged content while the other block survived —
        // silent duplication on exactly the blocks the guard protects.
        // (Nothing is lost by returning before the `preventDefault` below:
        // block editors pass `defaultKeymap: false`, so Delete has no
        // CodeMirror command at all, and native forward-delete at the end of
        // the editing host is a no-op. That call is vestigial anyway — see the
        // Backspace twin.)
        if (!await ensureDeletableThroughUi([nextVisible])) return

        trigger.preventDefault()

        // Live content from the editor — SQL may lag (pushChange is debounced).
        const liveContent = editorView.state.doc.toString()
        const joinOffset = liveContent.length
        const fromContent = nextVisible.peek()?.content ?? ''
        const fromId = nextVisible.id

        // Re-arm the editor synchronously with the merged text (caret parked
        // at the join) so its debounced pushChange carries the post-merge
        // content. Unlike Backspace — which hands focus to the previous
        // block's editor — Delete keeps the caret in *this* editor, so a
        // pending flush of the pre-merge text would otherwise clobber the
        // fold core.merge wrote to SQL. Same precaution as
        // splitCodeMirrorBlockAtCursor.
        editorView.dispatch({
          changes: {from: 0, to: editorView.state.doc.length, insert: liveContent + fromContent},
          selection: EditorSelection.cursor(joinOffset),
        })

        // Single tx: flush the editor's live content into `into` first so
        // core.merge concatenates the latest text, then fold `next` in.
        await repo.tx(async tx => {
          await tx.update(block.id, {content: liveContent})
          await tx.run(mergeMutator, {intoId: block.id, fromId})
        }, {scope: ChangeScope.BlockDefault, description: 'merge next block into current'})

        await uiStateBlock.set(editorSelection, {
          blockId: block.id,
          start: joinOffset,
        })
        await focusBlock(uiStateBlock, block.id, {edit: true, renderScopeId: deps.renderScopeId})
      },
      defaultBinding: {
        keys: 'Delete',
      },
    },
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, indentBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, outdentBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, zoomInBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, zoomOutBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, openFocusedInPanelBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, closeCurrentPanelBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, toggleMaximizePanelBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, insertExampleExtensionsBlock, {idPrefix: 'edit.cm'}),
    moveBlockUpCM,
    moveBlockDownCM,
    extendSelectionDownEdit,
    extendSelectionUpEdit,
  ]

  // Property-panel field actions. PROPERTY_EDITING is activated (and
  // deactivated) by `usePropertyEditingActivation` around a focused property
  // `<input>`, so `deps.input` is exactly the field the user is typing in.
  const propertyEditingActions: ActionConfig<typeof ActionContextTypes.PROPERTY_EDITING>[] = [
    {
      id: 'exit_property_editing',
      description: 'Exit property editing',
      context: ActionContextTypes.PROPERTY_EDITING,
      icon: KeyboardOff,
      // Blurring IS the exit: the input's own onBlur commits the pending
      // value and the activation hook deactivates this context. Committing
      // (rather than reverting) matches `exit_edit_mode_cm`, which likewise
      // leaves the typed content in place.
      //
      // Deliberately no `setIsEditing(false)`: every route into a property
      // field already left block edit mode — the arrow-key routes clear it
      // explicitly (`move_up_from_cm_start` / `move_down_from_cm_end`) and a
      // click into the field trips the editor's blur exit
      // (`shouldExitEditModeAfterBlur` treats a property input as "not an
      // editor"). A clear here would be dead code dressed as load-bearing.
      // IME compositions are handled once, in the coordinator, which drops
      // composing keydowns before any candidate is considered — so there is
      // no guard here. A decline would only have meant "try the next
      // candidate", handing the chord to a global bound to the same keys.
      handler: (deps: PropertyEditingDependencies) => { deps.input.blur() },
      defaultBinding: {
        keys: 'Escape',
        // Same stance as `exit_edit_mode_cm` (whose context defaults to
        // preventDefault: false): leave the field's own native Escape
        // handling alone — an open autofill/date popup, a pending IME
        // composition. The blur happens either way.
        eventOptions: {preventDefault: false},
      },
    },
  ]

  // Multi-select mode actions
  const extendSelectionUpMultiAction = {
    ...makeMultiSelect(extendSelectionUpAction),
    defaultBinding: {
      keys: ['ArrowUp', 'k', 'Shift+k', 'Shift+ArrowUp'],
      eventOptions: {
        preventDefault: true,
      },
    },
  }
  const extendSelectionDownMultiAction = {
    ...makeMultiSelect(extendSelectionDownAction),
    defaultBinding: {
      keys: ['ArrowDown', 'j', 'Shift+j', 'Shift+ArrowDown'],
      eventOptions: {
        preventDefault: true,
      },
    },
  }

  /**
   * `Delete` in multi-select. Destructive — see `ensureDeletableThroughUi`
   * for the guards (a read-only workspace, a seeded definition anywhere in
   * the selection) it refuses over.
   *
   * Focus is moved explicitly rather than left to `PanelFocusRecovery`: that
   * watcher is mounted by the spatial-navigation plugin, which is a toggle, so
   * relying on it would leave focus pointing at a tombstone whenever the plugin
   * is off. The target is computed BEFORE the delete (it has to be walked while
   * the tree still exists) from the last selected block, skipping its subtree;
   * if that lands back inside the selection there is no sensible target and we
   * leave focus alone.
   */
  const deleteSelectedBlocks = async (deps: MultiSelectModeDependencies): Promise<void> => {
    const {uiStateBlock, selectedBlocks, scopeRootId} = deps
    if (!selectedBlocks.length) return

    const blocks = selectedBlocks.toReversed()
    if (!await ensureDeletableThroughUi(blocks)) return

    const selectedIds = new Set(selectedBlocks.map(block => block.id))
    const after = scopeRootId
      ? await blockAfterSubtreeRemoval(selectedBlocks[selectedBlocks.length - 1], scopeRootId)
      : null
    const focusTarget = after && !selectedIds.has(after.id) ? after : null

    let deleted = false
    await withMoveTransition(async () => {
      deleted = await deleteBlocksThroughUi(blocks)
    })
    if (!deleted) return
    await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue)
    if (focusTarget) {
      void focusBlock(uiStateBlock, focusTarget.id)
    }
  }

  /**
   * `$mod+x` / `d` in multi-select — used to be `delete_selected_blocks`
   * with a clipboard write bolted on; now a true (non-destructive) cut. It
   * serializes the selection to markdown, writes that to the OS clipboard
   * (unchanged from before), and marks the ids as a pending move
   * (`cutBlockIdsToClipboard`, `@/utils/pendingMove.js`) — nothing is
   * deleted or reparsed. The blocks stay exactly where they are until a
   * paste completes the move (`pasteOrMove`, wired into
   * `paste_after_selection` / `paste_before_selection` below), so an
   * un-pasted cut loses nothing: no delete means no deletion guard to
   * consult here either, unlike the old delete-based cut.
   *
   * Selection clears on a successful mark (matching the old cut's
   * "successful destructive action exits multi-select" convention), but
   * there's no vanished content to redirect focus away from, so — unlike
   * `deleteSelectedBlocks` — nothing else moves.
   */
  const cutSelectedBlocks = async (deps: MultiSelectModeDependencies): Promise<void> => {
    const {uiStateBlock, selectedBlocks} = deps
    if (!selectedBlocks.length) return

    const marked = await cutBlockIdsToClipboard(selectedBlocks.map(block => block.id), repo)
    if (marked) await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue)
  }

  /**
   * The body of BOTH multi-select paste gestures. `p` and `Shift+p` differ
   * only in which end of the selection anchors the paste, so they share
   * this rather than each re-deriving the placement and selection rules —
   * the shape that let `d` and `Delete` diverge until one destroyed a
   * daily note the other refused.
   *
   * `placement: 'sibling'` rather than the 'visible' default: a paste
   * around a multi-block range belongs beside the range, never inside the
   * last selected block. `pasteOrMove` applies that to the move target as
   * well, so completing a pending cut lands exactly where an ordinary
   * paste here would.
   *
   * The selection clears on either outcome — those blocks are no longer
   * what the user is acting on — but only a text paste mints something
   * new to focus.
   */
  const pasteAroundSelection = async (
    deps: MultiSelectModeDependencies,
    position: 'before' | 'after',
  ): Promise<void> => {
    const {uiStateBlock, selectedBlocks} = deps
    const target = position === 'after' ? selectedBlocks.at(-1) : selectedBlocks[0]
    if (!target) return

    let result: PasteOrMoveResult = {moved: false, pasted: []}
    await withMoveTransition(async () => {
      result = await pasteOrMove(repo, target, position, {
        placement: 'sibling',
        scopeRootId: deps.scopeRootId,
      })
    })

    if (!result.moved && !result.pasted[0]) return
    await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue)
    if (result.pasted[0]) void focusBlock(uiStateBlock, result.pasted[0].id)
  }

  const multiSelectModeActions: ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>[] = [
    extendSelectionUpMultiAction,
    extendSelectionDownMultiAction,
    applyToAllBlocksInSelection(toggleBlockCollapseAction),
    applyToAllBlocksInSelection(togglePropertiesDisplayAction),
    applyToAllBlocksInSelection(indentBlockAction),
    applyToAllBlocksInSelection(outdentBlockAction, {applyInReverseOrder: true}),
    {
      ...makeMultiSelect(deleteBlockAction),
      handler: (deps: MultiSelectModeDependencies) => deleteSelectedBlocks(deps),
    },
    applyToAllBlocksInSelection(moveBlockUpAction),
    applyToAllBlocksInSelection(moveBlockDownAction, {applyInReverseOrder: true}),
    {
      id: 'clear_selection',
      description: 'Clear selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) =>
        deps.uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue),
      defaultBinding: {
        keys: 'Escape',
      },
    },
    {
      id: 'copy_selected_blocks',
      description: 'Copy selected blocks to clipboard',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: ({uiStateBlock}) => copySelectedBlocksToClipboard(uiStateBlock, repo),
      defaultBinding: {
        keys: ['$mod+c', 'y'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'cut_selected_blocks',
      description: 'Cut selected blocks (mark for move)',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: (deps: MultiSelectModeDependencies) => cutSelectedBlocks(deps),
      defaultBinding: {
        keys: ['$mod+x', 'd'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'paste_after_selection',
      description: 'Paste from clipboard after selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: (deps: MultiSelectModeDependencies) => pasteAroundSelection(deps, 'after'),
      defaultBinding: {
        keys: 'p',
      },
    },
    {
      id: 'paste_before_selection',
      description: 'Paste from clipboard before selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: (deps: MultiSelectModeDependencies) => pasteAroundSelection(deps, 'before'),
      defaultBinding: {
        keys: 'Shift+p',
      },
    },
  ];

  return {
    globalActions,
    normalModeActions,
    editModeCMActions,
    propertyEditingActions,
    multiSelectModeActions,
  }
}

export function getDefaultActions({repo}: { repo: Repo }): ActionConfig[] {
  const {
    globalActions,
    normalModeActions,
    editModeCMActions,
    propertyEditingActions,
    multiSelectModeActions,
  } = getDefaultActionGroups({repo})

  return [
    ...globalActions,
    ...normalModeActions,
    ...editModeCMActions,
    ...propertyEditingActions,
    ...multiSelectModeActions,
  ] as ActionConfig[]
}

export const defaultActionContextsExtension: AppExtension = systemToggle({
  id: 'system:action-contexts',
  name: 'Action contexts',
  description: 'Registers the built-in shortcut contexts (global, normal mode, edit mode, property editing, multi-select) so activation validation remains available.',
  essential: true,
}).of(defaultActionContextConfigs.map(context => actionContextsFacet.of(context)))

export function defaultActionsExtension({repo}: { repo: Repo }): AppExtension {
  const {
    globalActions,
    normalModeActions,
    editModeCMActions,
    propertyEditingActions,
    multiSelectModeActions,
  } = getDefaultActionGroups({repo})

  const actions = [
    ...globalActions,
    ...normalModeActions,
    ...editModeCMActions,
    ...propertyEditingActions,
    ...multiSelectModeActions,
  ] as ActionConfig[]

  return systemToggle({
    id: 'system:default-actions',
    name: 'Default keyboard shortcuts',
    description: 'Built-in shortcuts (Enter/Tab/Cmd+K-style). Disabling removes the default bindings; user-defined ones still work.',
    // `lock_and_wipe_local_data` opens a dialog via openDialog, which needs
    // DialogHost mounted; pull it in here. The mount's `core.dialogs` id dedupes
    // (dedupById), so DialogHost is registered once no matter how many
    // dialog-using plugins contribute it.
  }).of([...actions.map(action => actionsFacet.of(action)), dialogAppMountExtension])
}
