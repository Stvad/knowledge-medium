import { extensionDescriptionProp, extensionNameProp, isCollapsedProp } from "../../data/properties.js";
import v4 from "../../../node_modules/uuid/dist/v4.js";
import { EXTENSION_TYPE } from "../../data/blockTypes.js";
import { CHAR_COUNTER_TYPE } from "../character-counter/blockType.js";
import { PLACE_TYPE } from "../geo/blockTypes.js";
import { SRS_SM25_TYPE } from "../srs-rescheduling/schema.js";
import { TODO_TYPE } from "../todo/schema.js";
import { exampleExtensions } from "../../extensions/exampleExtensions.js";
//#region src/plugins/onboarding/outline.ts
var TUTORIAL_DEFAULT_TITLE = "Tutorial";
var TUTORIAL_VIM_TITLE = "Tutorial (vim)";
var EXTENSIONS_PAGE_TITLE = "extensions";
var vimKeys = {
	fold: "press `z` (or `Shift+Z` to collapse the current block into its parent and jump up to it)",
	edit: "press `i` (or `a` to enter at end of line, or double-click the block)",
	exitEdit: "press `Esc`",
	newBelow: "press `o` (or `Shift+O` to create above)",
	enterCreates: "— or, while editing any block, press `Enter` to split / create a new one",
	move: "`j` / `k` (or arrow keys)",
	panelHop: "`h` to the panel on the left, `l` to the right (or arrow keys)",
	firstLast: "`gg` jumps to the top of the panel, `Shift+G` to the last block in it",
	jumpMany: "`Ctrl+d` / `Ctrl+u` jump down / up by ~8 bullets",
	startSelect: "press `Space` (or `v`) to select the focused bullet; `Shift+J` / `Shift+K` then grow the selection down / up — the first press selects the current block, each next press adds the neighbour",
	delete: "press `d d` or `Delete`; to remove several at once, select them first (see the **Multi-select** section) and press `Delete`",
	properties: "press `t`",
	copyRef: "focus the block and press `y r` (yank reference); `y e` yanks an embed, `y y` the whole subtree, `y c` just this block's text, `y l` a shareable link",
	paste: "`p` pastes after the focused block, `Shift+P` before",
	undo: "`u` (or `Cmd+Z` anywhere)",
	redo: "`Ctrl+R` (or `Cmd+Shift+Z` anywhere)"
};
var defaultKeys = {
	fold: "while editing, `Cmd+Up` (`Ctrl+Up`) collapses the block and `Cmd+Down` (`Ctrl+Down`) expands it — or click the `▸` / `▾` chevron next to my bullet on hover (on touch it stays visible, and the block's swipe menu has a **Collapse** item)",
	edit: "click anywhere in my text to start typing",
	exitEdit: "",
	newBelow: "press `Enter` at the end of a bullet to create a new one below (`Shift+Enter` inserts a line break inside)",
	enterCreates: "",
	move: "while editing, `↑` / `↓` — at the top/bottom line they hop to the block above / below",
	panelHop: "click into the panel you want (keyboard panel-hop needs vim mode)",
	firstLast: "",
	jumpMany: "",
	startSelect: "while editing, `Shift+↓` / `Shift+↑` at a block edge first select the current block, then extend the selection down / up with each further press",
	delete: "select it (or several — see the **Multi-select** section) and press `Delete`; for a single empty block, `Backspace` at its start removes it and merges into the block above",
	properties: "open the command palette with `Cmd+K` and run \"Toggle block properties\"",
	copyRef: "open the on-block quick-actions menu (\"Copy Ref\" / \"Copy Embed\"); keyboard yanks (`y r` / `y e`) need vim mode",
	paste: "`Cmd+V` — pastes after the focused block",
	undo: "`Cmd+Z`",
	redo: "`Cmd+Shift+Z`"
};
var sharedKeys = {
	zoomIn: "`Cmd+.` (`Ctrl+.` on Linux/Windows)",
	zoomOut: "`Cmd+,` (`Ctrl+,` on Linux/Windows)",
	openInPanel: "`Cmd+Shift+.` (`Ctrl+Shift+.`)",
	closePanel: "`Ctrl+W`",
	commandPalette: "`Cmd+K` (`Ctrl+K`)",
	quickFind: "`Cmd+P` (`Ctrl+P`)",
	findReplace: "`Cmd+Shift+F` (`Ctrl+Shift+F`)",
	back: "`Cmd+[` / `Cmd+]` (`Ctrl+[` / `Ctrl+]`)",
	today: "`Ctrl+Shift+`` ` (every platform)",
	prevNextDay: "`Ctrl+Shift+[` / `Ctrl+Shift+]`",
	appendToday: "`Ctrl+Shift+N`"
};
/**
* Returns the ordered list of top-level children for a Tutorial page.
* The page itself (`Tutorial` or `Tutorial (vim)`) is created by
* `seedTutorial`; this outline plugs in beneath it.
*/
var tutorialOutline = (variant) => {
	const km = variant === "vim" ? vimKeys : defaultKeys;
	const vimNudge = (s) => variant === "default" ? ` ${s}` : "";
	const altLabel = variant === "vim" ? "**This is the vim-keybindings tutorial.** To follow it, vim mode needs to be on — if it isn't, run **Manage extensions** from the command palette (`Cmd+K`) and tick **Vim normal mode**. Prefer the default keys? See [[Tutorial]]." : "**This is the default tutorial.** Vim keybindings are off by default. Want them? Run **Manage extensions** from the command palette (`Cmd+K`), tick **Vim normal mode**, then read [[Tutorial (vim)]].";
	const refDemoTargetId = v4();
	return [
		{
			content: altLabel,
			...variant === "default" ? { children: [{ content: "New to \"vim keybindings\"? **It lets you move and restructure your outline straight from the keyboard.** With it on, a block gains a *normal mode*: single-click (or `Esc`) *focuses* a block instead of editing it, and from there the keys do the work — `j`/`k` between blocks, `h`/`l` between panels, `z` folds, `d d` deletes, `y r` copies a reference, `i` starts editing. If you live on the keyboard it's worth a try; flip it on as above and the shortcuts in [[Tutorial (vim)]] take over." }] } : {}
		},
		sect("Welcome", [
			"This is a malleable thought medium. Every line below is a **block** you can link, drag around, fold, and extend — including this tutorial itself.",
			"Bullets are blocks. Bullets nest. Everything else builds on that.",
			"Don't just read — try the keys/clicks on each bullet as you go. Edit anything; this tutorial is just blocks in your workspace.",
			"The first few sections cover the essentials; the deeper ones below start **folded** to keep this scannable — expand any that interest you (that fold/unfold is itself a core gesture you'll use everywhere)."
		]),
		sect("Try the basics", [
			"These bullets are here for fiddling with — read each one, try the key/click, then edit the bullet to make this tutorial yours.",
			"Press `Tab` to indent me under the bullet above (`Shift+Tab` to outdent). Try it now.",
			`New block: ${km.newBelow}${km.enterCreates ? " " + km.enterCreates : ""}.`,
			{
				content: `Fold a block's children: ${km.fold} with that block focused. Try folding the bullet below.`,
				children: [{ content: "I'll vanish when my parent is folded. Fold the parent again to bring me back." }, { content: "A folded parent shows a halo around its bullet so you can spot it from a distance." }]
			},
			`Edit a block: ${km.edit}.${km.exitEdit ? ` Exit editing: ${km.exitEdit}.` : ""}`,
			`Delete a block: ${km.delete}.`
		]),
		sect("Move around", [
			`Between blocks: ${km.move}.${vimNudge("Vim mode lets you move between blocks with `j` / `k` without entering the editor.")}`,
			...km.firstLast ? [km.firstLast] : [],
			...km.jumpMany ? [km.jumpMany] : [],
			`Zoom into a block (treat it as the new root of the view): ${sharedKeys.zoomIn}. Zoom back out: ${sharedKeys.zoomOut}.`,
			`Back / forward through your navigation history: ${sharedKeys.back}.`
		]),
		sect("Side panels", [
			"Panels sit side by side. Each panel has its own focused block, its own zoom level, and its own edit state — opening something in a new panel means you keep what you were looking at.",
			`Open the focused block in a new side panel: ${sharedKeys.openInPanel}. Close the current panel: ${sharedKeys.closePanel}.`,
			`Move between panels: ${km.panelHop}.`,
			"Wiki-link / block-ref clicks pick a destination based on modifiers. Try them on this link → [[extensions]]: plain click replaces the current panel, `Shift+Alt+Click` opens it in a brand new side panel, `Shift+Click` puts it in a vertical sidebar stack, `Alt+Click` opens it in the main panel. (Plain `Cmd+Click` / `Ctrl+Click` falls through to a browser new-tab as usual.)",
			`In quick-find (${sharedKeys.quickFind}): \`Shift+Enter\` (or \`Cmd+Enter\` / \`Ctrl+Enter\`) opens the selected page in a new panel instead of replacing the current view.`,
			`Quick capture into a side panel: ${sharedKeys.appendToday} appends a new block to today's daily note in a side panel without taking you away from where you are.`
		]),
		advancedSect("Multi-select", [
			`${cap(km.startSelect)}.`,
			"Then `Tab`, fold, `Delete`, copy, paste, move — every block-level action applies to the whole selection.",
			"Press `Esc` to clear the selection."
		]),
		sect("Pages & links", [
			"Wiki links — text wrapped in double square brackets becomes a clickable link to (or creates) a page with that name. Try the link on the next bullet: [[extensions]] takes you to the extensions page (one of the other seeded pages in this workspace).",
			`Find or create any page: ${sharedKeys.quickFind}. Type to filter; pressing Enter on a missing name creates it.`,
			`Command palette: ${sharedKeys.commandPalette}. **Every** action in the app is searchable here with its key shown — use this when you forget a shortcut, or to find actions that have no default binding.`,
			`Find and replace across the workspace: ${sharedKeys.findReplace}.`,
			{
				content: "Block refs and embeds — wiki links point at a *page* (resolved by name). A block ref `((block-id))` points at one specific block anywhere in your workspace; an embed `!((block-id))` renders the target block inline instead of as a link.",
				children: [
					{
						id: refDemoTargetId,
						content: `👋 I am the demo target. Copy a ref or embed to me (${variant === "vim" ? "focus me and press `y r` / `y e`" : "open my quick-actions menu → \"Copy Ref\" / \"Copy Embed\""}), then paste in a new bullet to see the result.`,
						children: [{ content: "I'm a child of the demo target. Embeds bring children along — so the bare-embed bullet further down will render me too." }]
					},
					{ content: `Demo ref → ((${refDemoTargetId})) — clicking this link navigates to the demo target above.` },
					{ content: "The bullet below this one is a bare embed (`!((<id>))` on its own line, nothing else). It renders the demo target inline — and notice the child of the demo target comes along too:" },
					{ content: `!((${refDemoTargetId}))` }
				]
			}
		]),
		sect("Backlinks", [
			"Links are two-way. Open a page (or zoom into any block) and a **Backlinks** section appears below its content, listing every block elsewhere that links here — so a page accretes context from everywhere it's mentioned without you maintaining it.",
			"Each referencing block shows a small **reference-count badge**; click it to expand those backlinks inline, right where you are, without navigating away. Click again to collapse.",
			"The Backlinks section has a Flat / Grouped switcher in its header. Flat is one plain list; Grouped clusters the references by a shared key — e.g. the page each one lives on, or a type/attribute they share — so related mentions (say, every daily note that links here) sit together.",
			"See it live: open [[extensions]] and scroll to its **Backlinks** — this tutorial links there from several bullets, so they all show up listed under that page."
		]),
		advancedSect("Search", [
			`QuickFind (${sharedKeys.quickFind}) searches page aliases first, then block content. Press Enter to open the selected result; if the name is missing, QuickFind can create a new page for it.`,
			"When you search for several words, all of them must appear, in any order: `project notes` matches blocks that contain both `project` and `notes`.",
			"Wrap text in quotes for an exact phrase: `\"project notes\"` only matches that contiguous text.",
			"Use uppercase `OR` for alternatives: `project OR meeting` finds either term.",
			"Use a leading minus to exclude a term when the query also has something positive to search for: `project -archived` and `-archived project` both mean \"project, but not archived\". By itself, `-archived` searches for the literal text `-archived`.",
			"Punctuation stays literal when it is part of what you typed: `2024-01`, `sync -`, and `foo/bar` search for those characters instead of acting like special syntax.",
			`For a dedicated workspace-wide text sweep, open Find and replace: ${sharedKeys.findReplace}.`
		]),
		advancedSect("Properties & types", [
			`Properties are typed key/value pairs attached to any block. To open the properties panel on a focused block: ${km.properties}.${vimNudge("With vim mode on, this is just `t`.")}`,
			"Try giving me a property — e.g. `priority: high`. It will appear under my content.",
			"Types attach behavior to a block via the special `types` property. `types = ['page']` makes a block a page — addressable by name (through its aliases) and resolvable from wiki links, wherever it lives in the tree. `types = ['extension']` makes it an extension — see below.",
			"Aliases (a list property on a page) let you reach the page from multiple names — including ones with spaces or different casing. Wiki links resolve through aliases.",
			"Every property you define is catalogued on the [[Properties]] page, and every type on the [[Types]] page — open either to see what exists in this workspace."
		]),
		sect("Typed blocks — behaviour from a tag", [
			"Beyond identity, a type can attach *behaviour* to a block. Add the type via the `types` property (see above) or a block's quick-actions menu. A few that ship by default:",
			{
				content: "**Todo** — type `todo` adds a checkbox to the block; click it to toggle done (done items strike through). Great for inline task lists anywhere in your outline.",
				children: [{
					content: "Buy milk — tick the checkbox to mark me done.",
					type: TODO_TYPE
				}]
			},
			{
				content: "**Video** — paste a video URL (YouTube, Vimeo, and more) as a block's content and it renders an inline player — no type needed. Switch the player to its **notes view** (the notes icon on the player) to jot notes beside the video; `1:23`-style timestamps you type there become clickable seeks. The block below is a live demo — open its notes view and try the timestamps in the note beside it:",
				children: [{
					content: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
					children: [{ content: "Notes sit beside the player. Click 0:10 to jump there, or 1:00 for later — each timestamp is a seek link." }]
				}]
			},
			{
				content: "**Character counter** — type `char-counter` shows a live character count under the block, with an optional per-block limit. The limit is visual only — it never blocks typing.",
				children: [{
					content: "Draft a tweet here — edit me and watch the count below track length against the 280 limit (it warns past it, never blocks).",
					type: CHAR_COUNTER_TYPE,
					typeProperties: { "char:limit": 280 }
				}]
			},
			{
				content: "**Spaced repetition** — turn any block into a flashcard and let the app schedule reviews for you (SM-2.5 algorithm).",
				children: [
					{ content: "Grade a focused block to make it a card and set its next review: open its quick-actions menu and pick a grade" + (variant === "vim" ? ", or press `Ctrl+Shift+1`–`4` (Again / Hard / Good / Easy)" : "") + "." },
					{ content: "Run **Open SRS review** from the command palette (or `Ctrl+Shift+R`) to open a deck of every card due today or earlier. In the deck, reveal the answer (`Space` / `Enter`) then grade it `1`–`4` (or click) — the card reschedules and the deck moves on." },
					{
						content: "Demo card — What's the capital of France? Grade me (or open SRS review) to schedule my first review; the answer is the child below.",
						type: SRS_SM25_TYPE,
						children: [{ content: "Paris" }]
					}
				]
			}
		]),
		sect("Places & maps", [
			"Real-world locations are first-class. Every place — a Google POI, a friend's neighborhood, a coordinate pin on a hike — becomes a typed **Place** block carrying `place:lat`, `place:lng`, `place:address`, and `place:googlePlaceId`.",
			"Type `@` at the start of a block or after whitespace to open the **place picker**. It searches your existing Places first, then offers Google Places matches; picking either inserts `[[Place Name]]` as a wikilink and creates the Place page if it didn't exist yet.",
			"`@` with no query (or `@here`) surfaces a **Use current location** option — pulls nearby POIs from browser geolocation, plus \"Drop pin here\" and \"Create named location…\" fallbacks for ad-hoc spots.",
			`Give any block a **location property**: open properties (${km.properties}) and add a \`location\` field — its value is a ref to a Place page. Many notes can share one Place (the coords live in exactly one block, so editing the Place updates every reference).`,
			"The [[Locations]] page at the workspace root holds every Place. Open it to see a **map of every Place** in your workspace; click a marker for an info card with name/address and a jump-to link.",
			{
				content: "Make any block its own map: add `map` to its `types`. The block then renders an inline map above its children showing every Place reachable in its subtree — both descendants with a `location` prop AND descendants that body-wikilink to a `[[Place]]`. A trip page tagged `map` becomes a map of the trip; a project page tagged `map` becomes a map of the project. Live demo (a `map`-tagged block over two Places):",
				type: "map",
				children: [{
					content: "Eiffel Tower",
					type: PLACE_TYPE,
					typeProperties: {
						"place:lat": 48.8584,
						"place:lng": 2.2945
					}
				}, {
					content: "Louvre Museum",
					type: PLACE_TYPE,
					typeProperties: {
						"place:lat": 48.8606,
						"place:lng": 2.3376
					}
				}]
			},
			"Each Place page itself renders with a mini-map of just that one pin, so a Place behaves like a \"location card\" with the coordinates always visible."
		]),
		advancedSect("Daily notes", [
			`Open today's daily note: ${sharedKeys.today}. This is also the default landing page on a fresh open.`,
			`Step through daily notes: ${sharedKeys.prevNextDay} (previous / next).`,
			"Every daily note is filed under the [[Journal]] page — open it for a reverse-chronological list of them all.",
			...variant === "vim" ? ["Scrub a date in place: focus a dated block and **hold `s`**. While held, `k` / `↑` move the date +1 day and `j` / `↓` −1 day; `l` / `→` +7 days and `h` / `←` −7 days. Release `s` to commit, `Esc` to cancel."] : ["**Scrub a date in place** — nudge a dated block's date forward or back without retyping it. This one's a vim-mode perk: tick **Vim normal mode** in **Manage extensions**, then focus the date and **hold `s`**, moving by day (`j` / `k`) or week (`h` / `l`). On a phone, a two-finger horizontal drag does it with no vim needed."]
		]),
		advancedSect("Undo, redo, copy, paste", [
			`Undo: ${km.undo}. Redo: ${km.redo}.`,
			`Copy a block ref / embed: ${km.copyRef}. (See "Pages & links" above for what those are.)`,
			`Paste blocks: ${km.paste}.`
		]),
		advancedSect("Settings — preferences, shortcuts, themes & extensions", [
			`Open preferences: run **Open preferences** from the command palette (${sharedKeys.commandPalette}) — it has no default shortcut.`,
			"Remap any shortcut: run **Customize keyboard shortcuts** from the command palette. It lists every action grouped by context — click a binding and press the new keys to rebind it, or reset / disable it; conflicts are flagged, and your overrides sync to your other devices.",
			"Change the look: each theme has its own command — run **Theme: <name>** from the command palette to apply it directly (e.g. `Theme: Solarized Dark`). Eight ship built-in — light and dark variants of Sunset Warm, Indigo, and Solarized, plus a plain Light and Dark — and extensions can register their own.",
			"Run **Manage extensions** from the command palette to open the extensions tree — every extension can be toggled on or off there, and the toggle syncs to your other devices. Vim mode itself is an extension (`system:vim-normal-mode`); it's off by default. Tick it to get vim normal-mode keys (and switch this tutorial to the vim variant); untick it for the default click-to-edit experience."
		]),
		advancedSect("On mobile", [
			"On a phone-sized screen the app swaps in touch affordances:",
			"A **bottom navigation bar** gives one-tap access to the sidebar, a new block, append-to-today, today's daily note, search, the command palette, and undo.",
			"While editing, a **keyboard toolbar** floats above the on-screen keyboard with indent / outdent, move up / down, `[[` page-reference and `((` block-reference inserts, undo / redo, and a Done button to dismiss the keyboard.",
			"**Swipe a block** to reveal its quick-actions menu — Copy, Copy Ref / Embed, Open in panel, Properties, Collapse, Zoom in, Delete. This is how you reach the per-block actions on touch — the same ones vim binds to keys (`z`, `t`, `y r`, …) — without a keyboard.",
			"Swipe a block to the right to cycle its todo / done state.",
			"Scrub a date: drag a **dated** block sideways with **two fingers** — right moves the date forward, left back, with an overlay previewing the new date as you drag. Two fingers so it never clashes with one-finger scroll or the swipe menu. For a bigger jump, the swipe menu has a **Reschedule** sheet."
		]),
		advancedSect("Workspaces & encryption", [
			"A workspace is an independent collection of blocks — many top-level pages and daily notes, not a single tree. Create or switch workspaces from the workspace switcher; you start as the owner and can invite others from workspace **Settings**.",
			"New workspaces can be **end-to-end encrypted** — tick \"End-to-end encrypted\" when creating one. Block content and properties are then encrypted on your device before syncing; the server only ever stores ciphertext.",
			"You hold the only key. On creation the app shows the **workspace key once** and makes you save it (a password manager is ideal) and retype its last characters to confirm. There is **no recovery** — lose the key and the data becomes permanently unreadable. On a new device, paste the key to unlock.",
			"To collaborate on an encrypted workspace, invite the person via Settings, then send them the key yourself over a channel you trust — the app never transmits it."
		]),
		advancedSect("Extensions", ["**Everything** in this app — the renderer, the vim plugin, daily notes — is an extension. You can author your own; the host loads them out of `types = ['extension']` blocks.", "See [[extensions]] for explanatory bullets, a set of working example extensions, and a renderer demo to enable and play with."]),
		advancedSect("Agent runtime — drive this workspace from your terminal", [
			"The app exposes a runtime bridge for coding agents and scripts. The browser tab runs a local relay; a CLI in your terminal submits commands that execute **inside the live app runtime** — same `Repo`, same workspace, same PowerSync SQLite, same resolved facets.",
			"Get the CLI: install the published package with `npm i -g @knowledge-medium/agent-cli` — that puts a `kmagent` command on your PATH. (Prefer not to install? Prefix any command with `npx @knowledge-medium/agent-cli` instead of `kmagent`.)",
			"Pairing (one-time per browser profile + app origin):",
			{ content: "`kmagent connect` — prints an app URL, opens the token dialog when you load it, then waits for you to paste the token back into the terminal. The secret persists in `~/.config/knowledge-medium/agent-bridge.json`." },
			"Common operations once paired:",
			{
				content: "Status & health",
				children: [{ content: "`kmagent ping` — health-check the bridge." }, { content: "`kmagent status` — detailed `/health` info (uses the persisted secret)." }]
			},
			{
				content: "Querying the workspace",
				children: [{ content: "`kmagent sql all \"SELECT id, content FROM blocks LIMIT 5\"` — runs against the local SQLite mirror." }, { content: "`kmagent eval 'return repo.activeWorkspaceId'` — runs arbitrary JS in the app runtime; the return value is serialized back." }]
			},
			{
				content: "Mutating the workspace",
				children: [{ content: "`kmagent create-block '{\"parentId\":\"<id>\",\"content\":\"Created by agent\"}'` — typed helper for the common case." }, { content: "`kmagent eval 'await createBlock({parentId: ..., content: ...})'` — same operation via the eval surface; useful for batching or conditional logic." }]
			},
			"Runtime bindings available inside `eval`: `repo`, `db`, `runtime`, `safeMode`, `sql`, `block`, `getBlock`, `getSubtree`, `createBlock`, `updateBlock`, `installExtension`, `actions`, `renderers`, `refreshAppRuntime`, `React`, `ReactDOM`, `window`, `document`. Use these to script edits, drive extensions, dump subtrees, or wire an agent into your workflow.",
			"Defaults & security: the bridge binds to `http://127.0.0.1:8787` (loopback only); only configured app origins can talk to it. Override the pairing target with `AGENT_RUNTIME_APP_URL`, browser endpoint with `VITE_AGENT_RUNTIME_URL`, CLI endpoint with `AGENT_RUNTIME_URL`. Allow extra origins via `AGENT_RUNTIME_ALLOWED_ORIGINS` (comma-separated, no paths).",
			"See the **Agent Runtime Access** section of `README.md` for full setup, plus `kmagent pair-url` if you want a bridge-only pairing URL."
		])
	];
};
var sect = (title, children, opts = {}) => ({
	content: title,
	...opts.collapsed ? { properties: { [isCollapsedProp.name]: true } } : {},
	children: children.map((c) => typeof c === "string" ? { content: c } : c)
});
var advancedSect = (title, children) => sect(title, children, { collapsed: true });
var cap = (s) => s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
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
var extensionsPageOutline = () => [
	{ content: "**Anything** in this app is an extension — the default block renderer, the vim plugin, daily notes, find-and-replace. The host loads core ones at startup; the rest are blocks like the ones below." },
	{ content: "An extension block is a block with `types = ['extension']`. Its content is a TS/JSX module whose `default` export is an `AppExtension` — a `FacetContribution`, an array of them, or a function returning one. Imports resolve through the page-global importmap, so `@/extensions/api.js` returns the same module instance the running app uses." },
	{ content: "Author one: create a block, give it `types = ['extension']`, paste the source, then open **Extensions settings** from the command palette and tick the row to enable it." },
	{ content: "User extensions start **disabled**. The Extensions settings tree lets you toggle each row; the override is per-device and persists across reloads." },
	{ content: "After editing an extension's source, run **Reload extensions** from the command palette to pick up your changes." },
	{ content: "Re-insert these examples under any focused block via the **Insert example extensions** command in the palette." },
	...exampleExtensions.map((ex) => exampleSection(ex.id))
];
/**
* Wraps a single example extension in a title bullet. Children are:
* (1) a `how to use` bullet, (2) the source block, and (optionally)
* (3) a try-it demo block tagged with the relevant gating property.
*/
var exampleSection = (id) => {
	const example = exampleExtensions.find((e) => e.id === id);
	if (!example) throw new Error(`exampleSection: unknown example "${id}"`);
	const sourceBlock = {
		content: example.source,
		type: EXTENSION_TYPE,
		typeProperties: {
			[extensionNameProp.name]: example.name,
			[extensionDescriptionProp.name]: example.description
		}
	};
	const children = [{ content: `**How to use:** ${HOW_TO_USE[id]}` }, sourceBlock];
	const demo = TRY_IT_BLOCK[id];
	if (demo) children.push(demo);
	return {
		content: example.name,
		children
	};
};
var HOW_TO_USE = {
	"hello-renderer": "Enable in Extensions settings, then add the property `user:hello = true` to any block — its content area will render with the custom hello variant.",
	"fold-all-action": "Enable, then (with vim mode on, so the focused block is in normal mode) press `Cmd+Shift+U` (`Ctrl+Shift+U`) — every visible descendant of the current view's root folds or unfolds together.",
	"emoji-react": "Enable, then Alt+click any block (or, with vim mode on, focus a block and press `Cmd+Shift+E` / `Ctrl+Shift+E`) — cycles a 🔥 / 👍 / 🎉 / ❤️ reaction below the block's content.",
	"kudos-facet": "Enable, then set a block's `renderer` property to `kudos-banner` — the block renders with the Kudos banner appended. Other extensions can contribute to the `user.kudos` facet to extend it.",
	"split-layout": "Enable, then add the property `user:layout = split` to any block — its content and children will render side by side instead of stacked.",
	"layout-renderer-override": "Enable to wrap **every** panel with a custom debug-style frame. Disable the row in Extensions settings to revert. (No per-block property — applies workspace-wide.)",
	"default-renderer-placeholder": "Enable to swap the fallback block renderer so empty blocks show a muted \"empty block\" placeholder in read mode. Disable to revert. (Applies workspace-wide.)"
};
var TRY_IT_BLOCK = {
	"hello-renderer": {
		content: "Try it: enable `hello-renderer` above, then this block renders with the custom variant (it carries `user:hello = true`).",
		properties: { "user:hello": true }
	},
	"fold-all-action": void 0,
	"emoji-react": void 0,
	"kudos-facet": void 0,
	"split-layout": {
		content: "Try it: enable `split-layout` above, then this block renders content and children side by side (it carries `user:layout = split`). The bullet below me will appear to my right.",
		properties: { "user:layout": "split" },
		children: [{ content: "I sit beside the content in split mode." }]
	},
	"layout-renderer-override": void 0,
	"default-renderer-placeholder": void 0
};
//#endregion
export { EXTENSIONS_PAGE_TITLE, TUTORIAL_DEFAULT_TITLE, TUTORIAL_VIM_TITLE, extensionsPageOutline, tutorialOutline };

//# sourceMappingURL=outline.js.map