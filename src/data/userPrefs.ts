/** Stable internal namespaces for the deterministic ids of the two state
 *  roots hanging directly off a user page. Two clients bootstrapping the
 *  same user must agree on these so the rows converge on sync. Display
 *  content is set separately by `ensureUserPrefsChild` / `ensureUiChild`;
 *  the blocks intentionally carry no type marker.
 *
 *  Kept in this dependency-free module (not in `stateBlocks.ts`, which
 *  pulls in `Block`/`Repo`) so the kernel query layer can derive the same
 *  ids without an import cycle. */
export const USER_PREFS_PATH_PART = 'user-prefs'
export const UI_STATE_PATH_PART = 'ui-state'

/** Every direct child a user page gets from the state bootstrap. These
 *  two roots are what "app-owned state" means structurally — everything
 *  else (panels, layout sessions, per-plugin prefs and ui-state, records
 *  filed under them) hangs BELOW one of them, while a block the user
 *  authors on their own page hangs off the page directly and is ordinary
 *  content. `userStateRootBlockIds` turns this list into the ids the
 *  Recents filter walks down from, so a THIRD root added to
 *  `stateBlocks.ts` must be added here or it will read as user activity. */
export const USER_STATE_ROOT_PATHS: readonly string[] = [
  UI_STATE_PATH_PART,
  USER_PREFS_PATH_PART,
]
