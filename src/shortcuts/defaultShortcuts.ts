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
import { createChild as createChildMutator, merge as mergeMutator } from '@/data/internals/kernelMutators'
import { ChangeScope } from '@/data/api'
import {
  nextVisibleBlock,
  previousVisibleBlock,
  getRootBlock,
} from '@/utils/selection.ts'
import { importState } from '@/utils/state.ts'
import {
  focusedBlockIdProp,
  isCollapsedProp,
  topLevelBlockIdProp,
  editorSelection,
  setIsEditing,
  setFocusedBlockId,
  aliasesProp,
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
import { buildAppHash, parseAppHash, writeAppHash } from '@/utils/routing.ts'
import { agentRuntimeBridgeRestartEvent } from '@/agentRuntime/useAgentRuntimeBridge.ts'
import { openAgentTokensDialogEvent } from '@/agentRuntime/AgentTokensDialog.tsx'
import { isMainPanel } from '@/data/globalState.ts'
import { addDaysIso, getOrCreateDailyNote, todayIso } from '@/data/dailyNotes.ts'
import { importRoam } from '@/utils/roamImport/import.ts'
import { ensureRoamImportWindowHook } from '@/utils/roamImport/runtime.ts'
import { ensureMetricsConsoleHook } from '@/data/metricsConsoleHook.ts'
import { showProgressBanner } from '@/utils/roamImport/progressBanner.ts'
import type { RoamExport } from '@/utils/roamImport/types.ts'
import { downloadBlob, exportRawSqliteDb, importRawSqliteDb } from '@/utils/exportSqliteDb.ts'

const splitCodeMirrorBlockAtCursor = async (
  block: Block,
  editorView: EditorView,
  isTopLevel: boolean,
): Promise<Block> => {
  const doc = editorView.state.doc
  const cursorPos = editorView.state.selection.main.head

  const beforeCursor = doc.sliceString(0, cursorPos)
  const afterCursor = doc.sliceString(cursorPos)
  const repo = block.repo

  // Push the prefix into the editor synchronously so its debounced
  // pushChange re-arms with the post-split text. Without this the
  // pending debounce would later flush the pre-split full content
  // and clobber the prefix that core.split wrote to SQL.
  editorView.dispatch({
    changes: {from: 0, to: doc.length, insert: beforeCursor},
    selection: EditorSelection.cursor(0),
  })

  if (isTopLevel) {
    // Top-level: drop the after-cursor content into a new first
    // child; the original block keeps the before-cursor content. We
    // do both in one tx so the visible split is atomic. Use
    // tx.run(createChildMutator, …) instead of repo.mutate.createChild
    // so the child create + parent update share a single tx (avoids
    // a nested writeTransaction that would split the work into two
    // commits / undo entries on PowerSync).
    let newChildId = ''
    await repo.tx(async tx => {
      newChildId = await tx.run(createChildMutator, {
        parentId: block.id,
        content: afterCursor,
        position: {kind: 'first'},
      })
      await tx.update(block.id, {content: beforeCursor})
    }, {scope: ChangeScope.BlockDefault, description: 'split top-level block'})
    return repo.block(newChildId)
  }

  // Non-top-level: core.split puts before-text in self and creates a
  // new sibling AFTER self with after-text. Pass the live before/after
  // strings — the mutator does NOT slice persisted content, since a
  // debounced editor can leave SQL stale.
  const newSiblingId = await repo.mutate.split({
    id: block.id,
    before: beforeCursor,
    after: afterCursor,
  }) as string
  return repo.block(newSiblingId)
}

const ISO_ALIAS_RE = /^\d{4}-\d{2}-\d{2}$/

const dailyNoteIsoFromBlock = (block: Block): string | null => {
  const aliases = block.peekProperty(aliasesProp) ?? []
  return aliases.find(alias => ISO_ALIAS_RE.test(alias)) ?? null
}

const findContainingDailyNoteIso = async (
  repo: Repo,
  blockId: string,
  workspaceId: string,
): Promise<string | null> => {
  const data = await repo.load(blockId, {ancestors: true})
  if (!data || data.workspaceId !== workspaceId) return null

  let block: Block | null = repo.block(blockId)
  while (block) {
    const iso = dailyNoteIsoFromBlock(block)
    if (iso) return iso
    block = block.parent
  }
  return null
}

export function getDefaultActionGroups({repo}: { repo: Repo }) {
  // Idempotent: surfaces window.__omniliner.roamImport for the agent
  // runtime / devtools console. Living here ties it to the same lifecycle
  // as the rest of the default actions — the hook gets installed once
  // per Repo.
  ensureRoamImportWindowHook(repo)
  // Same lifecycle for the metrics console hook — surfaces
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

  // Block-bound actions that operate on the focused/edited block in a
  // panel. Declared as BlockActions and bound below to both NORMAL_MODE
  // and EDIT_MODE_CM — in either context `block` is the active block
  // and `uiStateBlock` is the panel block (panel-bound).
  const zoomInBlock: BlockAction = {
    id: 'zoom_in',
    description: 'Zoom into focused block',
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      if (isMainPanel(uiStateBlock)) {
        const workspaceId = repo.activeWorkspaceId
        if (!workspaceId) return
        writeAppHash(workspaceId, block.id)
      } else {
        await uiStateBlock.set(topLevelBlockIdProp, block.id)
      }
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

      if (isMainPanel(uiStateBlock)) {
        const workspaceId = repo.activeWorkspaceId
        if (!workspaceId) return
        writeAppHash(workspaceId, parent.id)
      } else {
        await uiStateBlock.set(topLevelBlockIdProp, parent.id)
      }
    },
    defaultBinding: {
      keys: ['cmd+,', 'ctrl+,'],
    },
  }

  const openFocusedInPanelBlock: BlockAction = {
    id: 'open_focused_in_panel',
    description: 'Open focused block in a side panel',
    handler: async ({block, uiStateBlock}: BlockShortcutDependencies) => {
      window.dispatchEvent(new CustomEvent('open-panel', {
        detail: {blockId: block.id, sourcePanelId: uiStateBlock.id},
      }))
    },
    defaultBinding: {
      keys: ['cmd+shift+.', 'ctrl+shift+.'],
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
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, insertExampleExtensionsBlock),
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

  const openDailyNoteByOffset = async (offsetDays: number) => {
    const route = parseAppHash(window.location.hash)
    const workspaceId = route.workspaceId ?? repo.activeWorkspaceId
    if (!workspaceId) return

    const currentIso = route.blockId
      ? await findContainingDailyNoteIso(repo, route.blockId, workspaceId)
      : null
    const targetIso = addDaysIso(currentIso ?? todayIso(), offsetDays)
    const note = await getOrCreateDailyNote(repo, workspaceId, targetIso)
    writeAppHash(workspaceId, note.id)
  }

  const globalActions: ActionConfig<typeof ActionContextTypes.GLOBAL>[] = [
    {
      id: 'command_palette',
      description: 'Open command palette',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.dispatchEvent(new CustomEvent('toggle-command-palette'))
      },
      defaultBinding: {
        keys: ['cmd+k', 'ctrl+k'],
      },
      hideFromCommandPallet: true,
    },
    {
      id: 'quick_find',
      description: 'Find or create page or block',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.dispatchEvent(new CustomEvent('toggle-quick-find'))
      },
      defaultBinding: {
        keys: ['cmd+p', 'ctrl+p', 'cmd+shift+k', 'ctrl+shift+k'],
      },
    },
    {
      id: 'open_today',
      description: "Open today's daily note",
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        const workspaceId = repo.activeWorkspaceId
        if (!workspaceId) return
        const note = await getOrCreateDailyNote(repo, workspaceId, todayIso())
        document.location.hash = buildAppHash(workspaceId, note.id)
      },
      defaultBinding: {
        keys: ['cmd+shift+`', 'ctrl+shift+`'],
      },
    },
    {
      id: 'open_previous_daily_note',
      description: 'Open previous daily note',
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        await openDailyNoteByOffset(-1)
      },
      defaultBinding: {
        keys: ['cmd+shift+[', 'ctrl+shift+['],
      },
    },
    {
      id: 'open_next_daily_note',
      description: 'Open next daily note',
      context: ActionContextTypes.GLOBAL,
      handler: async () => {
        await openDailyNoteByOffset(1)
      },
      defaultBinding: {
        keys: ['cmd+shift+]', 'ctrl+shift+]'],
      },
    },
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
      id: 'refresh_extensions',
      description: 'Reload extensions',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        refreshAppRuntime()
        console.log('Runtime extensions reloaded')
      },
    },
    {
      id: 'restart_agent_runtime_bridge',
      description: 'Restart agent runtime bridge',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.dispatchEvent(new CustomEvent(agentRuntimeBridgeRestartEvent))
      },
    },
    {
      id: 'manage_agent_tokens',
      description: 'Manage agent runtime tokens',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        window.dispatchEvent(new CustomEvent(openAgentTokensDialogEvent))
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
                document.location.hash = buildAppHash(repo.activeWorkspaceId!, block.id)
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
      id: 'import_roam',
      description: 'Import Roam JSON export',
      context: ActionContextTypes.GLOBAL,
      handler: () => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'

        input.onchange = async (e) => {
          const file = (e.target as HTMLInputElement).files?.[0]
          if (!file) return

          const reader = new FileReader()
          reader.onload = async (loadEvent) => {
            const content = loadEvent.target?.result
            if (typeof content !== 'string') return

            const banner = showProgressBanner('Roam import: parsing JSON…')
            try {
              const parsed = JSON.parse(content) as RoamExport
              if (!Array.isArray(parsed)) {
                console.error('[roam-import] expected top-level JSON array of pages')
                banner.fail('Roam import failed: expected top-level JSON array of pages')
                return
              }

              // Prefer the URL hash over `repo.activeWorkspaceId` —
              // the hash is the source of truth for what workspace
              // the user is viewing, and `repo.activeWorkspaceId`
              // can lag behind it (the active id flips inside
              // App.tsx's async getInitialBlock chain, which awaits
              // workspace lookup + role role check before settling).
              // If the user clicks the import shortcut shortly after
              // switching workspaces, reading repo state alone would
              // route the import into the prior workspace.
              const workspaceId = parseAppHash(window.location.hash).workspaceId
                ?? repo.activeWorkspaceId
              if (!workspaceId) {
                console.error('[roam-import] no active workspace')
                banner.fail('Roam import failed: no active workspace')
                return
              }

              banner.update('Roam import: planning…')
              const summary = await importRoam(parsed, repo, {
                workspaceId,
                currentUserId: repo.user.id,
                onProgress: msg => {
                  console.log(`[roam-import] ${msg}`)
                  banner.update(`Roam import: ${msg}`)
                },
              })
              console.log('[roam-import] done', summary)
              banner.done(
                `Roam import complete: ${summary.pagesCreated} new pages, ` +
                `${summary.pagesMerged} merged, ${summary.pagesDaily} daily, ` +
                `${summary.blocksWritten} blocks (${(summary.durationMs / 1000).toFixed(1)}s)`,
              )
            } catch (err) {
              console.error('[roam-import] failed:', err)
              banner.fail(`Roam import failed: ${err instanceof Error ? err.message : String(err)}`)
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
        const banner = showProgressBanner('Exporting SQLite database…')
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

          const banner = showProgressBanner(`Importing SQLite database (${sizeMiB} MiB)…`)
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
          const blockInFocus = await splitCodeMirrorBlockAtCursor(block, editorView, isTopLevel)
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
          const prevVisible = await previousVisibleBlock(block, topLevelBlockId)
          await block.delete()
          if (prevVisible) setFocusedBlockId(uiStateBlock, prevVisible.id)
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
