import { hex } from "../../../node_modules/@scure/base/index.js";
//#region src/plugins/birthday/gate.ts
/** Birthday, local time. Month is 1-based here for readability; the check
*  below converts to JS's 0-based month. A date alone is not PII. */
var BIRTHDAY_MONTH = 6;
var BIRTHDAY_DAY = 23;
/** Arbitrary constant; only there to de-rainbow-table the digest. */
var WOLF_SALT = "ftm-wolf-2bf1c0";
/** SHA-256 of `WOLF_SALT + <recipient user id>`, lowercase hex. The id is
*  the Supabase auth uuid (`sessionUserToAppUser` → `session.user.id`),
*  which is what `repo.user.id` carries at runtime. */
var WOLF_USER_HASH = "23a3429659325a626c72a4f4655947f72c3a0e8742bc12883bb8ff5c912f437e";
/** Dev/preview override key. `localStorage['birthday:force'] = '1'` makes
*  both the date and recipient checks read true, so the whole celebration
*  can be exercised on any account on any day. Never set in production. */
var FORCE_KEY = "birthday:force";
async function sha256Hex(input) {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return hex.encode(new Uint8Array(digest));
}
function isForced() {
	try {
		return window.localStorage?.getItem(FORCE_KEY) === "1";
	} catch {
		return false;
	}
}
/** Local-date check (a birthday is a local-midnight thing, not UTC). */
function isBirthdayToday(now = /* @__PURE__ */ new Date()) {
	if (isForced()) return true;
	return now.getMonth() === BIRTHDAY_MONTH - 1 && now.getDate() === BIRTHDAY_DAY;
}
async function isRecipient(userId) {
	if (isForced()) return true;
	if (!userId) return false;
	try {
		return await sha256Hex(WOLF_SALT + userId) === WOLF_USER_HASH;
	} catch {
		return false;
	}
}
/** Dedup key for the once-per-cycle bits (overlay, theme activation).
*  Forced runs use a sentinel so the celebration re-fires on every reload
*  while iterating, instead of being deduped by a real year. */
function celebrationCycle(now = /* @__PURE__ */ new Date()) {
	return isForced() ? "force" : String(now.getFullYear());
}
/** Milliseconds until the next local midnight, used to re-evaluate the
*  gate when the app stays open across a day boundary (so the theme
*  activates / restores without a manual reload). */
function msUntilNextLocalMidnight(now = /* @__PURE__ */ new Date()) {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0).getTime() - now.getTime();
}
//#endregion
export { celebrationCycle, isBirthdayToday, isForced, isRecipient, msUntilNextLocalMidnight };

//# sourceMappingURL=gate.js.map