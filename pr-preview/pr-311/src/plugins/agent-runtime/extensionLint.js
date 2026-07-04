//#region src/plugins/agent-runtime/extensionLint.ts
var isLikelyCredentialKey = (key) => /token|secret|password|api[_-]?key|credentials?|auth/i.test(key);
var LOCALSTORAGE_SET_RE = /(?:window\.)?localStorage\s*\.\s*setItem\s*\(\s*([^,)]+)/;
var STRING_LITERAL_RE = /^\s*['"]([^'"]+)['"]\s*$/;
var DIALOG_EVENT_DISPATCH_RE = /window\s*\.\s*dispatchEvent\s*\(\s*new\s+CustomEvent\s*(?:<[^>]*>)?\s*\(\s*([^,)]+)/;
var DIALOG_INTENT_RE = /open|toggle|dialog|picker|prompt|modal/i;
var rules = [
	{
		rule: "config-in-localstorage",
		catalogPattern: "user-prefs-config",
		message: "Non-credential settings stored in localStorage. Use `getPluginPrefsBlock(repo, workspaceId, user, type)` so settings sync across the user's devices and benefit from typed property codecs. Keep credentials (tokens, API keys) in localStorage; everything else goes in a prefs block.",
		testLine(line) {
			const match = line.match(LOCALSTORAGE_SET_RE);
			if (!match) return null;
			const literalMatch = (match[1] ?? "").trim().match(STRING_LITERAL_RE);
			if (literalMatch) {
				if (isLikelyCredentialKey(literalMatch[1])) return null;
			}
			return match[0];
		}
	},
	{
		rule: "stored-plugin-block-id",
		catalogPattern: "plugin-root-singleton",
		message: "Persisting a plugin's root or per-record block id (e.g. in localStorage or a config block) means a cache clear or fresh device creates a duplicate. Derive ids deterministically with `pluginBlockId(workspaceId, NAMESPACE, key)` — same inputs always return the same id, so re-installs land on the existing block.",
		testLine(line) {
			const localStorageBlockIdMatch = line.match(/(?:window\.)?localStorage\s*\.\s*setItem\s*\(\s*['"][^'"]*(?:block[_-]?id|root[_-]?id|plugin[_-]?id)[^'"]*['"]/i);
			if (localStorageBlockIdMatch) return localStorageBlockIdMatch[0];
			return null;
		}
	},
	{
		rule: "dialog-via-window-event",
		catalogPattern: "settings-dialog",
		message: "Opening or toggling a dialog by dispatching a `window` CustomEvent (and listening for it with `window.addEventListener` inside the component) reimplements the typed dialog channel over an untyped string bus. For a one-shot prompt, `openDialog(Component, props)` returns a promise that resolves with the user's choice. For a persistent toggle surface, drive visibility from a module store read via `useSyncExternalStore` (the same mechanism the app's own DialogHost uses) and flip it directly from your action's handler. Reserve `window` CustomEvents for genuine broadcast.",
		testLine(line) {
			const match = line.match(DIALOG_EVENT_DISPATCH_RE);
			if (!match) return null;
			const eventArg = (match[1] ?? "").trim();
			if (!DIALOG_INTENT_RE.test(eventArg)) return null;
			return match[0];
		}
	}
];
var SUPPRESS_RE = /\/\/\s*lint-ok\s*:\s*([\w-]+)/;
var collectSuppressed = (source) => {
	const suppressed = /* @__PURE__ */ new Set();
	for (const line of source.split("\n")) {
		const match = line.match(SUPPRESS_RE);
		if (match?.[1]) suppressed.add(match[1]);
	}
	return suppressed;
};
/** Run all lint rules against the extension source. Returns the
*  warnings sorted by rule id for stable output across runs. */
var lintExtensionSource = (source) => {
	if (!source) return [];
	const suppressed = collectSuppressed(source);
	const warnings = [];
	const lines = source.split("\n");
	for (const rule of rules) {
		if (suppressed.has(rule.rule)) continue;
		for (const line of lines) {
			const example = rule.testLine(line);
			if (example) {
				warnings.push({
					rule: rule.rule,
					message: rule.message,
					catalogPattern: rule.catalogPattern,
					example: example.length > 120 ? `${example.slice(0, 117)}...` : example
				});
				break;
			}
		}
	}
	warnings.sort((a, b) => a.rule.localeCompare(b.rule));
	return warnings;
};
//#endregion
export { lintExtensionSource };

//# sourceMappingURL=extensionLint.js.map