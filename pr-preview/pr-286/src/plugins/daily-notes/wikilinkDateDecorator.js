import { parseLiteralDailyPageTitle } from "../../utils/relativeDate.js";
import { CalendarDays } from "../../../node_modules/lucide-react/dist/esm/icons/calendar-days.js";
import { openDialog } from "../../utils/dialogs.js";
import { hasAnyBlockDateAdapter } from "./blockDateAdapter.js";
import { ReschedulePicker } from "./ReschedulePicker.js";
import { createElement } from "react";
//#region src/plugins/daily-notes/wikilinkDateDecorator.ts
/**
* Daily-notes contribution to `wikilinkDisplayDecoratorFacet`: prefixes
* date-shaped wikilink aliases with the weekday at render time
* ("Fri, April 26th, 2026") so date references in block content are
* scannable without changing how they're stored. The underlying alias
* — what the link resolver and Roam-style canonical alias depend on —
* is untouched.
*
* Accepts both canonical forms via `parseLiteralDailyPageTitle`:
*   - long: "April 26th, 2026"  → "Fri, April 26th, 2026"
*   - ISO:  "2026-04-26"        → "Fri, 2026-04-26"
*
* Weekday is locale-pinned to en-US to match the rest of the daily-page
* alias (also en-US). Display-time use only — never written to storage.
*/
var formatWeekday = (date) => date.toLocaleDateString("en-US", { weekday: "short" });
var rectFor = (element) => {
	const rect = element.getBoundingClientRect();
	return {
		bottom: rect.bottom,
		height: rect.height,
		left: rect.left,
		right: rect.right,
		top: rect.top,
		width: rect.width
	};
};
var rescheduleButton = ({ sourceBlock }) => {
	if (!sourceBlock) return null;
	const open = (element) => {
		openDialog(ReschedulePicker, {
			blockId: sourceBlock.id,
			anchorRect: rectFor(element)
		});
	};
	return createElement("button", {
		"aria-label": "Reschedule date",
		className: "mr-1 inline-flex h-4 w-4 align-middle items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
		"data-block-interaction": "ignore",
		onClick: (event) => {
			event.preventDefault();
			event.stopPropagation();
			open(event.currentTarget);
		},
		onMouseDown: (event) => {
			event.preventDefault();
			event.stopPropagation();
		},
		title: "Reschedule date",
		type: "button"
	}, createElement(CalendarDays, {
		"aria-hidden": true,
		size: 13,
		strokeWidth: 2
	}));
};
var dailyDateWikilinkDecorator = {
	id: "daily-notes.date-weekday-prefix",
	decorate: ({ alias, runtime, sourceBlock }) => {
		const parsed = parseLiteralDailyPageTitle(alias);
		if (!parsed) return null;
		const content = `${formatWeekday(parsed.date)}, ${alias}`;
		if (!runtime || !sourceBlock || !hasAnyBlockDateAdapter(runtime, sourceBlock)) return content;
		return {
			before: rescheduleButton({ sourceBlock }),
			content
		};
	}
};
//#endregion
export { dailyDateWikilinkDecorator };

//# sourceMappingURL=wikilinkDateDecorator.js.map