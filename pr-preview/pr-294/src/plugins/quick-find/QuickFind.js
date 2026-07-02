import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { activePanelIdProp, aliasesProp } from "../../data/properties.js";
import v4 from "../../../node_modules/uuid/dist/v4.js";
import { PAGE_TYPE } from "../../data/blockTypes.js";
import { cn } from "../../lib/utils.js";
import { useUser } from "../../components/Login.js";
import { getLayoutSessionBlock, getPluginUIStateBlock, getUIStateBlock, requireWorkspaceId } from "../../data/stateBlocks.js";
import { formatRoamDate } from "../../utils/dailyPage.js";
import { getOrCreateDailyNote } from "../daily-notes/dailyNotes.js";
import { truncate } from "../../utils/string.js";
import { searchLinkTargetsProgressively } from "../../utils/linkTargetAutocomplete.js";
import { parseRelativeDate, relativeDateCandidates } from "../../utils/relativeDate.js";
import { useRepo } from "../../context/repo.js";
import { usePropertyValue } from "../../hooks/block.js";
import { Search } from "../../../node_modules/lucide-react/dist/esm/icons/search.js";
import { getLayoutSessionId } from "../../utils/layoutSessionId.js";
import { useNavigate, useNavigateFromGlobalCommand } from "../../utils/navigation.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.js";
import { Kbd } from "../../components/ui/kbd.js";
import "../daily-notes/index.js";
import { quickFindToggle } from "./toggleStore.js";
import { pushRecentBlockId, quickFindUIStateType, recentBlockIdsProp } from "./recents.js";
import { nextQuickFindSelection, quickFindAliasValue, quickFindBlockValue, quickFindCreateValue, quickFindDateValue, quickFindOpenTargetFromClickModifiers, quickFindOpenTargetFromModifiers, quickFindSelectionAction } from "./selection.js";
import { Suspense, use, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { c } from "react/compiler-runtime";
import { Fragment as Fragment$1, jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/quick-find/QuickFind.tsx
var SEARCH_LIMIT = 25;
var DEBOUNCE_MS = 80;
var quickFindListValueSeparator = "";
var visuallyHiddenClassName = "absolute h-px w-px overflow-hidden whitespace-nowrap border-0 p-0 -m-px [clip:rect(0,0,0,0)]";
function QuickFindList(t0) {
	const $ = c(67);
	const { query, onQueryChange, value, onValueChange, groups, emptyMessage, onItemClickCapture, onSelect, onKeyDown, placeholder: t1 } = t0;
	const placeholder = t1 === void 0 ? "Find or create page or block..." : t1;
	const reactId = useId();
	const inputId = `${reactId}-input`;
	const labelId = `${reactId}-label`;
	const listId = `${reactId}-list`;
	const listRef = useRef(null);
	let selectableItems;
	let selectableValuesKey;
	let t2;
	if ($[0] !== groups || $[1] !== value) {
		selectableItems = groups.flatMap(_temp);
		selectableValuesKey = selectableItems.map(_temp2).join(quickFindListValueSeparator);
		let t3;
		if ($[5] !== value) {
			t3 = (item_0) => item_0.value === value;
			$[5] = value;
			$[6] = t3;
		} else t3 = $[6];
		t2 = selectableItems.findIndex(t3);
		$[0] = groups;
		$[1] = value;
		$[2] = selectableItems;
		$[3] = selectableValuesKey;
		$[4] = t2;
	} else {
		selectableItems = $[2];
		selectableValuesKey = $[3];
		t2 = $[4];
	}
	const selectedIndex = t2;
	const selectedItemId = selectedIndex === -1 ? void 0 : `${listId}-item-${selectedIndex}`;
	let t3;
	if ($[7] !== onValueChange || $[8] !== selectableItems || $[9] !== value) {
		t3 = () => {
			if (selectableItems.length === 0) {
				if (value) onValueChange("");
				return;
			}
			if (!value || !selectableItems.some((item_1) => item_1.value === value)) onValueChange(selectableItems[0].value);
		};
		$[7] = onValueChange;
		$[8] = selectableItems;
		$[9] = value;
		$[10] = t3;
	} else t3 = $[10];
	let t4;
	if ($[11] !== onValueChange || $[12] !== selectableItems || $[13] !== selectableValuesKey || $[14] !== value) {
		t4 = [
			onValueChange,
			selectableItems,
			selectableValuesKey,
			value
		];
		$[11] = onValueChange;
		$[12] = selectableItems;
		$[13] = selectableValuesKey;
		$[14] = value;
		$[15] = t4;
	} else t4 = $[15];
	useEffect(t3, t4);
	let t5;
	let t6;
	if ($[16] !== selectedItemId) {
		t5 = () => {
			if (!selectedItemId) return;
			document.getElementById(selectedItemId)?.scrollIntoView({ block: "nearest" });
		};
		t6 = [selectedItemId];
		$[16] = selectedItemId;
		$[17] = t5;
		$[18] = t6;
	} else {
		t5 = $[17];
		t6 = $[18];
	}
	useEffect(t5, t6);
	let t7;
	if ($[19] !== onValueChange || $[20] !== selectableItems) {
		t7 = (nextIndex) => {
			const nextItem = selectableItems[nextIndex];
			if (nextItem) onValueChange(nextItem.value);
		};
		$[19] = onValueChange;
		$[20] = selectableItems;
		$[21] = t7;
	} else t7 = $[21];
	const selectByIndex = t7;
	let t8;
	if ($[22] !== selectByIndex || $[23] !== selectableItems.length || $[24] !== selectedIndex) {
		t8 = (delta) => {
			if (selectableItems.length === 0) return;
			if (selectedIndex === -1) {
				selectByIndex(delta > 0 ? 0 : selectableItems.length - 1);
				return;
			}
			selectByIndex(Math.min(Math.max(selectedIndex + delta, 0), selectableItems.length - 1));
		};
		$[22] = selectByIndex;
		$[23] = selectableItems.length;
		$[24] = selectedIndex;
		$[25] = t8;
	} else t8 = $[25];
	const moveSelection = t8;
	let t9;
	if ($[26] !== moveSelection || $[27] !== onKeyDown || $[28] !== onSelect || $[29] !== selectByIndex || $[30] !== selectableItems.length || $[31] !== value) {
		t9 = (event) => {
			onKeyDown?.(event);
			if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
			if ((event.key === "n" || event.key === "j") && event.ctrlKey) {
				event.preventDefault();
				moveSelection(1);
				return;
			}
			if ((event.key === "p" || event.key === "k") && event.ctrlKey) {
				event.preventDefault();
				moveSelection(-1);
				return;
			}
			if (event.key === "ArrowDown") {
				event.preventDefault();
				if (event.metaKey) selectByIndex(selectableItems.length - 1);
				else moveSelection(1);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				if (event.metaKey) selectByIndex(0);
				else moveSelection(-1);
				return;
			}
			if (event.key === "Home") {
				event.preventDefault();
				selectByIndex(0);
				return;
			}
			if (event.key === "End") {
				event.preventDefault();
				selectByIndex(selectableItems.length - 1);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				if (value) onSelect(value);
			}
		};
		$[26] = moveSelection;
		$[27] = onKeyDown;
		$[28] = onSelect;
		$[29] = selectByIndex;
		$[30] = selectableItems.length;
		$[31] = value;
		$[32] = t9;
	} else t9 = $[32];
	const handleRootKeyDown = t9;
	let t10;
	if ($[33] !== inputId || $[34] !== labelId) {
		t10 = /* @__PURE__ */ jsx("label", {
			className: visuallyHiddenClassName,
			htmlFor: inputId,
			id: labelId,
			children: "Quick find"
		});
		$[33] = inputId;
		$[34] = labelId;
		$[35] = t10;
	} else t10 = $[35];
	let t11;
	if ($[36] === Symbol.for("react.memo_cache_sentinel")) {
		t11 = /* @__PURE__ */ jsx(Search, { className: "mr-2 h-5 w-5 shrink-0 opacity-50" });
		$[36] = t11;
	} else t11 = $[36];
	let t12;
	if ($[37] !== onQueryChange) {
		t12 = (event_0) => onQueryChange(event_0.target.value);
		$[37] = onQueryChange;
		$[38] = t12;
	} else t12 = $[38];
	let t13;
	if ($[39] !== inputId || $[40] !== labelId || $[41] !== listId || $[42] !== placeholder || $[43] !== query || $[44] !== selectedItemId || $[45] !== t12) {
		t13 = /* @__PURE__ */ jsxs("div", {
			className: "flex items-center border-b px-3",
			"data-quick-find-input-wrapper": "",
			children: [t11, /* @__PURE__ */ jsx("input", {
				"aria-activedescendant": selectedItemId,
				"aria-autocomplete": "list",
				"aria-controls": listId,
				"aria-expanded": "true",
				"aria-labelledby": labelId,
				autoComplete: "off",
				autoCorrect: "off",
				className: "flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
				"data-quick-find-input": "",
				id: inputId,
				onChange: t12,
				placeholder,
				role: "combobox",
				spellCheck: false,
				type: "text",
				value: query
			})]
		});
		$[39] = inputId;
		$[40] = labelId;
		$[41] = listId;
		$[42] = placeholder;
		$[43] = query;
		$[44] = selectedItemId;
		$[45] = t12;
		$[46] = t13;
	} else t13 = $[46];
	let t14;
	if ($[47] !== emptyMessage || $[48] !== selectableItems.length) {
		t14 = selectableItems.length === 0 && /* @__PURE__ */ jsx("div", {
			className: "py-6 text-center text-sm",
			"data-quick-find-empty": "",
			role: "presentation",
			children: emptyMessage
		});
		$[47] = emptyMessage;
		$[48] = selectableItems.length;
		$[49] = t14;
	} else t14 = $[49];
	let t15;
	if ($[50] !== groups || $[51] !== listId || $[52] !== onItemClickCapture || $[53] !== onSelect || $[54] !== onValueChange || $[55] !== value) {
		t15 = groups.map((group_0, groupIndex) => {
			if (group_0.items.length === 0) return null;
			const headingId = `${`${listId}-group-${groupIndex}`}-heading`;
			const groupStartIndex = groups.slice(0, groupIndex).reduce(_temp3, 0);
			return /* @__PURE__ */ jsxs("div", {
				className: "overflow-hidden px-2 py-1 text-foreground",
				"data-quick-find-group": "",
				role: "presentation",
				children: [/* @__PURE__ */ jsx("div", {
					"aria-hidden": "true",
					className: "px-2 py-1.5 text-xs font-medium text-muted-foreground",
					"data-quick-find-group-heading": "",
					id: headingId,
					children: group_0.heading
				}), /* @__PURE__ */ jsx("div", {
					"aria-labelledby": headingId,
					"data-quick-find-group-items": "",
					role: "group",
					children: group_0.items.map((item_2, itemIndex) => {
						const currentIndex = groupStartIndex + itemIndex;
						const selected = item_2.value === value;
						return /* @__PURE__ */ jsx("div", {
							"aria-disabled": false,
							"aria-selected": selected,
							className: cn("relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-3 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0", item_2.className),
							"data-disabled": "false",
							"data-quick-find-item": "",
							"data-selected": selected ? "true" : "false",
							"data-value": item_2.value,
							id: `${listId}-item-${currentIndex}`,
							onAuxClick: (event_1) => {
								if (event_1.button !== 1) return;
								event_1.preventDefault();
								onSelect(item_2.value);
							},
							onAuxClickCapture: (event_2) => {
								if (event_2.button === 1) onItemClickCapture?.(event_2);
							},
							onClick: () => onSelect(item_2.value),
							onClickCapture: onItemClickCapture,
							onMouseDown: _temp4,
							onPointerMove: () => onValueChange(item_2.value),
							role: "option",
							children: item_2.children
						}, item_2.key);
					})
				})]
			}, group_0.heading);
		});
		$[50] = groups;
		$[51] = listId;
		$[52] = onItemClickCapture;
		$[53] = onSelect;
		$[54] = onValueChange;
		$[55] = value;
		$[56] = t15;
	} else t15 = $[56];
	let t16;
	if ($[57] !== listId || $[58] !== selectedItemId || $[59] !== t14 || $[60] !== t15) {
		t16 = /* @__PURE__ */ jsxs("div", {
			"aria-activedescendant": selectedItemId,
			"aria-label": "Suggestions",
			className: "max-h-[300px] overflow-y-auto overflow-x-hidden",
			"data-quick-find-list": "",
			id: listId,
			ref: listRef,
			role: "listbox",
			tabIndex: -1,
			children: [t14, t15]
		});
		$[57] = listId;
		$[58] = selectedItemId;
		$[59] = t14;
		$[60] = t15;
		$[61] = t16;
	} else t16 = $[61];
	let t17;
	if ($[62] !== handleRootKeyDown || $[63] !== t10 || $[64] !== t13 || $[65] !== t16) {
		t17 = /* @__PURE__ */ jsxs("div", {
			className: "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
			"data-quick-find-root": "",
			onKeyDown: handleRootKeyDown,
			tabIndex: -1,
			children: [
				t10,
				t13,
				t16
			]
		});
		$[62] = handleRootKeyDown;
		$[63] = t10;
		$[64] = t13;
		$[65] = t16;
		$[66] = t17;
	} else t17 = $[66];
	return t17;
}
function _temp4(event_3) {
	return event_3.preventDefault();
}
function _temp3(total, previousGroup) {
	return total + previousGroup.items.length;
}
function _temp2(item) {
	return item.value;
}
function _temp(group) {
	return group.items;
}
function QuickFind() {
	const $ = c(2);
	const open = useSyncExternalStore(quickFindToggle.subscribe, quickFindToggle.isOpen, quickFindToggle.isOpen);
	if (!open) return null;
	let t0;
	if ($[0] !== open) {
		t0 = /* @__PURE__ */ jsx(Suspense, {
			fallback: null,
			children: /* @__PURE__ */ jsx(QuickFindResources, {
				open,
				onOpenChange: quickFindToggle.set
			})
		});
		$[0] = open;
		$[1] = t0;
	} else t0 = $[1];
	return t0;
}
function QuickFindResources(t0) {
	const $ = c(11);
	const { open, onOpenChange } = t0;
	const repo = useRepo();
	const user = useUser();
	let t1;
	if ($[0] !== repo) {
		t1 = requireWorkspaceId(repo, "QuickFind");
		$[0] = repo;
		$[1] = t1;
	} else t1 = $[1];
	const workspaceId = t1;
	let t2;
	if ($[2] !== repo || $[3] !== user || $[4] !== workspaceId) {
		t2 = (async () => {
			const rootUIStateBlock = await getUIStateBlock(repo, workspaceId, user, {});
			const [quickFindUIStateBlock, layoutSessionBlock] = await Promise.all([getPluginUIStateBlock(repo, workspaceId, user, quickFindUIStateType), getLayoutSessionBlock(rootUIStateBlock, getLayoutSessionId())]);
			return {
				quickFindUIStateBlock,
				layoutSessionBlock
			};
		})();
		$[2] = repo;
		$[3] = user;
		$[4] = workspaceId;
		$[5] = t2;
	} else t2 = $[5];
	const { quickFindUIStateBlock: quickFindUIStateBlock_0, layoutSessionBlock: layoutSessionBlock_0 } = use(t2);
	let t3;
	if ($[6] !== layoutSessionBlock_0 || $[7] !== onOpenChange || $[8] !== open || $[9] !== quickFindUIStateBlock_0) {
		t3 = /* @__PURE__ */ jsx(QuickFindDialog, {
			open,
			onOpenChange,
			quickFindUIStateBlock: quickFindUIStateBlock_0,
			layoutSessionBlock: layoutSessionBlock_0
		});
		$[6] = layoutSessionBlock_0;
		$[7] = onOpenChange;
		$[8] = open;
		$[9] = quickFindUIStateBlock_0;
		$[10] = t3;
	} else t3 = $[10];
	return t3;
}
function QuickFindDialog(t0) {
	const $ = c(113);
	const { open, onOpenChange, quickFindUIStateBlock, layoutSessionBlock } = t0;
	const repo = useRepo();
	const navigate = useNavigate();
	const navigateFromGlobalCommand = useNavigateFromGlobalCommand();
	const [activePanelId] = usePropertyValue(layoutSessionBlock, activePanelIdProp);
	const [recentIds] = usePropertyValue(quickFindUIStateBlock, recentBlockIdsProp);
	const [query, setQuery] = useState("");
	const [value, setValue] = useState("");
	let t1;
	if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
		t1 = {
			query: "",
			aliases: [],
			blocks: []
		};
		$[0] = t1;
	} else t1 = $[0];
	const [searchResults, setSearchResults] = useState(t1);
	const pendingClickTarget = useRef(null);
	let t2;
	if ($[1] !== query) {
		t2 = query.trim();
		$[1] = query;
		$[2] = t2;
	} else t2 = $[2];
	const trimmedQuery = t2;
	let t3;
	if ($[3] !== trimmedQuery) {
		t3 = trimmedQuery ? parseRelativeDate(trimmedQuery) : null;
		$[3] = trimmedQuery;
		$[4] = t3;
	} else t3 = $[4];
	const parsedDate = t3;
	let t4;
	if ($[5] !== trimmedQuery) {
		t4 = trimmedQuery ? relativeDateCandidates(trimmedQuery) : [];
		$[5] = trimmedQuery;
		$[6] = t4;
	} else t4 = $[6];
	const dateCandidates = t4;
	let t5;
	if ($[7] !== dateCandidates) {
		t5 = dateCandidates.map(_temp5);
		$[7] = dateCandidates;
		$[8] = t5;
	} else t5 = $[8];
	const dateValues = t5;
	let t6;
	if ($[9] !== searchResults || $[10] !== trimmedQuery) {
		t6 = trimmedQuery && searchResults.query === trimmedQuery ? searchResults.aliases : [];
		$[9] = searchResults;
		$[10] = trimmedQuery;
		$[11] = t6;
	} else t6 = $[11];
	const aliases = t6;
	let t7;
	if ($[12] !== searchResults || $[13] !== trimmedQuery) {
		t7 = trimmedQuery && searchResults.query === trimmedQuery ? searchResults.blocks : [];
		$[12] = searchResults;
		$[13] = trimmedQuery;
		$[14] = t7;
	} else t7 = $[14];
	const blocks = t7;
	let t8;
	if ($[15] === Symbol.for("react.memo_cache_sentinel")) {
		t8 = [];
		$[15] = t8;
	} else t8 = $[15];
	const [recents, setRecents] = useState(t8);
	let t10;
	let t9;
	if ($[16] !== dateValues || $[17] !== open || $[18] !== recentIds || $[19] !== repo || $[20] !== trimmedQuery) {
		t9 = () => {
			if (!open) return;
			const workspaceId = repo.activeWorkspaceId;
			if (!workspaceId) return;
			if (!trimmedQuery) return;
			let cancelled = false;
			const timer = setTimeout(async () => {
				await searchLinkTargetsProgressively(repo, {
					workspaceId,
					query: trimmedQuery,
					limit: SEARCH_LIMIT,
					recentBlockIds: recentIds ?? void 0
				}, {
					onAliases: (aliasResults) => {
						if (cancelled) return;
						setSearchResults({
							query: trimmedQuery,
							aliases: aliasResults,
							blocks: []
						});
						setValue((current) => nextQuickFindSelection({
							query: trimmedQuery,
							aliases: aliasResults,
							blocks: [],
							dateValues,
							currentValue: current
						}));
					},
					onBlocks: (blockResults, results) => {
						if (cancelled) return;
						setSearchResults({
							query: trimmedQuery,
							aliases: results.aliases,
							blocks: blockResults
						});
						setValue((current_0) => nextQuickFindSelection({
							query: trimmedQuery,
							aliases: results.aliases,
							blocks: blockResults,
							dateValues,
							currentValue: current_0
						}));
					}
				});
			}, DEBOUNCE_MS);
			return () => {
				cancelled = true;
				clearTimeout(timer);
			};
		};
		t10 = [
			open,
			trimmedQuery,
			dateValues,
			repo,
			recentIds
		];
		$[16] = dateValues;
		$[17] = open;
		$[18] = recentIds;
		$[19] = repo;
		$[20] = trimmedQuery;
		$[21] = t10;
		$[22] = t9;
	} else {
		t10 = $[21];
		t9 = $[22];
	}
	useEffect(t9, t10);
	let t11;
	let t12;
	if ($[23] !== open || $[24] !== recentIds || $[25] !== repo) {
		t11 = () => {
			if (!open) return;
			let cancelled_0 = false;
			const ids = recentIds ?? [];
			const load = async () => {
				const items = [];
				for (const id of ids) {
					const data = await repo.load(id);
					if (!data) continue;
					const blockAliases = data.properties[aliasesProp.name] ?? [];
					items.push({
						blockId: id,
						label: blockAliases[0] ?? data.content ?? id
					});
				}
				if (!cancelled_0) setRecents(items);
			};
			load();
			return () => {
				cancelled_0 = true;
			};
		};
		t12 = [
			open,
			recentIds,
			repo
		];
		$[23] = open;
		$[24] = recentIds;
		$[25] = repo;
		$[26] = t11;
		$[27] = t12;
	} else {
		t11 = $[26];
		t12 = $[27];
	}
	useEffect(t11, t12);
	let t13;
	if ($[28] !== activePanelId || $[29] !== navigate || $[30] !== navigateFromGlobalCommand || $[31] !== onOpenChange || $[32] !== quickFindUIStateBlock || $[33] !== repo.activeWorkspaceId) {
		t13 = (blockId, target) => {
			if (!repo.activeWorkspaceId) return;
			pushRecentBlockId(quickFindUIStateBlock, blockId);
			if (target === "stack") navigate({
				blockId,
				target: "sidebar-stack",
				sourcePanelId: activePanelId
			});
			else if (target === "new-panel") navigate({
				blockId,
				target: "new-panel",
				sourcePanelId: activePanelId
			});
			else navigateFromGlobalCommand({ blockId });
			onOpenChange(false);
		};
		$[28] = activePanelId;
		$[29] = navigate;
		$[30] = navigateFromGlobalCommand;
		$[31] = onOpenChange;
		$[32] = quickFindUIStateBlock;
		$[33] = repo.activeWorkspaceId;
		$[34] = t13;
	} else t13 = $[34];
	const openResolvedBlock = t13;
	let t14;
	if ($[35] !== openResolvedBlock || $[36] !== repo) {
		t14 = async (alias, target_0) => {
			const workspaceId_0 = repo.activeWorkspaceId;
			if (!workspaceId_0) return;
			const trimmed = alias.trim();
			if (!trimmed) return;
			const existing = await repo.query.aliasLookup({
				workspaceId: workspaceId_0,
				alias: trimmed
			}).load();
			if (existing) {
				openResolvedBlock(existing.id, target_0);
				return;
			}
			const newId = v4();
			const typeSnapshot = repo.snapshotTypeRegistries();
			await repo.tx(async (tx) => {
				await tx.create({
					id: newId,
					workspaceId: workspaceId_0,
					parentId: null,
					orderKey: "a0",
					content: trimmed
				});
				await repo.addTypeInTx(tx, newId, PAGE_TYPE, { [aliasesProp.name]: [trimmed] }, typeSnapshot);
			}, {
				scope: ChangeScope.BlockDefault,
				description: "create page from QuickFind"
			});
			openResolvedBlock(newId, target_0);
		};
		$[35] = openResolvedBlock;
		$[36] = repo;
		$[37] = t14;
	} else t14 = $[37];
	const createPage = t14;
	let t15;
	if ($[38] !== openResolvedBlock || $[39] !== repo) {
		t15 = async (iso, target_1) => {
			const workspaceId_1 = repo.activeWorkspaceId;
			if (!workspaceId_1) return;
			openResolvedBlock((await getOrCreateDailyNote(repo, workspaceId_1, iso)).id, target_1);
		};
		$[38] = openResolvedBlock;
		$[39] = repo;
		$[40] = t15;
	} else t15 = $[40];
	const openDailyNote = t15;
	let t16;
	if ($[41] !== createPage || $[42] !== openDailyNote || $[43] !== openResolvedBlock) {
		t16 = (selectedValue, target_2) => {
			const action = quickFindSelectionAction(selectedValue, target_2);
			if (!action) return;
			if (action.kind === "create-page") {
				createPage(action.alias, action.target);
				return;
			}
			if (action.kind === "open-date") {
				openDailyNote(action.iso, action.target);
				return;
			}
			openResolvedBlock(action.blockId, action.target);
		};
		$[41] = createPage;
		$[42] = openDailyNote;
		$[43] = openResolvedBlock;
		$[44] = t16;
	} else t16 = $[44];
	const handleSelect = t16;
	let t17;
	if ($[45] !== handleSelect || $[46] !== value) {
		t17 = (event) => {
			if (event.key !== "Enter") return;
			const target_3 = quickFindOpenTargetFromModifiers(event);
			if (target_3 === "jump") return;
			event.preventDefault();
			event.stopPropagation();
			if (value) handleSelect(value, target_3);
		};
		$[45] = handleSelect;
		$[46] = value;
		$[47] = t17;
	} else t17 = $[47];
	const handleKeyDown = t17;
	let t18;
	if ($[48] === Symbol.for("react.memo_cache_sentinel")) {
		t18 = (event_0) => {
			pendingClickTarget.current = quickFindOpenTargetFromClickModifiers(event_0);
		};
		$[48] = t18;
	} else t18 = $[48];
	const handleItemClickCapture = t18;
	let t19;
	if ($[49] !== handleSelect) {
		t19 = (selectedValue_0) => {
			const target_4 = pendingClickTarget.current ?? "jump";
			pendingClickTarget.current = null;
			handleSelect(selectedValue_0, target_4);
		};
		$[49] = handleSelect;
		$[50] = t19;
	} else t19 = $[50];
	const handleItemSelect = t19;
	let t20;
	if ($[51] !== aliases || $[52] !== trimmedQuery) {
		let t21;
		if ($[54] !== trimmedQuery) {
			t21 = (match) => match.alias.toLowerCase() === trimmedQuery.toLowerCase();
			$[54] = trimmedQuery;
			$[55] = t21;
		} else t21 = $[55];
		t20 = aliases.some(t21);
		$[51] = aliases;
		$[52] = trimmedQuery;
		$[53] = t20;
	} else t20 = $[53];
	const exactAliasMatch = t20;
	const showCreate = trimmedQuery.length > 0 && !exactAliasMatch && !parsedDate;
	const showRecents = !trimmedQuery && recents.length > 0;
	let groups;
	if ($[56] !== aliases || $[57] !== blocks || $[58] !== dateCandidates || $[59] !== dateValues || $[60] !== recents || $[61] !== showCreate || $[62] !== showRecents || $[63] !== trimmedQuery) {
		groups = [];
		if (showRecents) {
			let t21;
			if ($[65] !== recents) {
				t21 = recents.map(_temp6);
				$[65] = recents;
				$[66] = t21;
			} else t21 = $[66];
			let t22;
			if ($[67] !== t21) {
				t22 = {
					heading: "Recent",
					items: t21
				};
				$[67] = t21;
				$[68] = t22;
			} else t22 = $[68];
			groups.push(t22);
		}
		if (dateCandidates.length > 0) {
			let t21;
			if ($[69] !== dateCandidates || $[70] !== dateValues || $[71] !== trimmedQuery) {
				let t22;
				if ($[73] !== dateValues || $[74] !== trimmedQuery) {
					t22 = (candidate_0, index) => {
						const detail = candidate_0.phrase.toLowerCase() === trimmedQuery.toLowerCase() ? candidate_0.iso : candidate_0.phrase;
						return {
							key: `date:${candidate_0.iso}:${candidate_0.phrase}`,
							value: dateValues[index] ?? quickFindDateValue(candidate_0.iso),
							className: "flex justify-between items-center gap-2",
							children: /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx("span", {
								className: "truncate",
								children: formatRoamDate(candidate_0.date)
							}), /* @__PURE__ */ jsx("span", {
								className: "text-xs text-muted-foreground",
								children: detail
							})] })
						};
					};
					$[73] = dateValues;
					$[74] = trimmedQuery;
					$[75] = t22;
				} else t22 = $[75];
				t21 = dateCandidates.map(t22);
				$[69] = dateCandidates;
				$[70] = dateValues;
				$[71] = trimmedQuery;
				$[72] = t21;
			} else t21 = $[72];
			let t22;
			if ($[76] !== t21) {
				t22 = {
					heading: "Date",
					items: t21
				};
				$[76] = t21;
				$[77] = t22;
			} else t22 = $[77];
			groups.push(t22);
		}
		if (aliases.length > 0) {
			let t21;
			if ($[78] !== aliases) {
				t21 = aliases.map(_temp7);
				$[78] = aliases;
				$[79] = t21;
			} else t21 = $[79];
			let t22;
			if ($[80] !== t21) {
				t22 = {
					heading: "Pages",
					items: t21
				};
				$[80] = t21;
				$[81] = t22;
			} else t22 = $[81];
			groups.push(t22);
		}
		if (blocks.length > 0) {
			let t21;
			if ($[82] !== blocks) {
				t21 = blocks.map(_temp8);
				$[82] = blocks;
				$[83] = t21;
			} else t21 = $[83];
			let t22;
			if ($[84] !== t21) {
				t22 = {
					heading: "Blocks",
					items: t21
				};
				$[84] = t21;
				$[85] = t22;
			} else t22 = $[85];
			groups.push(t22);
		}
		if (showCreate) {
			const t21 = `create:${trimmedQuery}`;
			let t22;
			if ($[86] !== trimmedQuery) {
				t22 = quickFindCreateValue(trimmedQuery);
				$[86] = trimmedQuery;
				$[87] = t22;
			} else t22 = $[87];
			let t23;
			if ($[88] !== trimmedQuery) {
				t23 = /* @__PURE__ */ jsxs("span", { children: [
					"Create page “",
					trimmedQuery,
					"”"
				] });
				$[88] = trimmedQuery;
				$[89] = t23;
			} else t23 = $[89];
			let t24;
			if ($[90] !== t21 || $[91] !== t22 || $[92] !== t23) {
				t24 = {
					heading: "Create",
					items: [{
						key: t21,
						value: t22,
						children: t23
					}]
				};
				$[90] = t21;
				$[91] = t22;
				$[92] = t23;
				$[93] = t24;
			} else t24 = $[93];
			groups.push(t24);
		}
		$[56] = aliases;
		$[57] = blocks;
		$[58] = dateCandidates;
		$[59] = dateValues;
		$[60] = recents;
		$[61] = showCreate;
		$[62] = showRecents;
		$[63] = trimmedQuery;
		$[64] = groups;
	} else groups = $[64];
	let t21;
	let t22;
	if ($[94] === Symbol.for("react.memo_cache_sentinel")) {
		t21 = /* @__PURE__ */ jsx(DialogTitle, {
			className: "sr-only",
			children: "Quick find"
		});
		t22 = /* @__PURE__ */ jsx(DialogDescription, {
			className: "sr-only",
			children: "Find or create a page or block by alias or content."
		});
		$[94] = t21;
		$[95] = t22;
	} else {
		t21 = $[94];
		t22 = $[95];
	}
	const t23 = trimmedQuery ? "No results." : "Type to search.";
	let t24;
	if ($[96] === Symbol.for("react.memo_cache_sentinel")) {
		t24 = (nextQuery) => {
			setQuery(nextQuery);
			setValue("");
		};
		$[96] = t24;
	} else t24 = $[96];
	let t25;
	if ($[97] !== groups || $[98] !== handleItemSelect || $[99] !== handleKeyDown || $[100] !== query || $[101] !== t23 || $[102] !== value) {
		t25 = /* @__PURE__ */ jsx(QuickFindList, {
			emptyMessage: t23,
			groups,
			onItemClickCapture: handleItemClickCapture,
			onKeyDown: handleKeyDown,
			onQueryChange: t24,
			onSelect: handleItemSelect,
			onValueChange: setValue,
			query,
			value
		});
		$[97] = groups;
		$[98] = handleItemSelect;
		$[99] = handleKeyDown;
		$[100] = query;
		$[101] = t23;
		$[102] = value;
		$[103] = t25;
	} else t25 = $[103];
	let t26;
	if ($[104] === Symbol.for("react.memo_cache_sentinel")) {
		t26 = /* @__PURE__ */ jsxs("span", {
			className: "flex items-center gap-1",
			children: [/* @__PURE__ */ jsx(Kbd, { children: "↵" }), " jump"]
		});
		$[104] = t26;
	} else t26 = $[104];
	let t27;
	if ($[105] === Symbol.for("react.memo_cache_sentinel")) {
		t27 = /* @__PURE__ */ jsxs("span", {
			className: "flex items-center gap-1",
			children: [/* @__PURE__ */ jsx(Kbd, { children: "⇧↵" }), " open in stack"]
		});
		$[105] = t27;
	} else t27 = $[105];
	let t28;
	if ($[106] === Symbol.for("react.memo_cache_sentinel")) {
		t28 = /* @__PURE__ */ jsxs("div", {
			className: "flex justify-end gap-3 border-t px-3 py-2 text-xs text-muted-foreground",
			children: [
				t26,
				t27,
				/* @__PURE__ */ jsxs("span", {
					className: "flex items-center gap-1",
					children: [/* @__PURE__ */ jsx(Kbd, { children: "⇧⌥↵" }), " new panel"]
				})
			]
		});
		$[106] = t28;
	} else t28 = $[106];
	let t29;
	if ($[107] !== t25) {
		t29 = /* @__PURE__ */ jsxs(DialogContent, {
			className: "top-[12vh] translate-y-0 overflow-hidden p-0",
			children: [
				t21,
				t22,
				t25,
				t28
			]
		});
		$[107] = t25;
		$[108] = t29;
	} else t29 = $[108];
	let t30;
	if ($[109] !== onOpenChange || $[110] !== open || $[111] !== t29) {
		t30 = /* @__PURE__ */ jsx(Dialog, {
			open,
			onOpenChange,
			children: t29
		});
		$[109] = onOpenChange;
		$[110] = open;
		$[111] = t29;
		$[112] = t30;
	} else t30 = $[112];
	return t30;
}
function _temp8(match_1) {
	return {
		key: `block:${match_1.blockId}`,
		value: quickFindBlockValue(match_1),
		children: /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: truncate(match_1.content, 80)
		})
	};
}
function _temp7(match_0) {
	return {
		key: `page:${match_0.blockId}:${match_0.alias}`,
		value: quickFindAliasValue(match_0),
		className: "flex justify-between items-center gap-2",
		children: /* @__PURE__ */ jsxs(Fragment$1, { children: [/* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: match_0.alias
		}), match_0.content && match_0.content !== match_0.alias && /* @__PURE__ */ jsx("span", {
			className: "text-xs text-muted-foreground truncate max-w-[40%]",
			children: truncate(match_0.content, 50)
		})] })
	};
}
function _temp6(item) {
	return {
		key: `recent:${item.blockId}`,
		value: `recent:${item.blockId}`,
		className: "flex justify-between items-center",
		children: /* @__PURE__ */ jsx("span", {
			className: "truncate",
			children: truncate(item.label, 80)
		})
	};
}
function _temp5(candidate) {
	return quickFindDateValue(candidate.iso);
}
//#endregion
export { QuickFind, QuickFindList };

//# sourceMappingURL=QuickFind.js.map