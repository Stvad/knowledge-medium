import { THEME_STORAGE_KEY } from "../theme-toggle/theme.js";
//#region src/plugins/birthday/wolfTheme.ts
var WOLF_THEME_ID = "wolf";
var PREV_KEY = "birthday:wolf:prev";
var ACTIVE_KEY = "birthday:wolf:active";
var STYLE_EL_ID = "birthday-wolf-theme";
/** Restore target of last resort, if storage was cleared mid-celebration
*  and we have no saved previous theme. Matches the app's runtime default. */
var DEFAULT_RESTORE = "sunset-warm-light";
/** Complete midnight-wolf palette. A partial token set inherits the
*  `:root` (light) default for any missing key and produces a half-lit
*  palette, so every token a default theme sets is set here too. */
var wolfTokens = {
	background: "224 47% 8%",
	foreground: "210 30% 88%",
	card: "224 44% 11%",
	"card-foreground": "210 30% 88%",
	popover: "224 44% 11%",
	"popover-foreground": "210 30% 88%",
	primary: "205 90% 72%",
	"primary-foreground": "224 47% 9%",
	secondary: "221 30% 18%",
	"secondary-foreground": "210 30% 90%",
	muted: "221 26% 16%",
	"muted-foreground": "214 22% 68%",
	accent: "250 38% 30%",
	"accent-foreground": "220 40% 92%",
	destructive: "0 62% 47%",
	"destructive-foreground": "0 0% 98%",
	border: "212 26% 30%",
	input: "214 25% 24%",
	ring: "205 90% 72%",
	link: "205 90% 76%",
	wikilink: "258 70% 80%",
	code: "221 26% 16%",
	success: "142 50% 52%",
	radius: "0.65rem",
	"chart-1": "205 90% 72%",
	"chart-2": "250 60% 70%",
	"chart-3": "190 70% 60%",
	"chart-4": "280 55% 68%",
	"chart-5": "160 50% 55%"
};
var WOLF_BULLET_CSS = `
[data-theme="${WOLF_THEME_ID}"] .bullet {
  background-color: transparent;
  position: relative;
  overflow: visible;
}
[data-theme="${WOLF_THEME_ID}"] .bullet::before {
  content: "🐺";
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  font-size: 13px;
  line-height: 1;
  pointer-events: none;
  filter: saturate(0.85);
}
[data-theme="${WOLF_THEME_ID}"] .bullet-with-children {
  border-color: transparent;
  box-shadow:
    0 0 0 1.5px hsl(var(--ring) / 0.35),
    0 0 8px 2px hsl(var(--ring) / 0.40);
}
[data-theme="${WOLF_THEME_ID}"] .bullet-with-children::before {
  font-size: 12px;
}
[data-theme="${WOLF_THEME_ID}"] .bullet-link:hover .bullet::before {
  transform: translate(-50%, -50%) scale(1.15);
}
`;
function buildWolfStylesheet() {
	return `[data-theme="${WOLF_THEME_ID}"] {\n${Object.entries(wolfTokens).map(([k, v]) => `  --${k}: ${v};`).join("\n")}\n}\n${WOLF_BULLET_CSS}`;
}
function ensureWolfStylesheet() {
	if (document.getElementById(STYLE_EL_ID)) return;
	const el = document.createElement("style");
	el.id = STYLE_EL_ID;
	el.textContent = buildWolfStylesheet();
	document.head.appendChild(el);
}
function removeWolfStylesheet() {
	document.getElementById(STYLE_EL_ID)?.remove();
}
function liveThemeId() {
	return document.documentElement.dataset.theme ?? "";
}
/** Set `data-theme` and persist it, bypassing the theme registry (wolf is
*  intentionally unregistered; restore ids are real themes whose palette
*  CSS exists regardless of registry-population order at startup). */
function setThemeId(id) {
	document.documentElement.dataset.theme = id;
	try {
		window.localStorage?.setItem(THEME_STORAGE_KEY, id);
	} catch {}
}
/** Re-apply the wolf theme on demand (the command-palette entry). Just
*  flips the live theme — it doesn't touch the pop-stack markers, so the
*  saved "restore to" theme is preserved. Safe to call any number of
*  times; the stylesheet injection is idempotent. */
function applyWolfTheme() {
	ensureWolfStylesheet();
	setThemeId(WOLF_THEME_ID);
}
function read(key) {
	try {
		return window.localStorage?.getItem(key) ?? null;
	} catch {
		return null;
	}
}
function write(key, value) {
	try {
		window.localStorage?.setItem(key, value);
	} catch {}
}
function remove(key) {
	try {
		window.localStorage?.removeItem(key);
	} catch {}
}
/**
* The whole pop-stack, idempotent and safe to call on every load (and at
* each local-midnight tick). For any non-recipient on any normal day this
* is a no-op: there's no active marker and `isBirthday` is false.
*
* @param isBirthday  recipient AND the local date is the birthday
* @param cycle       dedup key for this celebration (year, or 'force')
*/
function syncWolfTheme(isBirthday, cycle) {
	const marker = read(ACTIVE_KEY);
	if (isBirthday) {
		ensureWolfStylesheet();
		if (marker !== cycle) {
			const live = liveThemeId();
			write(PREV_KEY, live === "wolf" ? read(PREV_KEY) ?? DEFAULT_RESTORE : live);
			write(ACTIVE_KEY, cycle);
			setThemeId(WOLF_THEME_ID);
		}
		return;
	}
	if (marker) {
		if (liveThemeId() === "wolf") setThemeId(read(PREV_KEY) ?? DEFAULT_RESTORE);
		remove(ACTIVE_KEY);
		remove(PREV_KEY);
		removeWolfStylesheet();
	}
}
//#endregion
export { WOLF_THEME_ID, applyWolfTheme, syncWolfTheme };

//# sourceMappingURL=wolfTheme.js.map