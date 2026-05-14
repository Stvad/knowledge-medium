import { PanelRightOpen, Plus, ZoomIn } from 'lucide-react'
import { defaultActionContextConfigs } from './defaultContexts.ts'
import {
  ActionContextTypes,
  BaseShortcutDependencies,
  ActionConfig,
  BlockShortcutDependencies,
  MultiSelectModeDependencies,
  CodeMirrorEditModeDependencies,
  ActionTrigger,
} from './types'
import { Block } from '@/data/block'
import { Repo } from '@/data/repo'
import { merge as mergeMutator } from '@/data/internals/kernelMutators'
import { ChangeScope } from '@/data/api'
import {
  nextVisibleBlock,
  previousVisibleBlock,
  getRootBlock,
} from '@/utils/selection.ts'
import { importState } from '@/utils/state.ts'
import {
  focusedBlockIdProp,
  activePanelIdProp,
  isEditingProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  editorSelection,
  setIsEditing,
  setFocusedBlockId,
} from '@/data/properties.ts'
import { insertExampleExtensionsUnder } from '@/extensions/exampleExtensions.ts'
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
} from '@/utils/codemirror.ts'
import { copySelectedBlocksToClipboard } from '@/utils/copy.ts'
import { pasteFromClipboard } from '@/utils/paste.ts'
import { actionContextsFacet, actionsFacet } from '@/extensions/core.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { refreshAppRuntime } from '@/extensions/runtimeEvents.ts'
import { getLayoutSessionBlock } from '@/data/globalState.ts'
import { getLayoutSessionId } from '@/utils/layoutSessionId.ts'
import {
  navigate,
  navigateFromGlobalCommand,
} from '@/utils/navigation.ts'
import { navigateInPanel } from '@/utils/panelHistory.ts'
import {
  deletePanelRow,
  panelBlockId,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection.ts'
import { ensureMetricsConsoleHook } from '@/data/metricsConsoleHook.ts'
import { showProgress } from '@/utils/toast.ts'
import { downloadBlob, exportRawSqliteDb, importRawSqliteDb } from '@/utils/exportSqliteDb.ts'
import { focusPropertyRow } from '@/utils/propertyNavigation.ts'

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

export const CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID = 'create_node_in_active_panel'

const createNodeInActivePanelFromGlobalContext = async (
  uiStateBlock: Block,
): Promise<void> => {
  const repo = uiStateBlock.repo
  if (repo.isReadOnly) return

  const layoutSessionBlock = await getLayoutSessionBlock(uiStateBlock, getLayoutSessionId())
  await layoutSessionBlock.load()
  const rows = await repo.query.subtree({id: layoutSessionBlock.id}).load()
  const panelRows = panelRowsInLayoutOrder(layoutSessionBlock.id, rows)
  const activePanelId = layoutSessionBlock.peekProperty(activePanelIdProp)
  const activePanelRow =
    (activePanelId ? panelRows.find(row => row.id === activePanelId) : undefined) ??
    panelRows.at(-1)
  if (!activePanelRow) return

  const activeTopLevelBlockId = panelBlockId(activePanelRow)
  if (!activeTopLevelBlockId) return

  const newId = await repo.mutate.createChild({
    parentId: activeTopLevelBlockId,
    position: {kind: 'last'},
  })
  await repo.tx(async tx => {
    await tx.setProperty(activePanelRow.id, focusedBlockIdProp, newId)
    await tx.setProperty(activePanelRow.id, isEditingProp, true)
  }, {scope: ChangeScope.UiState, description: 'create node in active panel'})
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
  } = createSharedBlockActions({repo})

  const indentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock)
  const outdentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, outdentBlock)
  const moveBlockUpAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockUp)
  const moveBlockDownAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockDown)
  const deleteBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, deleteBlock)
  const togglePropertiesDisplayAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, togglePropertiesDisplay)
  const toggleBlockCollapseAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleBlockCollapse)
  const extendSelectionUpAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionUpBlock)
  const extendSelectionDownAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionDownBlock)
  const copyBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlock)
  const copyBlockRefAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockRef)
  const copyBlockEmbedAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockEmbed)

  // Block-bound actions that operate on the focused/edited block in a
  // panel. Declared as BlockActions and bound below to both NORMAL_MODE
  // and EDIT_MODE_CM — in either context `block` is the active block
  // and `uiStateBlock` is the panel block (panel-bound).
  const zoomInBlock: BlockAction = {
    id: 'zoom_in',
    description: 'Zoom into focused block',
    icon: ZoomIn,
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      await navigateInPanel(uiStateBlock, block.id)
    },
    defaultBinding: {
      keys: ['cmd+.', 'ctrl+.'],
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

      await navigateInPanel(uiStateBlock, parent.id)
    },
    defaultBinding: {
      keys: ['cmd+,', 'ctrl+,'],
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
      })
    },
    defaultBinding: {
      keys: ['cmd+shift+.', 'ctrl+shift+.'],
    },
  }

  const closeCurrentPanelBlock: BlockAction = {
    id: 'close_current_panel',
    description: 'Close current panel',
    handler: async ({uiStateBlock}: BlockShortcutDependencies) => {
      await deletePanelRow(repo, uiStateBlock.id)
    },
    defaultBinding: {
      keys: 'ctrl+w',
      eventOptions: {preventDefault: true},
    },
  }

  const insertExampleExtensionsBlock: BlockAction = {
    id: 'insert_example_extensions',
    description: 'Insert example extensions under current block',
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      const created = await insertExampleExtensionsUnder(block)
      if (created[0]) await uiStateBlock.set(focusedBlockIdProp, created[0].id)
    },
  }

  const normalModeActions: ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] = [
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, zoomInBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, zoomOutBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, openFocusedInPanelBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, closeCurrentPanelBlock),
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, insertExampleExtensionsBlock),
    copyBlockAction,
    copyBlockRefAction,
    copyBlockEmbedAction,
  ]

  // CodeMirror versions of move actions
  const moveBlockUpCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockUp),
    id: 'move_block_up_cm',
    description: 'Move block up (CodeMirror)',
  }

  const moveBlockDownCM: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockDown),
    id: 'move_block_down_cm',
    description: 'Move block down (CodeMirror)',
  }

  const globalActions: ActionConfig<typeof ActionContextTypes.GLOBAL>[] = [
    {
      id: 'undo',
      description: 'Undo',
      context: ActionContextTypes.GLOBAL,
      handler: async () => { await repo.undo() },
      defaultBinding: {
        keys: ['cmd+z', 'ctrl+z'],
        eventOptions: {preventDefault: true},
      },
    },
    {
      id: 'redo',
      description: 'Redo',
      context: ActionContextTypes.GLOBAL,
      handler: async () => { await repo.redo() },
      defaultBinding: {
        // cmd+shift+z is the macOS convention; ctrl+y is the
        // Windows / Linux convention (and matches what the legacy
        // UndoRedoManager bindings used).
        keys: ['cmd+shift+z', 'ctrl+shift+z', 'ctrl+y'],
        eventOptions: {preventDefault: true},
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
      id: 'export_document',
      description: 'Export current document',
      context: ActionContextTypes.GLOBAL,
      handler: async ({uiStateBlock}: BaseShortcutDependencies) => {
        await repo.load(uiStateBlock.id, {ancestors: true})
        const root = getRootBlock(repo.block(uiStateBlock.id))
        const blocks = await repo.query.subtree({id: root.id}).load()
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
        const banner = showProgress('Exporting SQLite database…')
        try {
          const {blob, filename} = await exportRawSqliteDb(repo)
          downloadBlob(blob, filename)
          banner.done(`Exported ${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MiB)`)
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
      id: 'navigate_back',
      description: 'Go back in navigation history',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.history.back()
      },
      defaultBinding: {
        keys: ['cmd+[', 'ctrl+['],
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
        keys: ['cmd+]', 'ctrl+]'],
      },
    },
  ]

  const extendSelectionUpEdit = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionUpBlock, {idPrefix: 'edit.cm'}),
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      if (cursorIsAtStart(deps.editorView)) {
        setIsEditing(deps.uiStateBlock, false)
        await extendSelectionUp(deps.uiStateBlock, repo)
      }
    },
  }
  const extendSelectionDownEdit = {
    ...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionDownBlock, {idPrefix: 'edit.cm'}),
    handler: async (deps: CodeMirrorEditModeDependencies) => {
      if (cursorIsAtEnd(deps.editorView)) {
        setIsEditing(deps.uiStateBlock, false)
        await extendSelectionDown(deps.uiStateBlock, repo)
      }
    },
  }
  // CodeMirror-specific edit mode actions
  const editModeCMActions: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM>[] = [
    {
      id: 'exit_edit_mode_cm',
      description: 'Exit edit mode',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies) => setIsEditing(deps.uiStateBlock, false),
      defaultBinding: {
        keys: 'escape',
      },
    },
    {
      id: 'split_block_cm',
      description: 'Split block at cursor',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies) => {
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId) return
        await block.load()
        const childIds = await block.childIds.load()
        const isCollapsed = block.peekProperty(isCollapsedProp) ?? false
        const isTopLevel = block.id === topLevelBlockId

        const selection = editorView.state.selection.main
        const doc = editorView.state.doc
        const cursorPos = selection.head

        const createSiblingBelow = async () => {
          const newId = await repo.mutate.createSiblingBelow({siblingId: block.id})
          if (newId) setFocusedBlockId(uiStateBlock, newId)
        }

        const blockHasChildren = childIds.length > 0

        // Case 1: Cursor is in middle of text
        if (cursorPos < doc.length) {
          const blockInFocus = await splitCodeMirrorBlockAtCursor(block, editorView)
          await uiStateBlock.set(editorSelection, {
            blockId: blockInFocus.id,
            start: 0,
          })
          setFocusedBlockId(uiStateBlock, blockInFocus.id)
        }
        // Case 2: Cursor is at end of text and block has children
        else if (cursorPos === doc.length &&
          (blockHasChildren && !isCollapsed || isTopLevel)) {
          const newId = await repo.mutate.createChild({
            parentId: block.id,
            position: {kind: 'first'},
          })
          if (newId) setFocusedBlockId(uiStateBlock, newId)
        }
        // Repeated empty blocks creation - outdents the new block.
        // outdent returns false if the block is at the view boundary
        // (parent === topLevelBlockId) or already at workspace root —
        // fall back to creating a sibling below.
        else if (editorView.state.doc.length === 0) {
          const moved = await repo.mutate.outdent({id: block.id, topLevelBlockId})
          if (!moved) await createSiblingBelow()
        }
        // Cursor at end, no children or they are collapsed
        else {
          await createSiblingBelow()
        }
      },
      defaultBinding: {
        keys: 'enter',
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
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId || !isOnFirstVisualLine(editorView)) return

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

        const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
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

        setFocusedBlockId(uiStateBlock, prevVisible.id)
      },
      defaultBinding: {
        keys: 'up',
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
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId || !isOnLastVisualLine(editorView)) return

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

        const nextVisible = await nextVisibleBlock(block, topLevelBlockId)
        if (!nextVisible) return

        await uiStateBlock.set(editorSelection, {
          blockId: nextVisible.id,
          x: caretX,
        })

        setFocusedBlockId(uiStateBlock, nextVisible.id)
      },
      defaultBinding: {
        keys: 'down',
      },
    },
    {
      id: 'move_left_from_cm_start',
      description: 'Move to previous block when cursor is at start of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const selection = editorView.state.selection.main
        if (!(selection.empty && selection.head === 0)) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId) return

        trigger.preventDefault()

        const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
        if (!prevVisible) return

        const prevData = await prevVisible.load()
        await uiStateBlock.set(editorSelection, {
          blockId: prevVisible.id,
          start: prevData?.content.length ?? 0,
        })

        await uiStateBlock.set(focusedBlockIdProp, prevVisible.id)
      },
      defaultBinding: {
        keys: 'left',
      },
    },
    {
      id: 'move_right_from_cm_end',
      description: 'Move to next block when cursor is at end of CodeMirror',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock} = deps
        if (!block || !editorView || !uiStateBlock) return

        const selection = editorView.state.selection.main
        if (!(selection.empty && selection.head === editorView.state.doc.length)) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId) return

        trigger.preventDefault()

        const nextVisible = await nextVisibleBlock(block, topLevelBlockId)
        if (!nextVisible) return

        await uiStateBlock.set(editorSelection, {
          blockId: nextVisible.id,
          start: 0,
        })

        await uiStateBlock.set(focusedBlockIdProp, nextVisible.id)
      },
      defaultBinding: {
        keys: 'right',
      },
    },
    {
      id: 'delete_empty_block_cm',
      description: 'Backspace at block start: delete empty / merge into previous (CodeMirror)',
      context: ActionContextTypes.EDIT_MODE_CM,
      handler: async (deps: CodeMirrorEditModeDependencies, trigger: ActionTrigger) => {
        const {block, editorView, uiStateBlock} = deps
        if (!block || !uiStateBlock || !editorView) return

        // Only act when the cursor is at position 0 with no selection;
        // otherwise codemirror's default backspace handles it.
        const sel = editorView.state.selection.main
        if (!(sel.empty && sel.from === 0)) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId) return

        // Live content from the editor — SQL may lag (pushChange is debounced).
        const liveContent = editorView.state.doc.toString()

        // Empty block: delete it and move focus up.
        if (liveContent === '') {
          trigger.preventDefault()
          const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
          if (prevVisible) {
            const prevData = await prevVisible.load()
            await uiStateBlock.set(editorSelection, {
              blockId: prevVisible.id,
              start: prevData?.content.length ?? 0,
            })
            await uiStateBlock.set(focusedBlockIdProp, prevVisible.id)
          }
          await block.delete()
          return
        }

        // Non-empty block: merge into the previous visible block (Roam-style).
        // Refuse if there is none, or if the previous visible block is the
        // panel's top-level block (don't merge into the page/view header).
        const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
        if (!prevVisible || prevVisible.id === topLevelBlockId) return

        // Roam rule: refuse when both blocks have children — the children
        // would have to be reconciled in a way the user didn't ask for.
        // (Either side having children alone is fine: from's children move
        // under into; into's existing children stay put.)
        await Promise.all([block.load(), prevVisible.load()])
        const fromChildIds = await block.childIds.load()
        const intoChildIds = await prevVisible.childIds.load()
        if (fromChildIds.length > 0 && intoChildIds.length > 0) return

        // CodeMirror's backspace at pos 0 is a no-op, but stop the event
        // anyway to avoid any chance of double-handling.
        trigger.preventDefault()

        const intoContentBefore = prevVisible.peek()?.content ?? ''
        const joinOffset = intoContentBefore.length
        const prevId = prevVisible.id

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
        setFocusedBlockId(uiStateBlock, prevId)
      },
      defaultBinding: {
        keys: 'backspace',
      },
    },
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, indentBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, outdentBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, zoomInBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, zoomOutBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, openFocusedInPanelBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, closeCurrentPanelBlock, {idPrefix: 'edit.cm'}),
    bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, insertExampleExtensionsBlock, {idPrefix: 'edit.cm'}),
    moveBlockUpCM,
    moveBlockDownCM,
    extendSelectionDownEdit,
    extendSelectionUpEdit,
  ]

  // Multi-select mode actions
  const multiSelectModeActions: ActionConfig<typeof ActionContextTypes.MULTI_SELECT_MODE>[] = [
    makeMultiSelect(extendSelectionUpAction),
    makeMultiSelect(extendSelectionDownAction),
    applyToAllBlocksInSelection(toggleBlockCollapseAction),
    applyToAllBlocksInSelection(togglePropertiesDisplayAction),
    applyToAllBlocksInSelection(indentBlockAction),
    applyToAllBlocksInSelection(outdentBlockAction, {applyInReverseOrder: true}),
    applyToAllBlocksInSelection(deleteBlockAction),
    applyToAllBlocksInSelection(moveBlockUpAction),
    applyToAllBlocksInSelection(moveBlockDownAction, {applyInReverseOrder: true}),
    {
      id: 'clear_selection',
      description: 'Clear selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) =>
        deps.uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue),
      defaultBinding: {
        keys: 'escape',
      },
    },
    {
      id: 'copy_selected_blocks',
      description: 'Copy selected blocks to clipboard',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: ({uiStateBlock}) => copySelectedBlocksToClipboard(uiStateBlock, repo),
      defaultBinding: {
        keys: ['cmd+c', 'ctrl+c'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'cut_selected_blocks',
      description: 'Cut selected blocks to clipboard',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => {
        const {uiStateBlock, selectedBlocks} = deps
        if (!selectedBlocks.length) return

        await copySelectedBlocksToClipboard(uiStateBlock, repo)
        for (const block of selectedBlocks.toReversed()) {
          await block.delete()
        }
        await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue)
      },
      defaultBinding: {
        keys: ['cmd+x', 'ctrl+x', 'd'],
        eventOptions: {
          preventDefault: true,
        },
      },
    },
    {
      id: 'paste_after_selection',
      description: 'Paste from clipboard after selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => {
        const {uiStateBlock, selectedBlocks} = deps
        const target = selectedBlocks.at(-1)
        if (!target) return

        const pasted = await pasteFromClipboard(target, repo, {position: 'after'})
        if (pasted[0]) {
          await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue)
          setFocusedBlockId(uiStateBlock, pasted[0].id)
        }
      },
      defaultBinding: {
        keys: 'p',
      },
    },
    {
      id: 'paste_before_selection',
      description: 'Paste from clipboard before selection',
      context: ActionContextTypes.MULTI_SELECT_MODE,
      handler: async (deps: MultiSelectModeDependencies) => {
        const {uiStateBlock, selectedBlocks} = deps
        const target = selectedBlocks[0]
        if (!target) return

        const pasted = await pasteFromClipboard(target, repo, {position: 'before'})
        if (pasted[0]) {
          await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue)
          setFocusedBlockId(uiStateBlock, pasted[0].id)
        }
      },
      defaultBinding: {
        keys: 'shift+p',
      },
    },
  ];

  return {
    globalActions,
    normalModeActions,
    editModeCMActions,
    multiSelectModeActions,
  }
}

export function getDefaultActions({repo}: { repo: Repo }): ActionConfig[] {
  const {
    globalActions,
    normalModeActions,
    editModeCMActions,
    multiSelectModeActions,
  } = getDefaultActionGroups({repo})

  return [
    ...globalActions,
    ...normalModeActions,
    ...editModeCMActions,
    ...multiSelectModeActions,
  ] as ActionConfig[]
}

export function defaultActionsExtension({repo}: { repo: Repo }): AppExtension {
  const {
    globalActions,
    normalModeActions,
    editModeCMActions,
    multiSelectModeActions,
  } = getDefaultActionGroups({repo})

  const actions = [
    ...globalActions,
    ...normalModeActions,
    ...editModeCMActions,
    ...multiSelectModeActions,
  ] as ActionConfig[]

  return [
    defaultActionContextConfigs.map(context => actionContextsFacet.of(context)),
    actions.map(action => actionsFacet.of(action)),
  ]
}
