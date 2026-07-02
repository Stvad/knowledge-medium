import { runActionById } from "../../shortcuts/runAction.js";
import { appendTodayDailyBlockInStack } from "../daily-notes/actions.js";
import { OPEN_DAILY_NOTE_PICKER_ACTION_ID } from "../daily-notes/index.js";
import { QUICK_FIND_ACTION_ID } from "../quick-find/index.js";
//#region src/plugins/app-intents/appIntents.ts
var INTENT_PARAMS = [
	"intent",
	"title",
	"text",
	"url"
];
var consumed = false;
/** Run a global action by id for a UI-only intent. The matching plugin
*  may be disabled — then the action isn't registered and
*  `runActionById` throws — so swallow + log: a launcher entry for a
*  disabled feature should be a no-op, not a crash. */
var runAppIntentAction = (actionId) => {
	try {
		const result = runActionById(actionId, new CustomEvent("app-intent"));
		Promise.resolve(result).catch((error) => {
			console.error(`[app-intents] action ${actionId} failed`, error);
		});
	} catch (error) {
		console.error(`[app-intents] action ${actionId} unavailable`, error);
	}
};
/** Test-only: reset the module-level "already handled this load" flag. */
var __resetAppIntentForTesting = () => {
	consumed = false;
};
var stripIntentParams = () => {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	let changed = false;
	for (const param of INTENT_PARAMS) if (url.searchParams.has(param)) {
		url.searchParams.delete(param);
		changed = true;
	}
	if (!changed) return;
	window.history.replaceState(null, "", url.toString());
};
/** Combine the Web Share API's title/text/url fields into a single
*  block-content string. Skips empty parts, and dedupes when the
*  same value lands in multiple fields — Android Chrome puts a
*  shared URL into `text` (not `url`) when the source page omits
*  the `url` share field, so naive concatenation would emit it
*  twice. Joins with newlines; the block editor handles multi-line
*  content. */
var formatSharedContent = (title, text, url) => {
	const parts = [];
	const seen = /* @__PURE__ */ new Set();
	const push = (value) => {
		if (!value) return;
		if (seen.has(value)) return;
		seen.add(value);
		parts.push(value);
	};
	push(title);
	push(text);
	push(url);
	return parts.join("\n");
};
var consumeAppIntent = async (repo, layoutSessionBlock) => {
	if (consumed) return;
	if (typeof window === "undefined") return;
	const params = new URLSearchParams(window.location.search);
	const intent = params.get("intent");
	const title = params.get("title");
	const text = params.get("text");
	const sharedUrl = params.get("url");
	const isShare = intent === "share" || title !== null || text !== null || sharedUrl !== null;
	const isNewBlock = intent === "new-daily-block";
	const isOpenPicker = intent === "open-picker";
	const isQuickFind = intent === "quick-find";
	if (!isShare && !isNewBlock && !isOpenPicker && !isQuickFind) return;
	consumed = true;
	if (isOpenPicker) {
		runAppIntentAction(OPEN_DAILY_NOTE_PICKER_ACTION_ID);
		stripIntentParams();
		return;
	}
	if (isQuickFind) {
		runAppIntentAction(QUICK_FIND_ACTION_ID);
		stripIntentParams();
		return;
	}
	if ((isShare ? await appendTodayDailyBlockInStack(repo, layoutSessionBlock, { content: formatSharedContent(title, text, sharedUrl) }) : await appendTodayDailyBlockInStack(repo, layoutSessionBlock)) !== null) stripIntentParams();
};
//#endregion
export { __resetAppIntentForTesting, consumeAppIntent, formatSharedContent };

//# sourceMappingURL=appIntents.js.map