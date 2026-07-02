import { ChangeScope } from "../../data/api/changeScope.js";
import "../../data/api/index.js";
import { cn } from "../../lib/utils.js";
import { useRepo } from "../../context/repo.js";
import { Layers } from "../../../node_modules/lucide-react/dist/esm/icons/layers.js";
import { Tag } from "../../../node_modules/lucide-react/dist/esm/icons/tag.js";
import { usePluginPrefsProperty } from "../../data/globalState.js";
import { blockTaggingPrefsType, blockTagsConfigProp, normalizeBlockTagsConfig } from "../block-tagging/config.js";
import { reviewDeckStartedProp, reviewDeckTagProp } from "./schema.js";
import { useDueCards } from "./useDueCards.js";
import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/srs-review/DeckPicker.tsx
var startDeck = async (deck, tagName) => {
	await deck.repo.tx(async (tx) => {
		await tx.setProperty(deck.id, reviewDeckTagProp, tagName);
		await tx.setProperty(deck.id, reviewDeckStartedProp, true);
	}, {
		scope: ChangeScope.BlockDefault,
		description: "start srs review deck"
	});
};
var DeckOption = (t0) => {
	const $ = c(17);
	const { workspaceId, tagName, label, icon: Icon, onPick } = t0;
	const count = useDueCards(workspaceId, tagName).length;
	const t1 = count > 0 ? "border-border bg-background hover:bg-muted" : "border-border/60 bg-background text-muted-foreground hover:bg-muted";
	let t2;
	if ($[0] !== t1) {
		t2 = cn("flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors", t1);
		$[0] = t1;
		$[1] = t2;
	} else t2 = $[1];
	let t3;
	if ($[2] !== Icon) {
		t3 = /* @__PURE__ */ jsx(Icon, { className: "h-4 w-4 shrink-0" });
		$[2] = Icon;
		$[3] = t3;
	} else t3 = $[3];
	let t4;
	if ($[4] !== label) {
		t4 = /* @__PURE__ */ jsx("span", {
			className: "flex-1 truncate font-medium",
			children: label
		});
		$[4] = label;
		$[5] = t4;
	} else t4 = $[5];
	const t5 = count > 0 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground";
	let t6;
	if ($[6] !== t5) {
		t6 = cn("rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums", t5);
		$[6] = t5;
		$[7] = t6;
	} else t6 = $[7];
	let t7;
	if ($[8] !== count || $[9] !== t6) {
		t7 = /* @__PURE__ */ jsxs("span", {
			className: t6,
			children: [count, " due"]
		});
		$[8] = count;
		$[9] = t6;
		$[10] = t7;
	} else t7 = $[10];
	let t8;
	if ($[11] !== onPick || $[12] !== t2 || $[13] !== t3 || $[14] !== t4 || $[15] !== t7) {
		t8 = /* @__PURE__ */ jsxs("button", {
			type: "button",
			onClick: onPick,
			className: t2,
			children: [
				t3,
				t4,
				t7
			]
		});
		$[11] = onPick;
		$[12] = t2;
		$[13] = t3;
		$[14] = t4;
		$[15] = t7;
		$[16] = t8;
	} else t8 = $[16];
	return t8;
};
/** Deck selection surface shown by the deck renderer until a deck is
*  started. Lists an "all due" deck plus every tag in the workspace's
*  curated tag list, each with a live due count. */
var DeckPicker = (t0) => {
	const $ = c(26);
	const { deck } = t0;
	const repo = useRepo();
	let t1;
	if ($[0] !== deck || $[1] !== repo) {
		t1 = deck.peek()?.workspaceId ?? repo.activeWorkspaceId ?? "";
		$[0] = deck;
		$[1] = repo;
		$[2] = t1;
	} else t1 = $[2];
	const workspaceId = t1;
	const [storedTags] = usePluginPrefsProperty(blockTaggingPrefsType, blockTagsConfigProp);
	let t2;
	if ($[3] !== storedTags) {
		t2 = normalizeBlockTagsConfig(storedTags);
		$[3] = storedTags;
		$[4] = t2;
	} else t2 = $[4];
	const tags = t2;
	let t3;
	if ($[5] === Symbol.for("react.memo_cache_sentinel")) {
		t3 = /* @__PURE__ */ jsxs("div", { children: [/* @__PURE__ */ jsx("h2", {
			className: "text-lg font-semibold",
			children: "Spaced repetition review"
		}), /* @__PURE__ */ jsx("p", {
			className: "text-sm text-muted-foreground",
			children: "Pick a deck to review cards due today or earlier."
		})] });
		$[5] = t3;
	} else t3 = $[5];
	let t4;
	if ($[6] !== deck) {
		t4 = () => void startDeck(deck, "");
		$[6] = deck;
		$[7] = t4;
	} else t4 = $[7];
	let t5;
	if ($[8] !== t4 || $[9] !== workspaceId) {
		t5 = /* @__PURE__ */ jsx(DeckOption, {
			workspaceId,
			tagName: "",
			label: "All due cards",
			icon: Layers,
			onPick: t4
		});
		$[8] = t4;
		$[9] = workspaceId;
		$[10] = t5;
	} else t5 = $[10];
	let t6;
	if ($[11] !== deck || $[12] !== tags || $[13] !== workspaceId) {
		let t7;
		if ($[15] !== deck || $[16] !== workspaceId) {
			t7 = (tag) => /* @__PURE__ */ jsx(DeckOption, {
				workspaceId,
				tagName: tag,
				label: tag,
				icon: Tag,
				onPick: () => void startDeck(deck, tag)
			}, tag);
			$[15] = deck;
			$[16] = workspaceId;
			$[17] = t7;
		} else t7 = $[17];
		t6 = tags.map(t7);
		$[11] = deck;
		$[12] = tags;
		$[13] = workspaceId;
		$[14] = t6;
	} else t6 = $[14];
	let t7;
	if ($[18] !== t5 || $[19] !== t6) {
		t7 = /* @__PURE__ */ jsxs("div", {
			className: "space-y-2",
			children: [t5, t6]
		});
		$[18] = t5;
		$[19] = t6;
		$[20] = t7;
	} else t7 = $[20];
	let t8;
	if ($[21] !== tags.length) {
		t8 = tags.length === 0 && /* @__PURE__ */ jsx("p", {
			className: "text-sm text-muted-foreground",
			children: "No tags configured yet. Add tag names under the \"Tags\" entry in Preferences to review tag-scoped decks, or start with all due cards above."
		});
		$[21] = tags.length;
		$[22] = t8;
	} else t8 = $[22];
	let t9;
	if ($[23] !== t7 || $[24] !== t8) {
		t9 = /* @__PURE__ */ jsxs("div", {
			className: "mx-auto w-full max-w-xl space-y-4 py-4",
			children: [
				t3,
				t7,
				t8
			]
		});
		$[23] = t7;
		$[24] = t8;
		$[25] = t9;
	} else t9 = $[25];
	return t9;
};
//#endregion
export { DeckPicker };

//# sourceMappingURL=DeckPicker.js.map