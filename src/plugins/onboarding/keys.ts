// How the Tutorial names keys and gestures, per variant.
//
// Two variants exist so we don't clutter every block with "press z (vim)
// / click the chevron (no vim)". Vim is opt-in (off by default), so a
// fresh workspace's [[Tutorial]] bullet resolves to the default variant
// that matches the shipped keymap. Phrasing that differs between the two
// lives in `vimKeys` / `defaultKeys`; chords that are the same in both
// live in `sharedKeys`.
//
// Accuracy invariant: nothing ties these strings to the action registry,
// so every key/command named here is documentation that can silently rot.
// When editing, verify the binding in `src/shortcuts/defaultShortcuts.ts`
// (or the owning plugin) first — and remember the ⌘K palette only lists
// actions whose CONTEXT is active. With vim off NORMAL_MODE never
// activates, so the default variant must not route NORMAL_MODE-bound
// actions through the palette (the bullet's right-click menu, edit-mode
// chords, and the multi-select keys are the non-vim paths; MULTI_SELECT_MODE
// and EDIT_MODE_CM stay palette-reachable without vim).
//
// `Cmd+X` chords are $mod-bound (Ctrl on Linux/Windows — the Welcome bullet
// sets that convention once); chords written with a bare `Ctrl` are literal
// Control on every platform, so don't add "(Ctrl on …)" glosses here — a
// parenthesized Ctrl alternative reads as a literal-Ctrl chord under the
// convention and becomes wrong on a Mac.

export const vimKeys = {
  fold: 'with the block focused, press `z` (or `Shift+Z` to collapse the current block into its parent and jump up to it)',
  edit: 'press `i` (or `a` to enter at end of line, or double-click / tap the block). Stop editing with `Esc`',
  newBelow: 'press `o` (`Shift+O` creates above). If the block\'s children are showing, the new one lands as its first child. While editing any block, `Enter` splits it / creates the next one.',
  move: '`j` / `k` (or arrow keys)',
  panelHop: '`h` to the panel on the left, `l` to the right (or arrow keys)',
  firstLast: 'To the first / last block in the panel: `gg` / `Shift+G`.',
  jumpMany: 'Jump by ~8 bullets: `Ctrl+d` / `Ctrl+u` (down / up).',
  moveBlock: 'focus it and press `Cmd+Shift+K` / `Cmd+Shift+J` (or `Cmd+Shift+↑` / `Cmd+Shift+↓`)',
  startSelect: 'Press `Space` (or `v`) to select the focused bullet; `Shift+J` / `Shift+K` then grow the selection down / up — the first press selects the current block, each next press adds the neighbour',
  delete: 'press `d d`, `Delete`, or `Backspace`; to remove several at once, select them first (see **Select many blocks**) and press `Delete`',
  cut: 'focus a block and press `Cmd+X` — or select several (see above) and press `d` or `Cmd+X`',
  properties: 'press `t` on the focused block',
  copyRef: 'focus the block and press `y r` (yank reference); `y e` yanks an embed, `y y` the whole subtree, `y c` just this block\'s text, `y l` a shareable link',
  paste: '`p` pastes after the focused block, `Shift+P` before',
  undo: '`u` (or `Cmd+Z` anywhere)',
  redo: '`Ctrl+R` (or `Cmd+Shift+Z` anywhere)',
  // Availability caveats that only the default variant needs — with vim on,
  // normal mode makes the zoom/panel chords work outside the editor too.
  zoomNote: '',
  panelKeysNote: '',
  // SRS grading actions are registered in NORMAL_MODE *and* EDIT_MODE_CM
  // (srs-rescheduling/index.ts), so both variants get the chord — only the
  // "when it fires" phrasing differs.
  srsGrade: 'press `Ctrl+Shift+1`–`4` (Again / Hard / Good / Easy) with the block focused or while editing it',
  dateScrub: 'Scrub a date in place: focus a dated block and **hold `s`**. While held, `k` / `↑` move the date +1 day and `j` / `↓` −1 day; `l` / `→` +7 days and `h` / `←` −7 days. Release `s` to commit, `Esc` to cancel.',
  extractTypePath: 'focus the block and press `Cmd+K`',
  refDemoCopy: 'focus me and press `y r` / `y e`',
  colemakNote: ' A nested **Colemak movement keybindings** toggle under it remaps the movement keys for Colemak layouts.',
  // `annotations.commentOnBlock` is NORMAL_MODE; the edit-mode action comments
  // on the whole block when the selection is empty.
  commentOnBlock: 'focus the block and press `Ctrl+Shift+/` (while editing with nothing selected, the same chord works), or right-click its bullet → **Comment**',
  toggleThreads: '`Ctrl+Shift+M` (with the block focused or while editing it)',
  // `htmlDocument.insert-example` is bound in NORMAL_MODE and EDIT_MODE_CM.
  insertHtmlExample: 'focus a block (or edit one) and run **Insert example HTML document** from the command palette',
  askAgent: 'run **Ask Agent about this block** from the command palette with the block focused',
}

export type TutorialKeys = typeof vimKeys

