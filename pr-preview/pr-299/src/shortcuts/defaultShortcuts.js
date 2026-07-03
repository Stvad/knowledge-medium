import { ChangeScope } from "../data/api/changeScope.js";
import "../data/api/index.js";
import { outlineRenderScopeId } from "../utils/renderScope.js";
import { activePanelIdProp, editorSelection, focusBlock, isCollapsedProp, selectionStateProp, setIsEditing, topLevelBlockIdProp } from "../data/properties.js";
import { createChild, merge, setContent } from "../data/mutators.js";
import { systemToggle } from "../facets/togglable.js";
import { actionContextsFacet, actionsFacet } from "../extensions/core.js";
import { getLayoutSessionBlock, getUserPrefsBlock } from "../data/stateBlocks.js";
import { EditorSelection } from "../../node_modules/@codemirror/state/dist/index.js";
import { acceptCompletion, completionStatus } from "../../node_modules/@codemirror/autocomplete/dist/index.js";
import { showProgress } from "../utils/toast.js";
import { refreshAppRuntime } from "../facets/runtimeEvents.js";
import { KeyboardOff } from "../../node_modules/lucide-react/dist/esm/icons/keyboard-off.js";
import { PanelRightOpen } from "../../node_modules/lucide-react/dist/esm/icons/panel-right-open.js";
import { Plus } from "../../node_modules/lucide-react/dist/esm/icons/plus.js";
import { Redo2 } from "../../node_modules/lucide-react/dist/esm/icons/redo-2.js";
import { Settings } from "../../node_modules/lucide-react/dist/esm/icons/settings.js";
import { Undo2 } from "../../node_modules/lucide-react/dist/esm/icons/undo-2.js";
import { ZoomIn } from "../../node_modules/lucide-react/dist/esm/icons/zoom-in.js";
import { ActionContextTypes } from "./types.js";
import { getLayoutSessionId } from "../utils/layoutSessionId.js";
import { getRootBlock, nextVisibleBlock, previousVisibleBlock } from "../utils/selection.js";
import { focusPropertyRow } from "../utils/propertyNavigation.js";
import { withMoveTransition } from "../utils/viewTransition.js";
import { deletePanelRow, panelBlockId, panelRowsInLayoutOrder } from "../utils/panelLayoutProjection.js";
import { navigate, navigateFromGlobalCommand } from "../utils/navigation.js";
import { cursorIsAtEnd, cursorIsAtStart, getCaretRect, isOnFirstVisualLine, isOnLastVisualLine } from "../utils/codemirror.js";
import { pasteFromClipboard } from "../paste/operations.js";
import { downloadBlob } from "../utils/downloadBlob.js";
import { chooseRawSqliteExportFile, exportRawSqliteDb, exportRawSqliteDbToFile, importRawSqliteDb, rawSqliteDbExportFilename } from "../utils/exportSqliteDb.js";
import { applyToAllBlocksInSelection, makeMultiSelect } from "./utils.js";
import { defaultActionContextConfigs } from "./defaultContexts.js";
import { importState } from "../utils/state.js";
import { structuralEditPolicyForBlock } from "../data/structuralEditPolicy.js";
import { insertExampleExtensionsUnder } from "../extensions/exampleExtensions.js";
import { copySelectedBlocksToClipboard } from "../utils/copy.js";
import { bindBlockActionContext, createSharedBlockActions, extendSelectionDown, extendSelectionUp } from "./blockActions.js";
import { ensureMetricsConsoleHook } from "../data/metricsConsoleHook.js";
import { openDialog } from "../utils/dialogs.js";
import { WipeLocalDataDialog } from "./WipeLocalDataDialog.js";
import { dialogAppMountExtension } from "../extensions/dialogAppMount.js";
import { reloadInSafeMode } from "../utils/safeMode.js";
//#region src/shortcuts/defaultShortcuts.ts
var splitCodeMirrorBlockAtCursor = async (block, editorView) => {
	const doc = editorView.state.doc;
	const cursorPos = editorView.state.selection.main.head;
	const beforeCursor = doc.sliceString(0, cursorPos);
	const afterCursor = doc.sliceString(cursorPos);
	const repo = block.repo;
	editorView.dispatch({
		changes: {
			from: 0,
			to: doc.length,
			insert: afterCursor
		},
		selection: EditorSelection.cursor(0)
	});
	await repo.mutate.split({
		id: block.id,
		before: beforeCursor,
		after: afterCursor
	});
	return block;
};
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
var splitScopeRootIntoFirstChild = async (block, editorView) => {
	const doc = editorView.state.doc;
	const cursorPos = editorView.state.selection.main.head;
	const beforeCursor = doc.sliceString(0, cursorPos);
	const afterCursor = doc.sliceString(cursorPos);
	const repo = block.repo;
	editorView.dispatch({
		changes: {
			from: 0,
			to: doc.length,
			insert: beforeCursor
		},
		selection: EditorSelection.cursor(beforeCursor.length)
	});
	return repo.tx(async (tx) => {
		await tx.run(setContent, {
			id: block.id,
			content: beforeCursor
		});
		return tx.run(createChild, {
			parentId: block.id,
			content: afterCursor,
			position: { kind: "first" },
			revealParent: true
		});
	}, {
		scope: ChangeScope.BlockDefault,
		description: "split scope root into first child"
	});
};
var CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID = "create_node_in_active_panel";
var OPEN_PREFERENCES_ACTION_ID = "open_preferences";
var RELOAD_IN_SAFE_MODE_ACTION_ID = "reload_in_safe_mode";
var createNodeInActivePanelFromGlobalContext = async (uiStateBlock) => {
	const repo = uiStateBlock.repo;
	if (repo.isReadOnly) return;
	const layoutSessionBlock = await getLayoutSessionBlock(uiStateBlock, getLayoutSessionId());
	await layoutSessionBlock.load();
	const rows = await repo.query.subtree({ id: layoutSessionBlock.id }).load();
	const panelRows = panelRowsInLayoutOrder(layoutSessionBlock.id, rows);
	const activePanelId = layoutSessionBlock.peekProperty(activePanelIdProp);
	const activePanelRow = (activePanelId ? panelRows.find((row) => row.id === activePanelId) : void 0) ?? panelRows.at(-1);
	if (!activePanelRow) return;
	const activeTopLevelBlockId = panelBlockId(activePanelRow);
	if (!activeTopLevelBlockId) return;
	const newId = await repo.mutate.createChild({
		parentId: activeTopLevelBlockId,
		position: { kind: "last" }
	});
	await focusBlock(repo.block(activePanelRow.id), newId, {
		edit: true,
		renderScopeId: outlineRenderScopeId(activeTopLevelBlockId)
	});
};
function getDefaultActionGroups({ repo }) {
	ensureMetricsConsoleHook(repo);
	const { indentBlock, outdentBlock, moveBlockUp, moveBlockDown, deleteBlock, togglePropertiesDisplay, toggleBlockCollapse, extendSelectionUp: extendSelectionUpBlock, extendSelectionDown: extendSelectionDownBlock, copyBlock, copyBlockRef, copyBlockEmbed, copyBlockContent, copyBlockLink } = createSharedBlockActions({ repo });
	const indentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, indentBlock);
	const outdentBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, outdentBlock);
	const moveBlockUpAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockUp);
	const moveBlockDownAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, moveBlockDown);
	const deleteBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, deleteBlock);
	const togglePropertiesDisplayAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, togglePropertiesDisplay);
	const toggleBlockCollapseAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, toggleBlockCollapse);
	const extendSelectionUpAction = {
		...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionUpBlock),
		defaultBinding: {
			...extendSelectionUpBlock.defaultBinding,
			keys: ["Shift+ArrowUp", "Shift+k"]
		}
	};
	const extendSelectionDownAction = {
		...bindBlockActionContext(ActionContextTypes.NORMAL_MODE, extendSelectionDownBlock),
		defaultBinding: {
			...extendSelectionDownBlock.defaultBinding,
			keys: ["Shift+ArrowDown", "Shift+j"]
		}
	};
	const copyBlockAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlock);
	const copyBlockRefAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockRef);
	const copyBlockEmbedAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockEmbed);
	const copyBlockContentAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockContent);
	const copyBlockLinkAction = bindBlockActionContext(ActionContextTypes.NORMAL_MODE, copyBlockLink);
	const zoomInBlock = {
		id: "zoom_in",
		description: "Zoom into focused block",
		icon: ZoomIn,
		handler: async ({ block, uiStateBlock }) => {
			await navigate(repo, {
				target: "panel",
				panelId: uiStateBlock.id,
				blockId: block.id,
				origin: "zoom"
			});
		},
		defaultBinding: { keys: "$mod+." }
	};
	const zoomOutBlock = {
		id: "zoom_out",
		description: "Zoom out to parent of current view",
		handler: async ({ uiStateBlock }) => {
			const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp);
			if (!topLevelBlockId) return;
			await repo.load(topLevelBlockId, { ancestors: true });
			const parent = repo.block(topLevelBlockId).parent;
			if (!parent) return;
			await navigate(repo, {
				target: "panel",
				panelId: uiStateBlock.id,
				blockId: parent.id,
				origin: "zoom"
			});
		},
		defaultBinding: { keys: "$mod+," }
	};
	const openFocusedInPanelBlock = {
		id: "open_focused_in_panel",
		description: "Open focused block in a side panel",
		icon: PanelRightOpen,
		handler: async ({ block, uiStateBlock }) => {
			navigate(repo, {
				blockId: block.id,
				target: "new-panel",
				sourcePanelId: uiStateBlock.id,
				origin: "open-in-panel"
			});
		},
		defaultBinding: { keys: "$mod+Shift+Period" }
	};
	const closeCurrentPanelBlock = {
		id: "close_current_panel",
		description: "Close current panel",
		handler: async ({ uiStateBlock }) => {
			await deletePanelRow(repo, uiStateBlock.id);
		},
		defaultBinding: {
			keys: "Control+w",
			eventOptions: { preventDefault: true }
		}
	};
	const insertExampleExtensionsBlock = {
		id: "insert_example_extensions",
		description: "Insert example extensions under current block",
		handler: async ({ block, uiStateBlock, renderScopeId }) => {
			const created = await insertExampleExtensionsUnder(block);
			if (created[0]) await focusBlock(uiStateBlock, created[0].id, { renderScopeId });
		}
	};
	const normalModeActions = [
		bindBlockActionContext(ActionContextTypes.NORMAL_MODE, zoomInBlock),
		bindBlockActionContext(ActionContextTypes.NORMAL_MODE, zoomOutBlock),
		bindBlockActionContext(ActionContextTypes.NORMAL_MODE, openFocusedInPanelBlock),
		bindBlockActionContext(ActionContextTypes.NORMAL_MODE, closeCurrentPanelBlock),
		bindBlockActionContext(ActionContextTypes.NORMAL_MODE, insertExampleExtensionsBlock),
		copyBlockAction,
		copyBlockRefAction,
		copyBlockEmbedAction,
		copyBlockContentAction,
		copyBlockLinkAction
	];
	const moveBlockUpCM = {
		...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockUp),
		id: "move_block_up_cm",
		description: "Move block up"
	};
	const moveBlockDownCM = {
		...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, moveBlockDown),
		id: "move_block_down_cm",
		description: "Move block down"
	};
	const globalActions = [
		{
			id: "undo",
			description: "Undo",
			context: ActionContextTypes.GLOBAL,
			icon: Undo2,
			handler: async () => {
				await repo.undo();
			},
			defaultBinding: {
				keys: "$mod+z",
				eventOptions: { preventDefault: true }
			}
		},
		{
			id: "redo",
			description: "Redo",
			context: ActionContextTypes.GLOBAL,
			icon: Redo2,
			handler: async () => {
				await repo.redo();
			},
			defaultBinding: {
				keys: ["$mod+Shift+z", "Control+y"],
				eventOptions: { preventDefault: true }
			}
		},
		{
			id: OPEN_PREFERENCES_ACTION_ID,
			description: "Open preferences",
			context: ActionContextTypes.GLOBAL,
			icon: Settings,
			handler: async () => {
				const workspaceId = repo.activeWorkspaceId;
				if (!workspaceId) return;
				navigateFromGlobalCommand(repo, {
					blockId: (await getUserPrefsBlock(repo, workspaceId, repo.user)).id,
					workspaceId
				});
			}
		},
		{
			id: CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID,
			description: "New node",
			context: ActionContextTypes.GLOBAL,
			icon: Plus,
			handler: async ({ uiStateBlock }) => {
				await createNodeInActivePanelFromGlobalContext(uiStateBlock);
			}
		},
		{
			id: "refresh_extensions",
			description: "Reload extensions",
			context: ActionContextTypes.GLOBAL,
			handler: () => {
				refreshAppRuntime();
				console.log("Runtime extensions reloaded");
			}
		},
		{
			id: RELOAD_IN_SAFE_MODE_ACTION_ID,
			description: "Reload in safe mode",
			context: ActionContextTypes.GLOBAL,
			handler: () => {
				reloadInSafeMode();
			}
		},
		{
			id: "export_document",
			description: "Export current document",
			context: ActionContextTypes.GLOBAL,
			handler: async ({ uiStateBlock }) => {
				await repo.load(uiStateBlock.id, { ancestors: true });
				const root = getRootBlock(repo.block(uiStateBlock.id));
				const blocks = await repo.query.subtree({ id: root.id }).load();
				const data = JSON.stringify({ blocks }, null, 2);
				const downloadLink = document.createElement("a");
				downloadLink.download = `document-state-${(/* @__PURE__ */ new Date()).toUTCString()}.json`;
				downloadLink.href = `data:application/json;charset=utf-8,${encodeURIComponent(data)}`;
				downloadLink.click();
			}
		},
		{
			id: "import_document",
			description: "Import document",
			context: ActionContextTypes.GLOBAL,
			handler: () => {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = ".json";
				input.onchange = async (e) => {
					const file = e.target.files?.[0];
					if (!file) return;
					const reader = new FileReader();
					reader.onload = async (e) => {
						const content = e.target?.result;
						if (typeof content !== "string") return;
						try {
							const block = (await importState(JSON.parse(content), repo)).values().next().value;
							if (block) navigateFromGlobalCommand(repo, { blockId: block.id });
						} catch (err) {
							console.error("Failed to import document:", err);
						}
					};
					reader.readAsText(file);
				};
				input.click();
			}
		},
		{
			id: "export_sqlite_db",
			description: "Download raw SQLite database (.db)",
			context: ActionContextTypes.GLOBAL,
			handler: async () => {
				const suggestedFilename = rawSqliteDbExportFilename(repo);
				let destination;
				try {
					destination = await chooseRawSqliteExportFile(suggestedFilename);
				} catch (err) {
					if (err instanceof DOMException && err.name === "AbortError") return;
					console.warn("[export-db] save picker unavailable; falling back to browser download:", err);
				}
				const banner = showProgress("Exporting SQLite database…");
				try {
					if (destination) {
						const { filename, size } = await exportRawSqliteDbToFile(repo, destination);
						banner.done(`Exported ${filename} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
					} else {
						const { blob, filename, cleanup } = await exportRawSqliteDb(repo);
						downloadBlob(blob, filename, cleanup);
						banner.done(`Exported ${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MiB)`);
					}
				} catch (err) {
					console.error("[export-db] failed:", err);
					banner.fail(`SQLite export failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		},
		{
			id: "import_sqlite_db",
			description: "Replace database with uploaded SQLite file (.db)",
			context: ActionContextTypes.GLOBAL,
			handler: () => {
				const input = document.createElement("input");
				input.type = "file";
				input.accept = ".db,application/vnd.sqlite3,application/octet-stream";
				input.onchange = async (e) => {
					const file = e.target.files?.[0];
					if (!file) return;
					const sizeMiB = (file.size / 1024 / 1024).toFixed(1);
					if (!window.confirm(`Replace this device's database with "${file.name}" (${sizeMiB} MiB)?\n\nAny local data not already synced to the server will be lost. The page will reload after the import.`)) return;
					const banner = showProgress(`Importing SQLite database (${sizeMiB} MiB)…`);
					try {
						await importRawSqliteDb(repo, file);
						banner.update("Import complete — reloading…");
						window.location.reload();
					} catch (err) {
						console.error("[import-db] failed:", err);
						banner.fail(`SQLite import failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				};
				input.click();
			}
		},
		{
			id: "lock_and_wipe_local_data",
			description: "Wipe local data on this device (guided)",
			context: ActionContextTypes.GLOBAL,
			handler: () => {
				openDialog(WipeLocalDataDialog, { userId: repo.user.id });
			}
		},
		{
			id: "navigate_back",
			description: "Go back in navigation history",
			context: ActionContextTypes.GLOBAL,
			handler: () => {
				window.history.back();
			},
			defaultBinding: { keys: "$mod+[" }
		},
		{
			id: "navigate_forward",
			description: "Go forward in navigation history",
			context: ActionContextTypes.GLOBAL,
			handler: () => {
				window.history.forward();
			},
			defaultBinding: { keys: "$mod+]" }
		}
	];
	const extendSelectionUpEdit = {
		...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionUpBlock, { idPrefix: "edit.cm" }),
		handler: async (deps, trigger) => {
			if (!cursorIsAtStart(deps.editorView)) return;
			if (await extendSelectionUp(deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen, true)) trigger.preventDefault();
		},
		defaultBinding: {
			keys: "Shift+ArrowUp",
			eventOptions: { preventDefault: false }
		}
	};
	const extendSelectionDownEdit = {
		...bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, extendSelectionDownBlock, { idPrefix: "edit.cm" }),
		handler: async (deps, trigger) => {
			if (!cursorIsAtEnd(deps.editorView)) return;
			if (await extendSelectionDown(deps.uiStateBlock, repo, deps.scopeRootId, deps.scopeRootForcesOpen, true)) trigger.preventDefault();
		},
		defaultBinding: {
			keys: "Shift+ArrowDown",
			eventOptions: { preventDefault: false }
		}
	};
	return {
		globalActions,
		normalModeActions,
		editModeCMActions: [
			{
				id: "exit_edit_mode_cm",
				description: "Exit edit mode",
				context: ActionContextTypes.EDIT_MODE_CM,
				icon: KeyboardOff,
				handler: async (deps) => setIsEditing(deps.uiStateBlock, false),
				defaultBinding: { keys: "Escape" }
			},
			{
				id: "collapse_block_cm",
				description: "Collapse block",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async ({ block }) => {
					if (!block) return;
					await withMoveTransition(async () => {
						await block.set(isCollapsedProp, true);
					});
				},
				defaultBinding: {
					keys: "$mod+ArrowUp",
					eventOptions: { preventDefault: true }
				}
			},
			{
				id: "expand_block_cm",
				description: "Expand block",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async ({ block }) => {
					if (!block) return;
					await withMoveTransition(async () => {
						await block.set(isCollapsedProp, false);
					});
				},
				defaultBinding: {
					keys: "$mod+ArrowDown",
					eventOptions: { preventDefault: true }
				}
			},
			{
				id: "split_block_cm",
				description: "Split block at cursor",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async (deps) => {
					const { block, editorView, uiStateBlock, scopeRootId } = deps;
					if (!block || !editorView || !uiStateBlock) return;
					if (completionStatus(editorView.state) === "active") {
						acceptCompletion(editorView);
						return;
					}
					if (!scopeRootId) return;
					const policy = await structuralEditPolicyForBlock(block, scopeRootId);
					const selection = editorView.state.selection.main;
					const doc = editorView.state.doc;
					const cursorPos = selection.head;
					const createSiblingBelow = async () => {
						const newId = await repo.mutate.createSiblingBelow({ siblingId: block.id });
						if (newId) await focusBlock(uiStateBlock, newId, {
							edit: true,
							renderScopeId: deps.renderScopeId
						});
					};
					if (cursorPos < doc.length) if (policy.isScopeRoot) {
						const childId = await splitScopeRootIntoFirstChild(block, editorView);
						await uiStateBlock.set(editorSelection, {
							blockId: childId,
							start: 0
						});
						await focusBlock(uiStateBlock, childId, {
							edit: true,
							renderScopeId: deps.renderScopeId
						});
					} else {
						const blockInFocus = await splitCodeMirrorBlockAtCursor(block, editorView);
						await uiStateBlock.set(editorSelection, {
							blockId: blockInFocus.id,
							start: 0
						});
						await focusBlock(uiStateBlock, blockInFocus.id, {
							edit: true,
							renderScopeId: deps.renderScopeId
						});
					}
					else if (cursorPos === doc.length && policy.createBelowPlacement === "child-first") {
						const newId = await repo.mutate.createChild({
							parentId: block.id,
							position: { kind: "first" },
							revealParent: true
						});
						if (newId) await focusBlock(uiStateBlock, newId, {
							edit: true,
							renderScopeId: deps.renderScopeId
						});
					} else if (editorView.state.doc.length === 0) {
						if (!(policy.canOutdent && await repo.mutate.outdent({
							id: block.id,
							scopeRootId
						}))) await createSiblingBelow();
					} else await createSiblingBelow();
				},
				defaultBinding: {
					keys: "Enter",
					eventOptions: { preventDefault: true }
				}
			},
			{
				id: "move_up_from_cm_start",
				description: "Move to previous block when cursor is at start of CodeMirror",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async (deps, trigger) => {
					const { block, editorView, uiStateBlock, scopeRootId } = deps;
					if (!block || !editorView || !uiStateBlock) return;
					if (!scopeRootId || !isOnFirstVisualLine(editorView)) return;
					const caretX = getCaretRect(editorView)?.left;
					trigger.preventDefault();
					const prevVisible = await previousVisibleBlock(block, scopeRootId);
					if (!prevVisible) return;
					if ((block.peek() ?? await block.load())?.parentId === prevVisible.id && focusPropertyRow(prevVisible.id, "last")) {
						setIsEditing(uiStateBlock, false);
						return;
					}
					await uiStateBlock.set(editorSelection, {
						blockId: prevVisible.id,
						line: "last",
						x: caretX
					});
					await focusBlock(uiStateBlock, prevVisible.id, {
						edit: true,
						renderScopeId: deps.renderScopeId
					});
				},
				defaultBinding: {
					keys: "ArrowUp",
					eventOptions: { preventDefault: false }
				}
			},
			{
				id: "move_down_from_cm_end",
				description: "Move to next block when cursor is at end of CodeMirror",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async (deps, trigger) => {
					const { block, editorView, uiStateBlock, scopeRootId } = deps;
					if (!block || !editorView || !uiStateBlock) return;
					if (!scopeRootId || !isOnLastVisualLine(editorView)) return;
					const caretX = getCaretRect(editorView)?.left;
					trigger.preventDefault();
					if (focusPropertyRow(block.id, "first")) {
						setIsEditing(uiStateBlock, false);
						return;
					}
					const nextVisible = await nextVisibleBlock(block, scopeRootId, deps.scopeRootForcesOpen);
					if (!nextVisible) return;
					await uiStateBlock.set(editorSelection, {
						blockId: nextVisible.id,
						x: caretX
					});
					await focusBlock(uiStateBlock, nextVisible.id, {
						edit: true,
						renderScopeId: deps.renderScopeId
					});
				},
				defaultBinding: { keys: "ArrowDown" }
			},
			{
				id: "move_left_from_cm_start",
				description: "Move to previous block when cursor is at start of CodeMirror",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async (deps, trigger) => {
					const { block, editorView, uiStateBlock, scopeRootId } = deps;
					if (!block || !editorView || !uiStateBlock) return;
					const selection = editorView.state.selection.main;
					if (!(selection.empty && selection.head === 0)) return;
					if (!scopeRootId) return;
					trigger.preventDefault();
					const prevVisible = await previousVisibleBlock(block, scopeRootId);
					if (!prevVisible) return;
					const prevData = await prevVisible.load();
					await uiStateBlock.set(editorSelection, {
						blockId: prevVisible.id,
						start: prevData?.content.length ?? 0
					});
					await focusBlock(uiStateBlock, prevVisible.id, {
						edit: true,
						renderScopeId: deps.renderScopeId
					});
				},
				defaultBinding: { keys: "ArrowLeft" }
			},
			{
				id: "move_right_from_cm_end",
				description: "Move to next block when cursor is at end of CodeMirror",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async (deps, trigger) => {
					const { block, editorView, uiStateBlock, scopeRootId } = deps;
					if (!block || !editorView || !uiStateBlock) return;
					const selection = editorView.state.selection.main;
					if (!(selection.empty && selection.head === editorView.state.doc.length)) return;
					if (!scopeRootId) return;
					trigger.preventDefault();
					const nextVisible = await nextVisibleBlock(block, scopeRootId, deps.scopeRootForcesOpen);
					if (!nextVisible) return;
					await uiStateBlock.set(editorSelection, {
						blockId: nextVisible.id,
						start: 0
					});
					await focusBlock(uiStateBlock, nextVisible.id, {
						edit: true,
						renderScopeId: deps.renderScopeId
					});
				},
				defaultBinding: { keys: "ArrowRight" }
			},
			{
				id: "delete_empty_block_cm",
				description: "Backspace at block start: delete empty / merge into previous",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async (deps, trigger) => {
					const { block, editorView, uiStateBlock, scopeRootId } = deps;
					if (!block || !uiStateBlock || !editorView) return;
					const sel = editorView.state.selection.main;
					if (!(sel.empty && sel.from === 0)) return;
					if (!scopeRootId) return;
					const { canMergeUp } = await structuralEditPolicyForBlock(block, scopeRootId);
					const liveContent = editorView.state.doc.toString();
					if (liveContent === "") {
						trigger.preventDefault();
						const prevVisible = await previousVisibleBlock(block, scopeRootId);
						if (prevVisible) {
							const prevData = await prevVisible.load();
							await uiStateBlock.set(editorSelection, {
								blockId: prevVisible.id,
								start: prevData?.content.length ?? 0
							});
							await focusBlock(uiStateBlock, prevVisible.id, {
								edit: true,
								renderScopeId: deps.renderScopeId
							});
						}
						await block.delete();
						return;
					}
					if (!canMergeUp) return;
					const prevVisible = await previousVisibleBlock(block, scopeRootId);
					if (!prevVisible || prevVisible.id === scopeRootId) return;
					await Promise.all([block.load(), prevVisible.load()]);
					const fromChildIds = await block.childIds.load();
					const intoHasIndependentChildren = (await prevVisible.childIds.load()).some((childId) => childId !== block.id);
					if (fromChildIds.length > 0 && intoHasIndependentChildren) return;
					trigger.preventDefault();
					const joinOffset = (prevVisible.peek()?.content ?? "").length;
					const prevId = prevVisible.id;
					await repo.tx(async (tx) => {
						await tx.update(block.id, { content: liveContent });
						await tx.run(merge, {
							intoId: prevId,
							fromId: block.id
						});
					}, {
						scope: ChangeScope.BlockDefault,
						description: "merge into previous block"
					});
					await uiStateBlock.set(editorSelection, {
						blockId: prevId,
						start: joinOffset
					});
					await focusBlock(uiStateBlock, prevId, {
						edit: true,
						renderScopeId: deps.renderScopeId
					});
				},
				defaultBinding: { keys: "Backspace" }
			},
			{
				id: "merge_next_block_cm",
				description: "Delete at block end: merge the next block into this one (CodeMirror)",
				context: ActionContextTypes.EDIT_MODE_CM,
				handler: async (deps, trigger) => {
					const { block, editorView, uiStateBlock, scopeRootId } = deps;
					if (!block || !uiStateBlock || !editorView) return;
					const sel = editorView.state.selection.main;
					if (!(sel.empty && sel.to === editorView.state.doc.length)) return;
					if (!scopeRootId) return;
					if (block.id === scopeRootId) return;
					const nextVisible = await nextVisibleBlock(block, scopeRootId, deps.scopeRootForcesOpen);
					if (!nextVisible) return;
					await Promise.all([block.load(), nextVisible.load()]);
					const intoChildIds = await block.childIds.load();
					const fromChildIds = await nextVisible.childIds.load();
					const intoHasIndependentChildren = intoChildIds.some((childId) => childId !== nextVisible.id);
					if (fromChildIds.length > 0 && intoHasIndependentChildren) return;
					trigger.preventDefault();
					const liveContent = editorView.state.doc.toString();
					const joinOffset = liveContent.length;
					const fromContent = nextVisible.peek()?.content ?? "";
					const fromId = nextVisible.id;
					editorView.dispatch({
						changes: {
							from: 0,
							to: editorView.state.doc.length,
							insert: liveContent + fromContent
						},
						selection: EditorSelection.cursor(joinOffset)
					});
					await repo.tx(async (tx) => {
						await tx.update(block.id, { content: liveContent });
						await tx.run(merge, {
							intoId: block.id,
							fromId
						});
					}, {
						scope: ChangeScope.BlockDefault,
						description: "merge next block into current"
					});
					await uiStateBlock.set(editorSelection, {
						blockId: block.id,
						start: joinOffset
					});
					await focusBlock(uiStateBlock, block.id, {
						edit: true,
						renderScopeId: deps.renderScopeId
					});
				},
				defaultBinding: { keys: "Delete" }
			},
			bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, indentBlock, { idPrefix: "edit.cm" }),
			bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, outdentBlock, { idPrefix: "edit.cm" }),
			bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, zoomInBlock, { idPrefix: "edit.cm" }),
			bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, zoomOutBlock, { idPrefix: "edit.cm" }),
			bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, openFocusedInPanelBlock, { idPrefix: "edit.cm" }),
			bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, closeCurrentPanelBlock, { idPrefix: "edit.cm" }),
			bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, insertExampleExtensionsBlock, { idPrefix: "edit.cm" }),
			moveBlockUpCM,
			moveBlockDownCM,
			extendSelectionDownEdit,
			extendSelectionUpEdit
		],
		multiSelectModeActions: [
			{
				...makeMultiSelect(extendSelectionUpAction),
				defaultBinding: {
					keys: [
						"ArrowUp",
						"k",
						"Shift+k",
						"Shift+ArrowUp"
					],
					eventOptions: { preventDefault: true }
				}
			},
			{
				...makeMultiSelect(extendSelectionDownAction),
				defaultBinding: {
					keys: [
						"ArrowDown",
						"j",
						"Shift+j",
						"Shift+ArrowDown"
					],
					eventOptions: { preventDefault: true }
				}
			},
			applyToAllBlocksInSelection(toggleBlockCollapseAction),
			applyToAllBlocksInSelection(togglePropertiesDisplayAction),
			applyToAllBlocksInSelection(indentBlockAction),
			applyToAllBlocksInSelection(outdentBlockAction, { applyInReverseOrder: true }),
			applyToAllBlocksInSelection(deleteBlockAction),
			applyToAllBlocksInSelection(moveBlockUpAction),
			applyToAllBlocksInSelection(moveBlockDownAction, { applyInReverseOrder: true }),
			{
				id: "clear_selection",
				description: "Clear selection",
				context: ActionContextTypes.MULTI_SELECT_MODE,
				handler: async (deps) => deps.uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue),
				defaultBinding: { keys: "Escape" }
			},
			{
				id: "copy_selected_blocks",
				description: "Copy selected blocks to clipboard",
				context: ActionContextTypes.MULTI_SELECT_MODE,
				handler: ({ uiStateBlock }) => copySelectedBlocksToClipboard(uiStateBlock, repo),
				defaultBinding: {
					keys: ["$mod+c", "y"],
					eventOptions: { preventDefault: true }
				}
			},
			{
				id: "cut_selected_blocks",
				description: "Cut selected blocks to clipboard",
				context: ActionContextTypes.MULTI_SELECT_MODE,
				handler: async (deps) => {
					const { uiStateBlock, selectedBlocks } = deps;
					if (!selectedBlocks.length) return;
					await copySelectedBlocksToClipboard(uiStateBlock, repo);
					await withMoveTransition(async () => {
						for (const block of selectedBlocks.toReversed()) await block.delete();
					});
					await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue);
				},
				defaultBinding: {
					keys: ["$mod+x", "d"],
					eventOptions: { preventDefault: true }
				}
			},
			{
				id: "paste_after_selection",
				description: "Paste from clipboard after selection",
				context: ActionContextTypes.MULTI_SELECT_MODE,
				handler: async (deps) => {
					const { uiStateBlock, selectedBlocks } = deps;
					const target = selectedBlocks.at(-1);
					if (!target) return;
					let pasted = [];
					await withMoveTransition(async () => {
						pasted = await pasteFromClipboard(target, repo, {
							position: "after",
							placement: "sibling",
							scopeRootId: deps.scopeRootId
						});
					});
					if (pasted[0]) {
						await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue);
						focusBlock(uiStateBlock, pasted[0].id);
					}
				},
				defaultBinding: { keys: "p" }
			},
			{
				id: "paste_before_selection",
				description: "Paste from clipboard before selection",
				context: ActionContextTypes.MULTI_SELECT_MODE,
				handler: async (deps) => {
					const { uiStateBlock, selectedBlocks } = deps;
					const target = selectedBlocks[0];
					if (!target) return;
					let pasted = [];
					await withMoveTransition(async () => {
						pasted = await pasteFromClipboard(target, repo, {
							position: "before",
							placement: "sibling",
							scopeRootId: deps.scopeRootId
						});
					});
					if (pasted[0]) {
						await uiStateBlock.set(selectionStateProp, selectionStateProp.defaultValue);
						focusBlock(uiStateBlock, pasted[0].id);
					}
				},
				defaultBinding: { keys: "Shift+p" }
			}
		]
	};
}
function getDefaultActions({ repo }) {
	const { globalActions, normalModeActions, editModeCMActions, multiSelectModeActions } = getDefaultActionGroups({ repo });
	return [
		...globalActions,
		...normalModeActions,
		...editModeCMActions,
		...multiSelectModeActions
	];
}
var defaultActionContextsExtension = systemToggle({
	id: "system:action-contexts",
	name: "Action contexts",
	description: "Registers the built-in shortcut contexts (global, normal mode, edit mode, property editing, multi-select) so activation validation remains available.",
	essential: true
}).of(defaultActionContextConfigs.map((context) => actionContextsFacet.of(context)));
function defaultActionsExtension({ repo }) {
	const { globalActions, normalModeActions, editModeCMActions, multiSelectModeActions } = getDefaultActionGroups({ repo });
	const actions = [
		...globalActions,
		...normalModeActions,
		...editModeCMActions,
		...multiSelectModeActions
	];
	return systemToggle({
		id: "system:default-actions",
		name: "Default keyboard shortcuts",
		description: "Built-in shortcuts (Enter/Tab/Cmd+K-style). Disabling removes the default bindings; user-defined ones still work."
	}).of([...actions.map((action) => actionsFacet.of(action)), dialogAppMountExtension]);
}
//#endregion
export { CREATE_NODE_IN_ACTIVE_PANEL_ACTION_ID, OPEN_PREFERENCES_ACTION_ID, RELOAD_IN_SAFE_MODE_ACTION_ID, defaultActionContextsExtension, defaultActionsExtension, getDefaultActionGroups, getDefaultActions };

//# sourceMappingURL=defaultShortcuts.js.map