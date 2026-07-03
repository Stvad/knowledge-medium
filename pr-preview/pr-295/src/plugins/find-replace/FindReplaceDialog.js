import { cn } from "../../lib/utils.js";
import { Input } from "../../components/ui/input.js";
import { Button } from "../../components/ui/button.js";
import { FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR, FIND_REPLACE_SEARCH_CONTENT_QUERY } from "./dataExtension.js";
import { showError, showSuccess } from "../../utils/toast.js";
import { useRepo } from "../../context/repo.js";
import { Search } from "../../../node_modules/lucide-react/dist/esm/icons/search.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Label } from "../../components/ui/label.js";
import { findReplaceToggle } from "./toggleStore.js";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/find-replace/FindReplaceDialog.tsx
var DEBOUNCE_MS = 120;
var defaultOptions = {
	matchCase: false,
	wholeWord: false
};
var resultSummary = (result) => {
	const changed = `${result.replacements} replacement${result.replacements === 1 ? "" : "s"} in ${result.updatedBlocks} block${result.updatedBlocks === 1 ? "" : "s"}`;
	const skipped = result.skippedChangedBlocks + result.skippedUnavailableBlocks;
	if (skipped === 0) return changed;
	return `${changed}; ${skipped} skipped`;
};
var pluralize = (count, singular, plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
var blockMatchCountLabel = (blockCount, matchCount) => `${pluralize(blockCount, "block")} · ${pluralize(matchCount, "match", "matches")}`;
function FindReplaceDialog() {
	const repo = useRepo();
	const open = useSyncExternalStore(findReplaceToggle.subscribe, findReplaceToggle.isOpen, findReplaceToggle.isOpen);
	const [find, setFind] = useState("");
	const [replace, setReplace] = useState("");
	const [options, setOptions] = useState(defaultOptions);
	const [searchResult, setSearchResult] = useState({
		query: "",
		matches: [],
		truncated: false
	});
	const [selectedIds, setSelectedIds] = useState(() => /* @__PURE__ */ new Set());
	const [loading, setLoading] = useState(false);
	const [applying, setApplying] = useState(false);
	const trimmedFind = find.trim();
	const matches = useMemo(() => searchResult.query === trimmedFind ? searchResult.matches : [], [searchResult, trimmedFind]);
	const selectedItems = useMemo(() => matches.filter((match) => selectedIds.has(match.blockId)), [matches, selectedIds]);
	const totalMatchCount = matches.reduce((sum, match_0) => sum + match_0.matchCount, 0);
	const selectedReplacementCount = selectedItems.reduce((sum_0, match_1) => sum_0 + match_1.matchCount, 0);
	useEffect(() => {
		if (!open) return;
		const workspaceId = repo.activeWorkspaceId;
		if (!workspaceId || !trimmedFind) return;
		let cancelled = false;
		const timer = setTimeout(async () => {
			try {
				setLoading(true);
				const result = await repo.query[FIND_REPLACE_SEARCH_CONTENT_QUERY]({
					workspaceId,
					query: trimmedFind,
					options,
					maxBlocks: 500
				}).load();
				if (cancelled) return;
				setSearchResult(result);
				setSelectedIds(new Set(result.matches.map((match_2) => match_2.blockId)));
			} catch (error) {
				if (!cancelled) showError(error instanceof Error ? error.message : "Find failed");
			} finally {
				if (!cancelled) setLoading(false);
			}
		}, DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [
		open,
		options,
		repo,
		trimmedFind
	]);
	const setOption = (key, value) => {
		setOptions((current) => ({
			...current,
			[key]: value
		}));
	};
	const toggleSelected = (blockId, checked) => {
		setSelectedIds((current_0) => {
			const next = new Set(current_0);
			if (checked) next.add(blockId);
			else next.delete(blockId);
			return next;
		});
	};
	const setAllSelected = (checked_0) => {
		setSelectedIds(checked_0 ? new Set(matches.map((match_3) => match_3.blockId)) : /* @__PURE__ */ new Set());
	};
	const applyReplace = async (items) => {
		const workspaceId_0 = repo.activeWorkspaceId;
		if (!workspaceId_0 || !trimmedFind || items.length === 0 || repo.isReadOnly) return;
		setApplying(true);
		try {
			showSuccess(resultSummary(await repo.run(FIND_REPLACE_APPLY_CONTENT_REPLACE_MUTATOR, {
				workspaceId: workspaceId_0,
				find: trimmedFind,
				replace,
				options,
				items: items.map((item) => ({
					blockId: item.blockId,
					originalContent: item.originalContent
				}))
			})));
			setSearchResult({
				query: "",
				matches: [],
				truncated: false
			});
			setSelectedIds(/* @__PURE__ */ new Set());
			setFind("");
			setReplace("");
			findReplaceToggle.close();
		} catch (error_0) {
			showError(error_0 instanceof Error ? error_0.message : "Replace failed");
		} finally {
			setApplying(false);
		}
	};
	return /* @__PURE__ */ jsx(Dialog, {
		open,
		onOpenChange: findReplaceToggle.set,
		children: /* @__PURE__ */ jsxs(DialogContent, {
			className: "top-[12vh] max-h-[82vh] max-w-3xl translate-y-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4 p-0",
			children: [
				/* @__PURE__ */ jsxs(DialogHeader, {
					className: "px-5 pt-5",
					children: [/* @__PURE__ */ jsxs(DialogTitle, {
						className: "flex items-center gap-2",
						children: [/* @__PURE__ */ jsx(Search, { className: "h-4 w-4" }), "Find and replace"]
					}), /* @__PURE__ */ jsx(DialogDescription, {
						className: "sr-only",
						children: "Search block content in this workspace and review replacements before applying them."
					})]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "grid gap-3 border-b px-5 pb-4 sm:grid-cols-2",
					children: [
						/* @__PURE__ */ jsxs("div", {
							className: "grid gap-1.5",
							children: [/* @__PURE__ */ jsx(Label, {
								htmlFor: "find-replace-find",
								children: "Find"
							}), /* @__PURE__ */ jsx(Input, {
								id: "find-replace-find",
								value: find,
								autoFocus: true,
								onChange: (event) => {
									const next_0 = event.currentTarget.value;
									setFind(next_0);
									if (!next_0.trim()) {
										setSearchResult({
											query: "",
											matches: [],
											truncated: false
										});
										setSelectedIds(/* @__PURE__ */ new Set());
										setLoading(false);
									}
								},
								placeholder: "Text to find"
							})]
						}),
						/* @__PURE__ */ jsxs("div", {
							className: "grid gap-1.5",
							children: [/* @__PURE__ */ jsx(Label, {
								htmlFor: "find-replace-replace",
								children: "Replace"
							}), /* @__PURE__ */ jsx(Input, {
								id: "find-replace-replace",
								value: replace,
								onChange: (event_0) => setReplace(event_0.currentTarget.value),
								placeholder: "Replacement"
							})]
						}),
						/* @__PURE__ */ jsxs("label", {
							className: "flex items-center gap-2 text-sm",
							children: [/* @__PURE__ */ jsx(Checkbox, {
								checked: options.matchCase,
								onCheckedChange: (checked_1) => setOption("matchCase", checked_1 === true)
							}), "Match case"]
						}),
						/* @__PURE__ */ jsxs("label", {
							className: "flex items-center gap-2 text-sm",
							children: [/* @__PURE__ */ jsx(Checkbox, {
								checked: options.wholeWord,
								onCheckedChange: (checked_2) => setOption("wholeWord", checked_2 === true)
							}), "Whole word"]
						})
					]
				}),
				/* @__PURE__ */ jsxs("div", {
					className: "min-h-0 overflow-y-auto px-5",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "mb-2 flex min-h-8 items-center justify-between gap-3 text-sm text-muted-foreground",
						children: [/* @__PURE__ */ jsxs("span", { children: [loading ? "Searching..." : trimmedFind ? blockMatchCountLabel(matches.length, totalMatchCount) : "Type text to search", searchResult.truncated && " (limited)"] }), matches.length > 0 && /* @__PURE__ */ jsx(Button, {
							type: "button",
							variant: "ghost",
							size: "sm",
							onClick: () => setAllSelected(selectedIds.size !== matches.length),
							children: selectedIds.size === matches.length ? "Clear" : "Select all"
						})]
					}), /* @__PURE__ */ jsx("div", {
						className: "grid gap-2 pb-4",
						children: matches.map((match_4) => {
							const checked_3 = selectedIds.has(match_4.blockId);
							return /* @__PURE__ */ jsxs("label", {
								className: cn("grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 rounded-md border p-3 text-sm", checked_3 ? "border-primary/50 bg-accent/40" : "bg-background"),
								children: [
									/* @__PURE__ */ jsx(Checkbox, {
										checked: checked_3,
										onCheckedChange: (next_1) => toggleSelected(match_4.blockId, next_1 === true),
										className: "mt-0.5"
									}),
									/* @__PURE__ */ jsxs("span", {
										className: "min-w-0",
										children: [/* @__PURE__ */ jsx("span", {
											className: "block truncate text-foreground",
											children: match_4.preview
										}), /* @__PURE__ */ jsx("span", {
											className: "block truncate text-xs text-muted-foreground",
											children: match_4.blockId
										})]
									}),
									/* @__PURE__ */ jsxs("span", {
										className: "rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground",
										title: pluralize(match_4.matchCount, "match"),
										"aria-label": pluralize(match_4.matchCount, "match"),
										children: [match_4.matchCount, "x"]
									})
								]
							}, match_4.blockId);
						})
					})]
				}),
				/* @__PURE__ */ jsxs(DialogFooter, {
					className: "flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:space-x-0",
					children: [/* @__PURE__ */ jsxs("div", {
						className: "text-sm text-muted-foreground",
						children: ["Selected: ", blockMatchCountLabel(selectedItems.length, selectedReplacementCount)]
					}), /* @__PURE__ */ jsxs("div", {
						className: "flex flex-col-reverse gap-2 sm:flex-row sm:justify-end",
						children: [
							/* @__PURE__ */ jsx(Button, {
								type: "button",
								variant: "outline",
								onClick: () => findReplaceToggle.close(),
								children: "Cancel"
							}),
							/* @__PURE__ */ jsx(Button, {
								type: "button",
								variant: "secondary",
								disabled: repo.isReadOnly || applying || matches.length === 0,
								onClick: () => void applyReplace(matches),
								children: "Replace all shown"
							}),
							/* @__PURE__ */ jsx(Button, {
								type: "button",
								disabled: repo.isReadOnly || applying || selectedItems.length === 0,
								onClick: () => void applyReplace(selectedItems),
								children: "Replace selected"
							})
						]
					})]
				})
			]
		})
	});
}
//#endregion
export { FindReplaceDialog };

//# sourceMappingURL=FindReplaceDialog.js.map