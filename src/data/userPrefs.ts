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

/** The state roots `stateBlocks.ts` puts under a user page. Everything it
 *  owns — panels, layout sessions, per-plugin prefs and ui-state, records
 *  filed under them — hangs BELOW one of these, while a block the user
 *  authors on their own page hangs off the page directly and is ordinary
 *  content. `userStateRootBlockIds` turns this list into the ids the
 *  Recents filter walks down from.
 *
 *  KNOWN INCOMPLETE, and not fixable by extending this list: a PLUGIN can
 *  put its own state under the user page on a namespace of its own
 *  (`left-sidebar`'s Shortcuts subtree does), and core may not name a
 *  plugin's ids — that is the kernel/plugin boundary, not an oversight.
 *  Such a subtree reads as user activity in Recents. Closing it needs the
 *  producer to MARK its state rather than the reader to enumerate them;
 *  see the discussion on #575 before adding a special case here. */
export const USER_STATE_ROOT_PATHS: readonly string[] = [
  UI_STATE_PATH_PART,
  USER_PREFS_PATH_PART,
]
