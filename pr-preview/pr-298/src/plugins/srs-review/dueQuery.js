import { dailyNoteDateProp } from "../daily-notes/schema.js";
import { SRS_SM25_TYPE, srsArchivedProp, srsNextReviewDateProp } from "../srs-rescheduling/schema.js";
import "../srs-rescheduling/index.js";
//#region src/plugins/srs-review/dueQuery.ts
/** A tag id can never legitimately be this string, so a `referencedBy`
*  filter against it matches nothing. Used when a deck names a tag
*  whose page doesn't exist yet — the deck should show zero due cards,
*  not (as an unfiltered query would) every due card in the workspace. */
var UNRESOLVED_TAG_ID = "srs-review:unresolved-tag";
/** UTC midnight of the day after today's *local* calendar date. A card
*  counts as due when its next-review daily note's date is strictly
*  before this — i.e. today or any earlier day.
*
*  Daily notes store `daily-note:date` at UTC midnight of their calendar
*  day (`Date.parse(`${iso}T00:00:00Z`)`), so the cutoff has to be UTC
*  midnight too. A local-midnight cutoff would, west of UTC, encode to
*  later than tomorrow's UTC-midnight daily note and pull tomorrow's
*  cards into the deck a day early. */
var dueBoundary = (now = /* @__PURE__ */ new Date()) => {
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	tomorrow.setDate(tomorrow.getDate() + 1);
	return new Date(Date.UTC(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate()));
};
/** SRS cards due today or earlier, optionally scoped to a tag. Built
*  entirely from `core.typedBlocks`' existing capabilities:
*   - `where … target` traverses the `next-review-date` ref into its
*     daily note and compares the daily note's `daily-note:date`.
*   - `match … referencedBy` (ancestor scope) is the tag filter.
*   - archived cards are EXCLUDED rather than matched on
*     `archived: false`: most cards never set the property, and SQL's
*     `archived = 0` never matches a NULL (unset) column, so a match
*     would drop every card that's never been archived. */
var buildDueCardsQuery = ({ workspaceId, tagBlockId, scope = "ancestor", now }) => ({
	workspaceId,
	types: [SRS_SM25_TYPE],
	where: { [srsNextReviewDateProp.name]: { target: { [dailyNoteDateProp.name]: { lt: dueBoundary(now) } } } },
	exclude: [{
		scope: "self",
		where: { [srsArchivedProp.name]: true }
	}],
	...tagBlockId ? { match: [{
		scope,
		referencedBy: { id: tagBlockId }
	}] } : {},
	order: "created-asc"
});
//#endregion
export { UNRESOLVED_TAG_ID, buildDueCardsQuery, dueBoundary };

//# sourceMappingURL=dueQuery.js.map