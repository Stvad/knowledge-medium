import { c } from "react/compiler-runtime";
import { jsx, jsxs } from "react/jsx-runtime";
//#region src/plugins/srs-review/reviewCardLayout.tsx
/** Block-context keys the review session sets on the card it's showing
*  so the layout below can hide the answer (children) until the user
*  reveals it. Mirrors the video-player pattern: a context-gated
*  `blockLayoutFacet` contribution that self-gates on a flag the
*  surrounding surface sets, and falls through to the default layout
*  for every other block. */
var SRS_REVIEW_CARD_ID = "srsReviewCardId";
var SRS_REVIEW_REVEALED = "srsReviewRevealed";
/** Question phase: render the card's own content only, dropping the
*  children subtree (the answer). */
var QuestionOnlyLayout = (t0) => {
	const $ = c(5);
	const { Content, Shell } = t0;
	let t1;
	if ($[0] !== Content) {
		t1 = () => /* @__PURE__ */ jsx("div", {
			className: "srs-review-card-question min-w-0",
			children: /* @__PURE__ */ jsx(Content, {})
		});
		$[0] = Content;
		$[1] = t1;
	} else t1 = $[1];
	let t2;
	if ($[2] !== Shell || $[3] !== t1) {
		t2 = /* @__PURE__ */ jsx(Shell, { children: t1 });
		$[2] = Shell;
		$[3] = t1;
		$[4] = t2;
	} else t2 = $[4];
	return t2;
};
/** Answer phase: render content + the children subtree directly. We do
*  NOT fall back to the default layout here — its `Collapsible` only
*  opens for a non-collapsed or top-level block, and the review surface
*  is `isNestedSurface`, so a card that's collapsed in the outline would
*  reveal no answer at all. Rendering `Children` raw shows the answer
*  regardless of the card's stored collapse state. */
var AnswerLayout = (t0) => {
	const $ = c(6);
	const { Content, Children, Shell } = t0;
	let t1;
	if ($[0] !== Children || $[1] !== Content) {
		t1 = () => /* @__PURE__ */ jsxs("div", {
			className: "srs-review-card-answer min-w-0",
			children: [/* @__PURE__ */ jsx(Content, {}), /* @__PURE__ */ jsx(Children, {})]
		});
		$[0] = Children;
		$[1] = Content;
		$[2] = t1;
	} else t1 = $[2];
	let t2;
	if ($[3] !== Shell || $[4] !== t1) {
		t2 = /* @__PURE__ */ jsx(Shell, { children: t1 });
		$[3] = Shell;
		$[4] = t1;
		$[5] = t2;
	} else t2 = $[5];
	return t2;
};
var srsReviewCardLayoutContribution = (ctx) => {
	if (ctx.blockContext?.["srsReviewCardId"] !== ctx.block.id) return null;
	return Boolean(ctx.blockContext?.["srsReviewRevealed"]) ? {
		id: "srs-review.answer",
		label: "SRS review answer",
		render: AnswerLayout
	} : {
		id: "srs-review.question-only",
		label: "SRS review question",
		render: QuestionOnlyLayout
	};
};
//#endregion
export { SRS_REVIEW_CARD_ID, SRS_REVIEW_REVEALED, srsReviewCardLayoutContribution };

//# sourceMappingURL=reviewCardLayout.js.map