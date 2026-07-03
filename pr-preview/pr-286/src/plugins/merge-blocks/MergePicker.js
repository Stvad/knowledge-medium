import { hasBlockType } from "../../data/properties.js";
import { PAGE_TYPE } from "../../data/blockTypes.js";
import { truncate } from "../../utils/string.js";
import { searchLinkTargets } from "../../utils/linkTargetAutocomplete.js";
import { useRepo } from "../../context/repo.js";
import { useNavigate } from "../../utils/navigation.js";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../components/ui/command.js";
import { pickMergeContentStrategy } from "./strategy.js";
import { useEffect, useRef, useState } from "react";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/merge-blocks/MergePicker.tsx
/**
* Picker modal for "merge this block into…". Opened via
* `openDialog(MergePicker, {sourceBlockId, workspaceId})` from the
* `merge_blocks.merge_into` action.
*
* Direction: the currently-focused block is the SOURCE (folds into the
* pick and is soft-deleted); the picked block is the TARGET. Picker
* results filter to pages only when the source is itself a page —
* otherwise the picker is more useful as an open block-search (mirrors
* `QuickFind`'s aliases + blocks groups).
*
* Content strategy is chosen at commit time by `pickMergeContentStrategy`
* (page-involving merges keep target, outline-block merges concat) so
* the kernel `core.merge` mutator stays generic.
*/
var SEARCH_LIMIT = 25;
var DEBOUNCE_MS = 80;
function MergePicker({ sourceBlockId, workspaceId, resolve, cancel }) {
	const repo = useRepo();
	const navigate = useNavigate();
	const [session, setSession] = useState(null);
	const [query, setQuery] = useState("");
	const [value, setValue] = useState("");
	const [pending, setPending] = useState(false);
	const [searchResults, setSearchResults] = useState({
		query: "",
		aliases: [],
		blocks: []
	});
	const cancelRef = useRef(cancel);
	useEffect(() => {
		cancelRef.current = cancel;
	});
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const sourceBlock = repo.block(sourceBlockId);
			const data = sourceBlock.peek() ?? await sourceBlock.load();
			if (cancelled) return;
			if (!data) {
				console.error(`[merge-blocks] source ${sourceBlockId} not found`);
				cancelRef.current();
				return;
			}
			setSession({
				sourceBlockId,
				workspaceId,
				sourceIsPage: hasBlockType(data, PAGE_TYPE)
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [
		repo,
		sourceBlockId,
		workspaceId
	]);
	const trimmedQuery = query.trim();
	useEffect(() => {
		if (!session || !trimmedQuery) return;
		let cancelled_0 = false;
		const timer = setTimeout(async () => {
			const results = await searchLinkTargets(repo, {
				workspaceId: session.workspaceId,
				query: trimmedQuery,
				limit: SEARCH_LIMIT,
				excludeBlockIds: [session.sourceBlockId]
			});
			if (cancelled_0) return;
			setSearchResults({
				query: trimmedQuery,
				aliases: results.aliases,
				blocks: results.blocks
			});
		}, DEBOUNCE_MS);
		return () => {
			cancelled_0 = true;
			clearTimeout(timer);
		};
	}, [
		session,
		trimmedQuery,
		repo
	]);
	const commit = async (targetBlockId) => {
		if (!session || pending) return;
		setPending(true);
		try {
			const sourceBlock_0 = repo.block(session.sourceBlockId);
			const targetBlock = repo.block(targetBlockId);
			const sourceData = sourceBlock_0.peek() ?? await sourceBlock_0.load();
			const targetData = targetBlock.peek() ?? await targetBlock.load();
			if (!sourceData || !targetData) {
				console.error("[merge-blocks] source or target missing at commit");
				return;
			}
			const contentStrategy = pickMergeContentStrategy(sourceData, targetData);
			await repo.mutate.merge({
				intoId: targetBlockId,
				fromId: session.sourceBlockId,
				contentStrategy
			});
			if (session.sourceIsPage) navigate({
				blockId: targetBlockId,
				target: "active"
			});
		} catch (error) {
			console.error("[merge-blocks] merge failed", error);
		} finally {
			resolve();
		}
	};
	if (!session) return null;
	const showBlocks = !session.sourceIsPage;
	const aliases = trimmedQuery && searchResults.query === trimmedQuery ? searchResults.aliases : [];
	const blocks = showBlocks && trimmedQuery && searchResults.query === trimmedQuery ? searchResults.blocks : [];
	return /* @__PURE__ */ jsxs(CommandDialog, {
		open: session !== null,
		onOpenChange: (isOpen) => {
			if (!isOpen) cancel();
		},
		title: session.sourceIsPage ? "Merge this page into…" : "Merge this block into…",
		description: session.sourceIsPage ? "Source page (with this block's content + properties) folds into the picked page; aliases union so old links keep resolving." : "This block's content + children fold into the picked block, then this block is removed.",
		contentClassName: "top-[12vh] translate-y-0",
		commandProps: {
			shouldFilter: false,
			value,
			onValueChange: setValue
		},
		children: [/* @__PURE__ */ jsx(CommandInput, {
			placeholder: session.sourceIsPage ? "Find page to merge into…" : "Find target block…",
			value: query,
			onValueChange: (nextQuery) => {
				setQuery(nextQuery);
				setValue("");
			},
			disabled: pending
		}), /* @__PURE__ */ jsxs(CommandList, { children: [
			/* @__PURE__ */ jsx(CommandEmpty, { children: trimmedQuery ? "No results." : "Type to search." }),
			aliases.length > 0 && /* @__PURE__ */ jsx(CommandGroup, {
				heading: "Pages",
				children: aliases.map((match) => /* @__PURE__ */ jsxs(CommandItem, {
					value: `page:${match.blockId}:${match.alias}`,
					onSelect: () => {
						commit(match.blockId);
					},
					disabled: pending,
					className: "flex justify-between items-center gap-2",
					children: [/* @__PURE__ */ jsx("span", {
						className: "truncate",
						children: match.alias
					}), match.content && match.content !== match.alias && /* @__PURE__ */ jsx("span", {
						className: "text-xs text-muted-foreground truncate max-w-[40%]",
						children: truncate(match.content, 50)
					})]
				}, `page:${match.blockId}:${match.alias}`))
			}),
			blocks.length > 0 && /* @__PURE__ */ jsx(CommandGroup, {
				heading: "Blocks",
				children: blocks.map((match_0) => /* @__PURE__ */ jsx(CommandItem, {
					value: `block:${match_0.blockId}`,
					onSelect: () => {
						commit(match_0.blockId);
					},
					disabled: pending,
					children: /* @__PURE__ */ jsx("span", {
						className: "truncate",
						children: truncate(match_0.content, 80)
					})
				}, `block:${match_0.blockId}`))
			})
		] })]
	});
}
//#endregion
export { MergePicker };

//# sourceMappingURL=MergePicker.js.map