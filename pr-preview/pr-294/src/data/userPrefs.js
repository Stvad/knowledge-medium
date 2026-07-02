//#region src/data/userPrefs.ts
/** Stable internal namespace for the deterministic id of the root
*  Preferences block. Two clients bootstrapping the same user must
*  agree on this so the rows converge on sync. The block's display
*  content is set separately to "Preferences" by `ensureUserPrefsChild`;
*  the block intentionally carries no type marker. */
var USER_PREFS_PATH_PART = "user-prefs";
//#endregion
export { USER_PREFS_PATH_PART };

//# sourceMappingURL=userPrefs.js.map