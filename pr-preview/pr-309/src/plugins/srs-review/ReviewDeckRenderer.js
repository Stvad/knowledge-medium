import { getBlockTypes } from "../../data/properties.js";
import { usePropertyValue } from "../../hooks/block.js";
import { DefaultBlockRenderer } from "../../components/renderer/DefaultBlockRenderer.js";
import { reviewDeckStartedProp, reviewDeckTagProp } from "./schema.js";
import { DeckPicker } from "./DeckPicker.js";
import { ReviewSession } from "./ReviewSession.js";
import { c } from "react/compiler-runtime";
import { jsx } from "react/jsx-runtime";
//#region src/plugins/srs-review/ReviewDeckRenderer.tsx
/** Content area for a review-deck page: the deck picker until a deck is
*  started, then the review session. Keyed on the tag so picking a
*  different deck restarts the session cleanly. */
var ReviewDeckContent = (t0) => {
	const $ = c(5);
	const { block } = t0;
	const [started] = usePropertyValue(block, reviewDeckStartedProp);
	const [tagName] = usePropertyValue(block, reviewDeckTagProp);
	if (!started) {
		let t1;
		if ($[0] !== block) {
			t1 = /* @__PURE__ */ jsx(DeckPicker, { deck: block });
			$[0] = block;
			$[1] = t1;
		} else t1 = $[1];
		return t1;
	}
	let t1;
	if ($[2] !== block || $[3] !== tagName) {
		t1 = /* @__PURE__ */ jsx(ReviewSession, {
			deck: block,
			tagName
		}, tagName);
		$[2] = block;
		$[3] = tagName;
		$[4] = t1;
	} else t1 = $[4];
	return t1;
};
ReviewDeckContent.displayName = "ReviewDeckContent";
/** Outer wrapper: keep the default block frame, swap the content area
*  for the deck UI. Mirrors BlockTypeBlockRenderer / video-player. */
var SrsReviewDeckRenderer = Object.assign((props) => /* @__PURE__ */ jsx(DefaultBlockRenderer, {
	...props,
	ContentRenderer: ReviewDeckContent,
	EditContentRenderer: ReviewDeckContent
}), {
	canRender: ({ block }) => {
		const data = block.peek();
		return !!data && getBlockTypes(data).includes("srs-review-deck");
	},
	priority: () => 100
});
SrsReviewDeckRenderer.displayName = "SrsReviewDeckRenderer";
//#endregion
export { SrsReviewDeckRenderer };

//# sourceMappingURL=ReviewDeckRenderer.js.map