// Data definition of the starter Tutorial subtree. `seedTutorial` walks
// the returned forest and emits one `tx.create` per node (plus an
// `addTypeInTx` when `type` is set), so the entire Tutorial — vim and
// non-vim variants — is authored here without touching the seed
// machinery.
//
// Two variants exist so we don't clutter every block with "press z (vim)
// / click the chevron (no vim)" — vim is the default plugin, so a
// fresh workspace's [[Tutorial]] bullet resolves to the vim variant.
// The non-vim variant lives at the alias `Tutorial (no vim)` and the
// first bullet on each page cross-links to the other.

import {
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { exampleExtensions } from '@/extensions/exampleExtensions.ts'

export type TutorialNode = {
  content: string
  /** Property overrides set directly on the row at create time. */
  properties?: Record<string, unknown>
  /** When set, the seeder emits an `addTypeInTx` call. */
  type?: string
  /** Property overrides passed to `addTypeInTx` (e.g. `aliases`). */
  typeProperties?: Record<string, unknown>
  children?: TutorialNode[]
}

export type TutorialVariant = 'vim' | 'default'

export const TUTORIAL_VIM_TITLE = 'Tutorial'
export const TUTORIAL_DEFAULT_TITLE = 'Tutorial (no vim)'
export const EXTENSIONS_PAGE_TITLE = 'extensions'

// Per-variant phrasing for the keys / clicks that *differ* between vim
// and default modes. Shortcuts that are global (Cmd+K, Cmd+., etc.)
// live in `sharedKeys` below and are reused across variants.
const vimKeys = {
  fold: 'press `z`',
  edit: 'press `i` (or `a` to enter at the end of the line)',
  exitEdit: 'press `Esc`',
  newBelow: 'press `o` (or `Shift+O` to create above)',
  enterCreates: '— or, while editing any block, press `Enter` to split / create a new one',
  move: '`j` / `k` (or arrow keys)',
  panelHop: '`h` / `l` (or arrow keys)',
  firstLast: '`gg` jumps to the first visible bullet, `Shift+G` to the last',
  jumpMany: '`Ctrl+d` / `Ctrl+u` jump down / up by ~8 bullets',
  startSelect: 'press `Space` (or `v`) on the focused bullet to start a selection',
  delete: 'press `d` (or `Delete`)',
  properties: 'press `t`',
  paste: '`p` pastes after the focused block, `Shift+P` before',
  undo: '`u` (or `Cmd+Z` anywhere)',
  redo: '`Ctrl+R` (or `Cmd+Shift+Z` anywhere)',
}

const defaultKeys: typeof vimKeys = {
  fold: 'click the `▸` / `▾` chevron that appears next to my bullet on hover (it stays visible on touch devices)',
  edit: 'click anywhere in my text',
  exitEdit: 'press `Esc`',
  newBelow: 'press `Enter` at the end of a bullet to create a new one below (`Shift+Enter` inserts a line break inside)',
  enterCreates: '',
  move: 'arrow keys (`↑` / `↓`)',
  panelHop: 'arrow keys (`←` / `→`)',
  firstLast: '',
  jumpMany: '',
  startSelect: 'use `Shift+↑` / `Shift+↓` from any focused block — selection extends from there',
  delete: 'press `Delete` (or `Backspace` at the start of an empty block)',
  properties: 'open the command palette with `Cmd+K` and run "Toggle properties"',
  paste: '`Cmd+V` — pastes after the focused block',
  undo: '`Cmd+Z`',
  redo: '`Cmd+Shift+Z`',
}

const sharedKeys = {
  zoomIn: '`Cmd+.` (`Ctrl+.` on Linux/Windows)',
  zoomOut: '`Ctrl+,`',
  openInPanel: '`Cmd+Shift+.` (`Ctrl+Shift+.`)',
  closePanel: '`Ctrl+W`',
  commandPalette: '`Cmd+K` (`Ctrl+K`)',
  quickFind: '`Cmd+P` (`Ctrl+P`)',
  findReplace: '`Cmd+Shift+F` (`Ctrl+Shift+F`)',
  back: '`Cmd+[` / `Cmd+]` (`Ctrl+[` / `Ctrl+]`)',
  today: '`Cmd+Shift+`` ` (`Ctrl+Shift+`` `)',
  prevNextDay: '`Cmd+Shift+[` / `Cmd+Shift+]`',
  appendToday: '`Ctrl+Shift+N`',
  prefs: '`Cmd+,` (`Ctrl+,`)',
  copyRef: '`Alt+Y`',
  copyEmbed: '`Shift+Y`',
}

/**
 * Returns the ordered list of top-level children for a Tutorial page.
 * The page itself (`Tutorial` or `Tutorial (no vim)`) is created by
 * `seedTutorial`; this outline plugs in beneath it.
 */
export const tutorialOutline = (variant: TutorialVariant): TutorialNode[] => {
  const km = variant === 'vim' ? vimKeys : defaultKeys
  const altLabel =
    variant === 'vim'
      ? 'Prefer mouse / arrow keys instead of vim shortcuts? See [[Tutorial (no vim)]].'
      : 'Prefer vim shortcuts? See [[Tutorial]].'

  return [
    { content: altLabel },

    sect('Welcome', [
      'This is a malleable thought medium. Every line below is a **block** you can fold, link, drag around, and extend — including this tutorial itself.',
      'Bullets are blocks. Bullets nest. Everything else builds on that.',
      "Don't just read — try the keys/clicks on each bullet as you go. Edit anything; this tutorial is just blocks in your workspace.",
    ]),

    sect('Try the basics', [
      'Press `Tab` to indent me under the bullet above (`Shift+Tab` to outdent). Try it now.',
      `New block: ${km.newBelow}${km.enterCreates ? ' ' + km.enterCreates : ''}.`,
      {
        content: `Fold a block's children: ${km.fold} with that block focused. Try folding the bullet below.`,
        children: [
          { content: "I'll vanish when my parent is folded. Fold the parent again to bring me back." },
          { content: 'A folded parent shows a halo around its bullet so you can spot it from a distance.' },
        ],
      },
      `Edit a block: ${km.edit}. Exit editing: ${km.exitEdit}.`,
      `Delete a block: ${km.delete}.`,
    ]),

    sect('Move around', [
      `Between blocks: ${km.move}.`,
      `Between side-by-side panels: ${km.panelHop}.`,
      ...(km.firstLast ? [km.firstLast] : []),
      ...(km.jumpMany ? [km.jumpMany] : []),
      `Zoom into a block (treat it as the new root of the view): ${sharedKeys.zoomIn}. Zoom back out: ${sharedKeys.zoomOut}.`,
      `Open a block in a new side panel (without leaving where you are): ${sharedKeys.openInPanel}. Close current panel: ${sharedKeys.closePanel}.`,
      `Back / forward through your navigation history: ${sharedKeys.back}.`,
    ]),

    sect('Multi-select', [
      `${cap(km.startSelect)}.`,
      'Then `Tab`, fold, `Delete`, copy, paste, move — every block-level action applies to the whole selection.',
      'Press `Esc` to clear the selection.',
    ]),

    sect('Pages & links', [
      '`[[Tutorial]]` is a wiki link — anything in `[[double brackets]]` navigates to (or creates) a page with that name. Try clicking one.',
      `Find or create any page: ${sharedKeys.quickFind}. Type to filter; pressing Enter on a missing name creates it.`,
      `Command palette: ${sharedKeys.commandPalette}. **Every** action in the app is searchable here with its key shown — use this when you forget a shortcut, or to find actions that have no default binding.`,
      `Find and replace across the workspace: ${sharedKeys.findReplace}.`,
    ]),

    sect('Properties & types', [
      `Properties are typed key/value pairs attached to any block. To open the properties panel on a focused block: ${km.properties}.`,
      'Try giving me a property — e.g. `priority: high`. It will appear under my content.',
      "Types attach behavior to a block via the special `types` property. `types = ['page']` makes a block a page (parent-less, alias-resolvable). `types = ['extension']` makes it an extension — see below.",
      'Aliases (a list property on a page) let you reach the page from multiple names — including ones with spaces or different casing. Wiki links resolve through aliases.',
    ]),

    sect('Daily notes', [
      `Open today's daily note: ${sharedKeys.today}. This is also the default landing page on a fresh open.`,
      `Step through daily notes: ${sharedKeys.prevNextDay} (previous / next).`,
      `Quick capture: ${sharedKeys.appendToday} appends a fresh block to today's daily note in a side panel, without taking you away from where you are.`,
    ]),

    sect('Undo, redo, copy, paste', [
      `Undo: ${km.undo}. Redo: ${km.redo}.`,
      `Copy a *reference* to a block (a clickable \`[[…]]\` link pointing at it): ${sharedKeys.copyRef}. Copy an *embed* (the block rendered inline elsewhere): ${sharedKeys.copyEmbed}.`,
      `Paste blocks: ${km.paste}.`,
    ]),

    sect('Preferences & toggles', [
      `Open preferences: ${sharedKeys.prefs}.`,
      "Open **Extensions settings** from the command palette — every extension can be toggled on or off there. Vim mode itself is an extension (`system:vim-normal-mode`); disable it to switch this tutorial's shortcuts to the non-vim ones.",
    ]),

    sect('Extensions', [
      "**Everything** in this app — the renderer, the vim plugin, daily notes — is an extension. You can author your own; the host loads them out of `types = ['extension']` blocks.",
      'See [[extensions]] for explanatory bullets, a set of working example extensions, and a renderer demo to enable and play with.',
    ]),
  ]
}

// Helper: a section header bullet with string children, normalized to
// TutorialNode shape.
const sect = (
  title: string,
  children: ReadonlyArray<string | TutorialNode>,
): TutorialNode => ({
  content: title,
  children: children.map(c => (typeof c === 'string' ? { content: c } : c)),
})

const cap = (s: string) => (s.length === 0 ? s : s[0].toUpperCase() + s.slice(1))

/**
 * Children of the shared, parent-less `extensions` page. Lives outside
 * the per-variant Tutorial outline because both Tutorial variants link
 * to it via `[[extensions]]` — a single source of truth instead of
 * duplicating the seven example sources under each Tutorial. The page
 * itself is seeded by `seedTutorial`.
 */
export const extensionsPageOutline = (): TutorialNode[] => [
  { content: '**Anything** in this app is an extension — the default block renderer, the vim plugin, daily notes, find-and-replace. The host loads core ones at startup; the rest are blocks like the ones below.' },
  { content: "An extension block is a block with `types = ['extension']`. Its content is a TS/JSX module whose `default` export is an `AppExtension` — a `FacetContribution`, an array of them, or a function returning one. Imports resolve through the page-global importmap, so `@/extensions/api.js` returns the same module instance the running app uses." },
  { content: "Author one: create a block, give it `types = ['extension']`, paste the source, then open **Extensions settings** from the command palette and tick the row to enable it." },
  { content: 'User extensions start **disabled**. The Extensions settings tree lets you toggle each row; the override is per-device and persists across reloads.' },
  { content: "After editing an extension's source, run **Reload extensions** from the command palette to pick up your changes." },
  { content: 'Re-insert these examples under any focused block via the **Insert example extensions** command in the palette.' },
  ...exampleExtensions.map(ex => ({
    content: ex.source,
    type: EXTENSION_TYPE,
    typeProperties: {
      [extensionNameProp.name]: ex.name,
      [extensionDescriptionProp.name]: ex.description,
    },
  } as TutorialNode)),
  {
    content: 'A block that uses the hello-renderer extension — enable `hello-renderer` above to see this render with the custom variant.',
    properties: { 'user:hello': true },
  },
]