export const defaultKeys: TutorialKeys = {
  fold: 'while editing, `Cmd+Up` collapses the block and `Cmd+Down` expands it — or click the `▸` / `▾` chevron that appears next to the bullet on hover once a block has children (on touch it stays visible, and the block\'s swipe menu has a **Collapse** item)',
  // A plain click edits in the default config; double-click-to-edit is a
  // vim-only gesture (it exists because vim makes single-click just focus).
  edit: 'click anywhere in its text and type. Stop editing with `Esc`',
  newBelow: 'press `Enter` at the end of a bullet to create one below; if that bullet\'s children are showing, the new block lands as its first child. (`Shift+Enter` inserts a line break inside the block instead.)',
  // Block motion in non-vim mode happens *while editing*: at a block edge
  // the arrow keys hop to the neighbouring block (there's no focused-but-
  // not-editing "normal mode" without vim).
  move: 'while editing, `↑` / `↓` — at the top/bottom line they hop to the block above / below (`←` / `→` at the very start / end of the text hop too). Vim mode lets you move between blocks with `j` / `k` without entering the editor',
  // No keyboard panel-hop without vim (`h`/`l` are vim normal-mode keys);
  // arrows move between blocks, not panels.
  panelHop: 'click into the panel you want (keyboard panel-hop needs vim mode)',
  firstLast: '',
  jumpMany: '',
  moveBlock: 'while editing, `Cmd+Shift+↑` / `Cmd+Shift+↓` (with several blocks selected, the same chord moves the whole selection)',
  startSelect: 'While editing, `Shift+↓` / `Shift+↑` at a block edge first select the current block, then extend the selection down / up with each further press',
  delete: 'select it (or several — see **Select many blocks**) and press `Delete`; `Backspace` at the start of an empty block removes it, and at the start of a non-empty one merges its text into the block above',
  // `cut_block` (one focused block) is NORMAL_MODE; without vim the cut is
  // the multi-select one.
  cut: 'select the blocks (see above) and press `Cmd+X` or `d`',
  // NOT the command palette: with vim off, NORMAL_MODE never activates, so
  // "Toggle block properties" never appears in ⌘K. The bullet context menu
  // and the multi-select `t` are the paths that actually work.
  properties: 'right-click the block\'s bullet and pick **Show Properties** (or select the block — see **Select many blocks** — and press `t`)',
  // The swipe quick-actions menu is touch-only; on desktop the per-block
  // menu is the bullet's right-click context menu.
  copyRef: 'right-click the block\'s bullet → **Copy Block Ref** / **Copy Block Embed**; keyboard yanks (`y r` / `y e`) need vim mode',
  paste: '`Cmd+V` while editing pastes at the caret (multi-line text splits into blocks); to paste copied *blocks* after the current one, press `Esc` first, then `Cmd+V`. With blocks selected, `p` / `Shift+P` paste after / before the selection',
  undo: '`Cmd+Z`',
  redo: '`Cmd+Shift+Z`',
  zoomNote: ' Without vim mode these chords fire while editing — from anywhere, clicking a block\'s bullet zooms into it (or right-click the bullet → **Zoom In**).',
  panelKeysNote: ' Without vim mode these chords fire while you\'re editing a block.',
  srsGrade: 'press `Ctrl+Shift+1`–`4` (Again / Hard / Good / Easy) while editing the block',
  dateScrub: '**Scrub a date in place** — nudge a dated block\'s date forward or back without retyping it. This one\'s a vim-mode perk: with vim on, focus the date and **hold `s`**, moving by day (`j` / `k`) or week (`h` / `l`). On a phone, a two-finger horizontal drag does it with no vim needed.',
  extractTypePath: 'turn on vim mode, then focus the block and press `Cmd+K` (desktop) or open the swipe menu\'s **Commands** (touch)',
  refDemoCopy: 'right-click my bullet → **Copy Block Ref** / **Copy Block Embed**',
  colemakNote: '',
  commentOnBlock: 'right-click its bullet → **Comment**, or edit it and press `Ctrl+Shift+/` with nothing selected',
  toggleThreads: '`Ctrl+Shift+M` while editing the block',
  insertHtmlExample: 'edit any block and run **Insert example HTML document** from the command palette',
  askAgent: 'edit the block and run **Ask Agent about this block** from the command palette',
}

export const sharedKeys = {
  zoomIn: '`Cmd+.`',
  zoomOut: '`Cmd+,`',
  openInPanel: '`Cmd+Shift+.`',
  closePanel: '`Ctrl+W`',
  maximizePanel: '`Cmd+Shift+\\`',
  commandPalette: '`Cmd+K`',
  quickFind: '`Cmd+P`',
  findReplace: '`Cmd+Shift+F`',
  back: '`Cmd+[` / `Cmd+]`',
  help: '`?` (when you\'re not typing) or `Cmd+/` (anywhere)',
  createLink: '`Cmd+Shift+L`',
  // Daily-note shortcuts use literal Ctrl on every platform (not $mod) so
  // they don't clash with the browser's Cmd+Shift+[/] tab switching.
  // Double-backtick delimiters with inner spaces — the only form that
  // renders a code span containing a lone backtick (a 1-backtick opener
  // can't close over it and eats the next span instead).
  today: '`` Ctrl+Shift+` `` (every platform)',
  prevNextDay: '`Ctrl+Shift+[` / `Ctrl+Shift+]`',
  newDailyBlock: '`Ctrl+Shift+N`',
  srsReview: '`Ctrl+Shift+R`',
  // Annotation chords are literal Control (`actions.ts` in annotations).
  comment: '`Ctrl+Shift+/`',
  highlight: '`Ctrl+Shift+H`',
  suggest: '`Ctrl+Shift+S`',
}
