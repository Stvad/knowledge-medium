import { Block } from "../../data/block.js";
import { Check } from "../../../node_modules/lucide-react/dist/esm/icons/check.js";
import { Gauge } from "../../../node_modules/lucide-react/dist/esm/icons/gauge.js";
import { RotateCcw } from "../../../node_modules/lucide-react/dist/esm/icons/rotate-ccw.js";
import { Sparkles } from "../../../node_modules/lucide-react/dist/esm/icons/sparkles.js";
import { SrsSignal } from "../srs-rescheduling/scheduler.js";
//#region src/plugins/srs-review/actions.ts
var SRS_REVIEW_CONTEXT = "srs-review";
var isSrsReviewDependencies = (deps) => typeof deps === "object" && deps !== null && "uiStateBlock" in deps && deps.uiStateBlock instanceof Block && "controller" in deps;
var srsReviewActionContext = {
	type: SRS_REVIEW_CONTEXT,
	displayName: "SRS Review",
	modal: true,
	defaultEventOptions: { preventDefault: true },
	validateDependencies: isSrsReviewDependencies
};
var controllerOf = (deps) => deps.controller;
var srsReviewActions = [{
	id: "srs-review.reveal",
	description: "SRS review: Show answer",
	context: SRS_REVIEW_CONTEXT,
	defaultBinding: { keys: ["Space", "Enter"] },
	handler: (deps) => {
		controllerOf(deps).reveal();
	}
}, ...[
	{
		signal: SrsSignal.AGAIN,
		key: "Digit1",
		label: "Again",
		icon: RotateCcw
	},
	{
		signal: SrsSignal.HARD,
		key: "Digit2",
		label: "Hard",
		icon: Gauge
	},
	{
		signal: SrsSignal.GOOD,
		key: "Digit3",
		label: "Good",
		icon: Check
	},
	{
		signal: SrsSignal.EASY,
		key: "Digit4",
		label: "Easy",
		icon: Sparkles
	}
].map(({ signal, key, label, icon }) => ({
	id: `srs-review.grade.${label.toLowerCase()}`,
	description: `SRS review: ${label}`,
	context: SRS_REVIEW_CONTEXT,
	icon,
	defaultBinding: { keys: key },
	handler: (deps) => {
		controllerOf(deps).grade(signal);
	}
}))];
//#endregion
export { SRS_REVIEW_CONTEXT, srsReviewActionContext, srsReviewActions };

//# sourceMappingURL=actions.js.map