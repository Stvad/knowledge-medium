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

import { v4 as uuidv4 } from 'uuid'
import {
  extensionDescriptionProp,
  extensionNameProp,
} from '@/data/properties'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { exampleExtensions } from '@/extensions/exampleExtensions.js'

export type TutorialNode = {
  /** Pre-allocated block id. When omitted the seeder generates a UUID.
   *  Used by ref / embed demos so a later bullet can embed
   *  `((<id>))` / `!((<id>))` pointing at this block by id. */
  id?: string
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
  edit: 'press `i` (or `a` to enter at end of line, or double-click the block)',
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
  edit: 'single-click anywhere in my text (double-click also works)',
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

  // Stable per-variant id for the block-ref / embed demo target. The
  // demo bullets below reference it via `((<id>))` and `!((<id>))` —
  // markdown parsing resolves those to a clickable ref and an inline
  // embed. Each variant gets its own demo target so the two Tutorial
  // pages don't collide on block ids.
  const refDemoTargetId = uuidv4()

  return [
    { content: altLabel },

    sect('Welcome', [
      'This is a malleable thought medium. Every line below is a **block** you can fold, link, drag around, and extend — including this tutorial itself.',
      'Bullets are blocks. Bullets nest. Everything else builds on that.',
      "Don't just read — try the keys/clicks on each bullet as you go. Edit anything; this tutorial is just blocks in your workspace.",
    ]),

    sect('Try the basics', [
      'These bullets are here for fiddling with — read each one, try the key/click, then edit the bullet to make this tutorial yours.',
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
      ...(km.firstLast ? [km.firstLast] : []),
      ...(km.jumpMany ? [km.jumpMany] : []),
      `Zoom into a block (treat it as the new root of the view): ${sharedKeys.zoomIn}. Zoom back out: ${sharedKeys.zoomOut}.`,
      `Back / forward through your navigation history: ${sharedKeys.back}.`,
    ]),

    sect('Side panels', [
      'Panels sit side by side. Each panel has its own focused block, its own zoom level, and its own edit state — opening something in a new panel means you keep what you were looking at.',
      `Open the focused block in a new side panel: ${sharedKeys.openInPanel}. Close the current panel: ${sharedKeys.closePanel}.`,
      `Move between panels: ${km.panelHop}.`,
      'Wiki-link / block-ref clicks pick a destination based on modifiers — plain click replaces the current panel, `Shift+Alt+Click` opens the link in a brand new side panel, `Shift+Click` puts it in a vertical sidebar stack, `Alt+Click` opens it in the main panel. (Plain `Cmd+Click` / `Ctrl+Click` falls through to a browser new-tab as usual.)',
      `In quick-find (${sharedKeys.quickFind}): \`Shift+Enter\` (or \`Cmd+Enter\` / \`Ctrl+Enter\`) opens the selected page in a new panel instead of replacing the current view.`,
      `Quick capture into a side panel: ${sharedKeys.appendToday} appends a new block to today's daily note in a side panel without taking you away from where you are.`,
    ]),

    sect('Multi-select', [
      `${cap(km.startSelect)}.`,
      'Then `Tab`, fold, `Delete`, copy, paste, move — every block-level action applies to the whole selection.',
      'Press `Esc` to clear the selection.',
    ]),

    sect('Pages & links', [
      'Wiki links — text wrapped in double square brackets becomes a clickable link to (or creates) a page with that name. Try the link on the next bullet: [[extensions]] takes you to the extensions page (one of the other seeded pages in this workspace).',
      `Find or create any page: ${sharedKeys.quickFind}. Type to filter; pressing Enter on a missing name creates it.`,
      `Command palette: ${sharedKeys.commandPalette}. **Every** action in the app is searchable here with its key shown — use this when you forget a shortcut, or to find actions that have no default binding.`,
      `Find and replace across the workspace: ${sharedKeys.findReplace}.`,
      {
        content: 'Block refs and embeds — wiki links point at a *page* (resolved by name). A block ref `((block-id))` points at one specific block anywhere in your workspace; an embed `!((block-id))` renders the target block inline instead of as a link.',
        children: [
          {
            id: refDemoTargetId,
            content: '👋 I am the demo target. Focus me and press `Alt+Y` to copy a ref to me, or `Shift+Y` to copy an embed — then paste in a new bullet to see the result.',
            children: [
              { content: "I'm a child of the demo target. Embeds bring children along — so the bare-embed bullet further down will render me too." },
            ],
          },
          {
            content: `Demo ref → ((${refDemoTargetId})) — clicking this link navigates to the demo target above.`,
          },
          {
            content: 'The bullet below this one is a bare embed (`!((<id>))` on its own line, nothing else). It renders the demo target inline — and notice the child of the demo target comes along too:',
          },
          {
            content: `!((${refDemoTargetId}))`,
          },
        ],
      },
    ]),

    sect('Search', [
      `QuickFind (${sharedKeys.quickFind}) searches page aliases first, then block content. Press Enter to open the selected result; if the name is missing, QuickFind can create a new page for it.`,
      'Plain words are all required but can appear anywhere: `project notes` finds blocks containing both `project` and `notes`, even if the order is different.',
      'Wrap text in quotes for an exact phrase: `"project notes"` only matches that contiguous text.',
      'Use uppercase `OR` for alternatives: `project OR meeting` finds either term.',
      'Use a leading minus to exclude a term when the query also has something positive to search for: `project -archived` and `-archived project` both mean "project, but not archived". By itself, `-archived` searches for the literal text `-archived`.',
      'Punctuation stays literal when it is part of what you typed: `2024-01`, `sync -`, and `foo/bar` search for those characters instead of acting like special syntax.',
      `For a dedicated workspace-wide text sweep, open Find and replace: ${sharedKeys.findReplace}.`,
    ]),

    sect('Properties & types', [
      `Properties are typed key/value pairs attached to any block. To open the properties panel on a focused block: ${km.properties}.`,
      'Try giving me a property — e.g. `priority: high`. It will appear under my content.',
      "Types attach behavior to a block via the special `types` property. `types = ['page']` makes a block a page (parent-less, alias-resolvable). `types = ['extension']` makes it an extension — see below.",
      'Aliases (a list property on a page) let you reach the page from multiple names — including ones with spaces or different casing. Wiki links resolve through aliases.',
    ]),

    sect('Places & maps', [
      'Real-world locations are first-class. Every place — a Google POI, a friend\'s neighborhood, a coordinate pin on a hike — becomes a typed **Place** block carrying `place:lat`, `place:lng`, `place:address`, and `place:googlePlaceId`.',
      'Type `@` at the start of a block or after whitespace to open the **place picker**. It searches your existing Places first, then offers Google Places matches; picking either inserts `[[Place Name]]` as a wikilink and creates the Place page if it didn\'t exist yet.',
      '`@` with no query (or `@here`) surfaces a **Use current location** option — pulls nearby POIs from browser geolocation, plus "Drop pin here" and "Create named location…" fallbacks for ad-hoc spots.',
      `Give any block a **location property**: open properties (${km.properties}) and add a \`location\` field — its value is a ref to a Place page. Many notes can share one Place (the coords live in exactly one block, so editing the Place updates every reference).`,
      'After your first place is created, a `Locations` page appears at the workspace root holding every Place. Open it to see a **map of every Place** in your workspace; click a marker for an info card with name/address and a jump-to link.',
      'Make any block its own map: add `map` to its `types`. The block then renders an inline map above its children showing every Place reachable in its subtree — both descendants with a `location` prop AND descendants that body-wikilink to a `[[Place]]`. A trip page tagged `map` becomes a map of the trip; a project page tagged `map` becomes a map of the project.',
      'Each Place page itself renders with a mini-map of just that one pin, so a Place behaves like a "location card" with the coordinates always visible.',
    ]),

    sect('Daily notes', [
      `Open today's daily note: ${sharedKeys.today}. This is also the default landing page on a fresh open.`,
      `Step through daily notes: ${sharedKeys.prevNextDay} (previous / next).`,
    ]),

    sect('Undo, redo, copy, paste', [
      `Undo: ${km.undo}. Redo: ${km.redo}.`,
      `Copy a block ref: ${sharedKeys.copyRef}. Copy a block embed: ${sharedKeys.copyEmbed}. (See "Pages & links" above for what those are.)`,
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

    sect('Agent runtime — drive this workspace from your terminal', [
      'The app exposes a runtime bridge for coding agents and scripts. The browser tab runs a local relay; a CLI in your terminal submits commands that execute **inside the live app runtime** — same `Repo`, same workspace, same PowerSync SQLite, same resolved facets.',
      'Pairing (one-time per browser profile + app origin):',
      {
        content: '`yarn agent connect` — prints an app URL, opens the token dialog when you load it, then waits for you to paste the token back into the terminal. The secret persists in `~/.config/knowledge-medium/agent-bridge.json`.',
      },
      'Common operations once paired:',
      {
        content: 'Status & health',
        children: [
          { content: '`yarn agent ping` — health-check the bridge.' },
          { content: '`yarn agent status` — detailed `/health` info (uses the persisted secret).' },
        ],
      },
      {
        content: 'Querying the workspace',
        children: [
          { content: '`yarn agent sql all "SELECT id, content FROM blocks LIMIT 5"` — runs against the local SQLite mirror.' },
          { content: "`yarn agent eval 'return repo.activeWorkspaceId'` — runs arbitrary JS in the app runtime; the return value is serialized back." },
        ],
      },
      {
        content: 'Mutating the workspace',
        children: [
          { content: '`yarn agent create-block \'{"parentId":"<id>","content":"Created by agent"}\'` — typed helper for the common case.' },
          { content: "`yarn agent eval 'await createBlock({parentId: ..., content: ...})'` — same operation via the eval surface; useful for batching or conditional logic." },
        ],
      },
      'Runtime bindings available inside `eval`: `repo`, `db`, `runtime`, `safeMode`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `installExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, `document`. Use these to script edits, drive extensions, dump subtrees, or wire an agent into your workflow.',
      'Defaults & security: the bridge binds to `http://127.0.0.1:8787` (loopback only); only configured app origins can talk to it. Override the pairing target with `AGENT_RUNTIME_APP_URL`, browser endpoint with `VITE_AGENT_RUNTIME_URL`, CLI endpoint with `AGENT_RUNTIME_URL`. Allow extra origins via `AGENT_RUNTIME_ALLOWED_ORIGINS` (comma-separated, no paths).',
      'See the **Agent Runtime Access** section of `README.md` for full setup, plus `yarn agent pair-url` if you want a bridge-only pairing URL.',
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
 *
 * Each example is wrapped in a title bullet whose children are:
 *   1. a "how to use it" description (what to do after enabling), and
 *   2. the source block (typed `extension`, carries name/description
 *      properties) — and optionally a try-it block tagged with the
 *      gating property so a user can see the effect live.
 */
export const extensionsPageOutline = (): TutorialNode[] => [
  { content: '**Anything** in this app is an extension — the default block renderer, the vim plugin, daily notes, find-and-replace. The host loads core ones at startup; the rest are blocks like the ones below.' },
  { content: "An extension block is a block with `types = ['extension']`. Its content is a TS/JSX module whose `default` export is an `AppExtension` — a `FacetContribution`, an array of them, or a function returning one. Imports resolve through the page-global importmap, so `@/extensions/api.js` returns the same module instance the running app uses." },
  { content: "Author one: create a block, give it `types = ['extension']`, paste the source, then open **Extensions settings** from the command palette and tick the row to enable it." },
  { content: 'User extensions start **disabled**. The Extensions settings tree lets you toggle each row; the override is per-device and persists across reloads.' },
  { content: "After editing an extension's source, run **Reload extensions** from the command palette to pick up your changes." },
  { content: 'Re-insert these examples under any focused block via the **Insert example extensions** command in the palette.' },
  ...exampleExtensions.map(ex => exampleSection(ex.id)),
]

/**
 * Wraps a single example extension in a title bullet. Children are:
 * (1) a `how to use` bullet, (2) the source block, and (optionally)
 * (3) a try-it demo block tagged with the relevant gating property.
 */
const exampleSection = (id: string): TutorialNode => {
  const example = exampleExtensions.find(e => e.id === id)
  if (!example) throw new Error(`exampleSection: unknown example "${id}"`)

  const sourceBlock: TutorialNode = {
    content: example.source,
    type: EXTENSION_TYPE,
    typeProperties: {
      [extensionNameProp.name]: example.name,
      [extensionDescriptionProp.name]: example.description,
    },
  }

  const children: TutorialNode[] = [
    { content: `**How to use:** ${HOW_TO_USE[id]}` },
    sourceBlock,
  ]
  const demo = TRY_IT_BLOCK[id]
  if (demo) children.push(demo)

  return { content: example.name, children }
}

// Keyed by `ExampleExtensionDefinition.id` — short usage notes shown
// above each example's source so a reader knows what to enable and
// what property/key actually drives the demo.
const HOW_TO_USE: Record<string, string> = {
  'hello-renderer': 'Enable in Extensions settings, then add the property `user:hello = true` to any block — its content area will render with the custom hello variant.',
  'fold-all-action': 'Enable, then press `Cmd+Shift+F` (or `Ctrl+Shift+F` on Linux/Windows) anywhere in the panel — every visible descendant of the current view\'s root folds or unfolds together.',
  'emoji-react': "Enable, then either Alt+click any block or focus a block and press `Cmd+Shift+R` (`Ctrl+Shift+R`) — cycles a 🔥 / 👍 / 🎉 / ❤️ reaction below the block's content.",
  'kudos-facet': "Enable, then set a block's `renderer` property to `kudos-banner` — the block renders with the Kudos banner appended. Other extensions can contribute to the `user.kudos` facet to extend it.",
  'split-layout': "Enable, then add the property `user:layout = split` to any block — its content and children will render side by side instead of stacked.",
  'layout-renderer-override': 'Enable to wrap **every** panel with a custom debug-style frame. Disable the row in Extensions settings to revert. (No per-block property — applies workspace-wide.)',
  'default-renderer-placeholder': 'Enable to swap the fallback block renderer so empty blocks show a muted "empty block" placeholder in read mode. Disable to revert. (Applies workspace-wide.)',
}

// Optional try-it demo block per example. Only examples gated by a
// property carry a demo; renderer-override examples apply globally so
// no per-block toggle exists.
const TRY_IT_BLOCK: Record<string, TutorialNode | undefined> = {
  'hello-renderer': {
    content: 'Try it: enable `hello-renderer` above, then this block renders with the custom variant (it carries `user:hello = true`).',
    properties: { 'user:hello': true },
  },
  'fold-all-action': undefined,
  'emoji-react': undefined,
  'kudos-facet': undefined,
  'split-layout': {
    content: 'Try it: enable `split-layout` above, then this block renders content and children side by side (it carries `user:layout = split`). The bullet below me will appear to my right.',
    properties: { 'user:layout': 'split' },
    children: [
      { content: 'I sit beside the content in split mode.' },
    ],
  },
  'layout-renderer-override': undefined,
  'default-renderer-placeholder': undefined,
}
