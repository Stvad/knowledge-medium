// Data definition of the starter Tutorial subtree. `seedTutorial` walks
// the returned forest and emits one `tx.create` per node (plus an
// `addTypeInTx` when `type` is set), so the entire Tutorial — vim and
// default variants — is authored here without touching the seed
// machinery. The vim variant lives at the alias `Tutorial (vim)`; the
// first bullet on each page cross-links to the other. How each variant
// names its keys, and the accuracy rule for those strings, is `keys.ts`.
//
// `[[name]]` in a node's content mints a page called `name` when the seed
// commits, even inside backticks (the reference parser does not skip code
// spans), so every closed wiki link here must name a page that should
// exist. HTML documents are exempt: their content is not parsed.

import { v4 as uuidv4 } from 'uuid'
import {
  extensionDescriptionProp,
  extensionNameProp,
  isCollapsedProp,
} from '@/data/properties'
import { EXTENSION_TYPE, HTML_DOCUMENT_TYPE } from '@/data/blockTypes'
import { exampleExtensions } from '@/extensions/exampleExtensions.js'
// Demo blocks tag themselves with these plugin types so the tutorial shows
// each feature live. Importing plugin constants is fine now that onboarding
// is itself a plugin (plugin → plugin); the seed test loads the same
// plugins' data-extensions so the types resolve there too.
import { TODO_TYPE } from '@/plugins/todo/schema'
import { CHAR_COUNTER_TYPE, WORD_COUNTER_TYPE } from '@/plugins/character-counter/blockType'
import { SRS_SM25_TYPE } from '@/plugins/srs-rescheduling/schema'
import { MAP_TYPE, PLACE_TYPE } from '@/plugins/geo/blockTypes'
import { defaultKeys, sharedKeys, vimKeys } from './keys'
import { cheatSheetDocument } from './documents/cheatSheet'
import blockAnatomyDocument from './documents/blockAnatomy.html?raw'
import linkClicksDocument from './documents/linkClicks.html?raw'
import focusTimerDocument from './documents/focusTimer.html?raw'

/** A comment thread the seed starts on its node once the pages are committed:
 *  on `quote`, which must occur in the node's content as plain text. With a
 *  `replacement` it is an edit suggestion. */
export interface TutorialThread {
  quote: string
  comment?: string
  replacement?: string
}

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
  thread?: TutorialThread
  children?: TutorialNode[]
}

export type TutorialVariant = 'vim' | 'default'

// The default (non-vim) variant is canonical `Tutorial` — it matches the
// shipped default keymap (vim is opt-in). The landing `[[Tutorial]]`
// bullet resolves here; the vim variant lives at the alias below and is
// reachable via the cross-link at the top of each page.
export const TUTORIAL_DEFAULT_TITLE = 'Tutorial'
export const TUTORIAL_VIM_TITLE = 'Tutorial (vim)'
export const EXTENSIONS_PAGE_TITLE = 'extensions'

const markdownTable = (header: readonly [string, string], rows: ReadonlyArray<readonly [string, string]>): string =>
  [`| ${header[0]} | ${header[1]} |`, '| --- | --- |', ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join('\n')

const htmlDocument = (source: string): TutorialNode => ({ content: source, type: HTML_DOCUMENT_TYPE })

/**
 * Returns the ordered list of top-level children for a Tutorial page.
 * The page itself (`Tutorial` or `Tutorial (vim)`) is created by
 * `seedTutorial`; this outline plugs in beneath it.
 */
export const tutorialOutline = (variant: TutorialVariant): TutorialNode[] => {
  const km = variant === 'vim' ? vimKeys : defaultKeys
  const altLabel =
    variant === 'vim'
      ? '**This is the vim-keybindings tutorial.** To follow it, vim mode needs to be on — if it isn\'t, run **Manage extensions** from the command palette (`Cmd+K`) and tick **Vim normal mode**. Prefer the default keys? See [[Tutorial]].'
      : '**This is the default tutorial.** Vim keybindings are off by default. Want them? Run **Manage extensions** from the command palette (`Cmd+K`), tick **Vim normal mode**, then read [[Tutorial (vim)]].'

  // Stable per-variant id for the block-ref / embed demo target. The
  // demo bullets below reference it via `((<id>))` and `!((<id>))` —
  // markdown parsing resolves those to a clickable ref and an inline
  // embed. Each variant gets its own demo target so the two Tutorial
  // pages don't collide on block ids.
  const refDemoTargetId = uuidv4()

  return [
    {
      content: altLabel,
      ...(variant === 'default'
        ? {
            children: [{
              content: 'New to "vim keybindings"? **It lets you move and restructure your outline straight from the keyboard.** With it on, a block gains a *normal mode*: single-click (or `Esc`) *focuses* a block instead of editing it, and from there the keys do the work — `j`/`k` between blocks, `h`/`l` between panels, `z` folds, `d d` deletes, `y r` copies a reference, `i` starts editing. If you live on the keyboard it\'s worth a try; flip it on as above and the shortcuts in [[Tutorial (vim)]] take over.',
            }],
          }
        : {}),
    },

    sect('Welcome', [
      'This is a malleable thought medium. Every line below is a **block** you can link, move, fold and extend — this tutorial included.',
      htmlDocument(blockAnatomyDocument),
      "Don't just read — try the keys and clicks on each bullet as you go. This tutorial is ordinary blocks in your workspace: edit, move or delete anything.",
      'The first sections cover the essentials; the deeper ones start **folded** to keep this page scannable. Click a section\'s chevron to open it — folding is a gesture you\'ll use everywhere.',
      'Shortcuts are written Mac-style: on Linux/Windows, read `Cmd` as `Ctrl`. (Chords shown with an explicit `Ctrl` are `Ctrl` on every platform.)',
      `Lost? The **Help** button at the top right — or ${sharedKeys.help} — lists every shortcut and gesture that works where you are, and ${sharedKeys.commandPalette} searches every command.`,
    ]),

    sect('Write', [
      'These bullets are for fiddling with — read each one, try it, then edit it to make this tutorial yours.',
      `Edit a block: ${km.edit}.`,
      `New block: ${km.newBelow}`,
      'Press `Tab` to indent me under the bullet above (`Shift+Tab` to outdent). Try it now.',
      {
        content: 'Blocks take Markdown. Some of what renders:',
        children: [{
          content: markdownTable(['You type', 'You get'], [
            ['`**bold**`', '**bold**'],
            ['`*italic*`', '*italic*'],
            ['`~~struck~~`', '~~struck~~'],
            ['`` `code` ``', '`code`'],
            ['`[text](https://example.com)`', '[text](https://example.com)'],
            ['`- item` at the start of a line', 'a list inside the block'],
          ]),
        }],
      },
      `Link the text you've selected while editing: ${sharedKeys.createLink} wraps it as \`[text]()\` with the caret ready for the address.`,
      'The table above is plain Markdown too: pipes between cells, a `| --- |` row under the header. Wide tables scroll sideways inside their block.',
    ]),

    sect('Organize', [
      {
        content: `Fold a block's children: ${km.fold}. Try it on this bullet.`,
        children: [
          { content: "I'll vanish when my parent is folded. Unfold it to bring me back." },
          { content: 'A folded parent shows a halo around its bullet so you can spot it from a distance.' },
        ],
      },
      `Move a block one step up / down through the outline (it keeps its depth, hopping into the neighbouring parent at an edge): ${km.moveBlock}.`,
      'Or drag a block by its bullet and drop it anywhere. A line shows where it will land, and where the line starts shows the depth: further right nests it under the block above. `Esc` cancels mid-drag, and one undo puts it back. On touch, hold the bullet for half a second, then drag.',
      `Delete a block: ${km.delete}. Deleting 20 or more blocks at once (nested ones count) asks first.`,
      `Undo: ${km.undo}. Redo: ${km.redo}.`,
    ]),

    // Expanded and early: the default variant's delete / properties bullets
    // route through selections, so this can't hide behind a fold below them.
    sect('Select many blocks', [
      `${km.startSelect}.`,
      'With the mouse: `Shift`+click a block to extend the selection to it, `Cmd`+click to add or remove a single block.',
      'Once a selection exists, the block keys act on all of it — vim or not: `Tab` / `Shift+Tab` indent, `z` folds, `t` toggles properties, `y` (or `Cmd+C`) copies, `d` (or `Cmd+X`) cuts, `Delete` (or `Backspace`) deletes, `p` / `Shift+P` paste after / before, and `Cmd+Shift+↑` / `Cmd+Shift+↓` move the whole selection. Dragging any selected bullet moves them all.',
      `Cut moves blocks rather than deleting them: ${km.cut}. The blocks stay where they are, dimmed, until you paste — then they move there. They are the same blocks, so every reference to them keeps working. Copy something else meanwhile and nothing moves; undo before your next edit takes the cut back.`,
      `Paste: ${km.paste}.`,
      'Send blocks somewhere else entirely: run **Move selected blocks to…** from the command palette while a selection is active, or right-click any bullet → **Move to…** for the single-block version. A destination picker opens; the whole move is one undo step.',
      'Press `Esc` to clear the selection.',
    ]),

    sect('Links & references', [
      'Text wrapped in double square brackets links to the page of that name, creating it if it doesn\'t exist. Try this one: [[extensions]] takes you to the extensions page, seeded alongside this tutorial.',
      'Typing `[[` opens page autocomplete. Matching is forgiving — word-prefix chains like `[[meetnotes` find "Meeting Notes" — and a candidate with a distinguishing type (beyond plain page) shows it beside the name.',
      'A page is a block like any other, so pages nest too. Its bullet is drawn as a **ring**, so you can spot one anywhere in the outline.',
      {
        content: 'Block refs and embeds — wiki links point at a *page* (resolved by name). A block ref `((block-id))` points at one specific block anywhere in your workspace; an embed `!((block-id))` renders the target block inline instead of as a link.',
        children: [
          {
            id: refDemoTargetId,
            content: `👋 I am the demo target. Copy a ref or embed to me (${km.refDemoCopy}), then paste in a new bullet to see the result.`,
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
      'Links work both ways. Open a page (or zoom into any block) and a **Linked References** section below it lists every block elsewhere that links there — so a page gathers context from everywhere it\'s mentioned, without you maintaining it.',
      'Out in the outline, a block that others link *to* shows a grey count at its right edge; click it to unfold those references right there, without navigating away. (The block you\'ve zoomed into gets the full Linked References section instead.)',
      'Linked References can be **Flat** (one list) or **Grouped** (by the page each one lives on, or a type or property they share); daily notes default to Grouped. The funnel icon in its header filters them by page, daily note or property value.',
      'See it live: open [[extensions]] and scroll to its **Linked References** — this tutorial links there from several bullets, so they all show up.',
    ]),

    sect('Find your way', [
      `Between blocks: ${km.move}.`,
      ...(km.firstLast ? [km.firstLast] : []),
      ...(km.jumpMany ? [km.jumpMany] : []),
      `Zoom into a block (make it the root of the view): ${sharedKeys.zoomIn}. Zoom back out: ${sharedKeys.zoomOut}.${km.zoomNote}`,
      `Back / forward through where you've been: ${sharedKeys.back}.`,
      `Find or create any page: ${sharedKeys.quickFind}. Type to filter — block results show where they live, typed results their type, and \`Enter\` on a missing name creates the page. Date phrases work too: \`tomorrow\` or \`last friday\` jumps to that daily note.`,
      {
        content: 'Search syntax — quick find matches page names first, then block text (from 3 characters):',
        properties: { [isCollapsedProp.name]: true },
        children: [
          {
            content: markdownTable(['Type', 'To find blocks with'], [
              ['`project notes`', 'both words, in any order'],
              ['`"project notes"`', 'that exact phrase'],
              ['`project OR meeting`', 'either word (uppercase `OR`)'],
              ['`project -archived`', '"project" but not "archived"'],
              ['`-archived` on its own', 'the literal text `-archived`'],
              ['`2024-01`, `foo/bar`', 'those characters, as typed'],
            ]),
          },
          { content: `For a workspace-wide text sweep, open **Find and replace**: ${sharedKeys.findReplace}.` },
        ],
      },
      `Command palette: ${sharedKeys.commandPalette}. **Every** action available right now is searchable here with its key shown — use it when you forget a shortcut, or to find actions that have no default key.`,
      `**Shortcuts & gestures** (the **Help** button, or ${sharedKeys.help}) shows everything you can press right now, how link clicks work, and an **Open tutorial** link back here. Press any chord while it's open to see what it would run — and rebind it from there.`,
      'The **left sidebar** (panel icon in the header; first button in the bottom nav on a phone) keeps your anchors in reach: **Jump to…** and **Today** controls, the workspace switcher, and a **Shortcuts** section you curate — it starts with [[Journal]].',
      'What did I touch recently? The clock icon in the header (or **Open Recents** in the command palette) opens [[Recents]], a feed of recently edited blocks grouped into activity entries.',
    ]),

    advancedSect('Panels', [
      'Panels sit side by side. Each has its own focused block, zoom level and edit state — opening something in a new panel means you keep what you were looking at.',
      htmlDocument(linkClicksDocument),
      `Try those on this link → [[extensions]]. Right-clicking a link offers the same choices as a menu. In quick find (${sharedKeys.quickFind}) the modifiers apply to \`Enter\`: \`Shift+Alt+Enter\` opens a new panel, \`Shift+Enter\` the sidebar stack.`,
      `Open the focused block in the sidebar stack: ${sharedKeys.openInPanel}. Close the current panel: ${sharedKeys.closePanel} — or its close button, since a Linux/Windows browser tab may keep that chord for itself.${km.panelKeysNote}`,
      `Need the whole window for one panel? With more than one panel open, the maximize button in the panel's corner — or ${sharedKeys.maximizePanel}${km.panelKeysNote ? ' (the same caveat applies)' : ''} — toggles maximize. The other panels are kept and come back when you toggle again; browser Back (\`Cmd+[\`) also steps out of it.`,
      'Resize columns by dragging the divider between two of them; double-click a divider to even them out.',
      `Move between panels: ${km.panelHop}.`,
    ]),

    advancedSect('Daily notes', [
      `Open today's daily note: ${sharedKeys.today}. It's also where the app opens.`,
      `Step through daily notes: ${sharedKeys.prevNextDay} (previous / next). A zoomed-in daily note also shows ‹ / › arrows beside its title that step just that panel through the days.`,
      `Capture a thought without losing your place: ${sharedKeys.newDailyBlock} (**New daily block**) adds a block to today's note and opens it in the sidebar stack, ready to type.`,
      'Jump to any date with the calendar button in the header, or type a phrase like `next monday` into quick find.',
      'Every daily note is filed under the [[Journal]] page — open it for a reverse-chronological list of them all.',
      km.dateScrub,
    ]),

    // Expanded: carries live demo threads, which a fold would hide.
    sect('Comments & suggestions', [
      'Comment on a whole block, or on a few words of it. Threads live beside the text, so the block stays as you wrote it, and a thread is made of ordinary blocks you can edit and link to.',
      {
        content: 'Demo: the highlighted words in this block carry a comment thread. Click the amber pill at the right of the block to open it, then reply to it or resolve it.',
        thread: {
          quote: 'the highlighted words',
          comment: 'This is the thread\'s first comment. Comments are blocks: edit this one, **Reply** to answer it, or **Resolve** to close the thread.',
        },
      },
      `Comment on a block: ${km.commentOnBlock}.`,
      `Comment on part of a block: select the words — while editing, or in the rendered text — and press ${sharedKeys.comment}. Right-click a selection in rendered text for the same choices as a menu: **Comment**, **Highlight**, **Suggest edit** and **Copy reference**.`,
      `Highlight without commenting: select the text and press ${sharedKeys.highlight}.`,
      {
        content: 'Demo: a suggestion proposes an edit without making it. This block has one that fixes the typo in recieve — open its pill and press Accept.',
        thread: { quote: 'recieve', replacement: 'receive' },
      },
      `Suggest an edit: select the text, press ${sharedKeys.suggest}, type the replacement (and why, if you like), then **Suggest**. Anyone reading it can **Accept**, which edits the block in one undo step, or **Reject**.`,
      'Quote part of a block somewhere else: right-click selected rendered text → **Copy reference** (while editing: **Copy reference to selection** in the command palette), then paste. It shows as the quoted words, linked to their source, and the thread lists every place it is **Quoted in**.',
      `Read threads inline — click a block's pill, or press ${km.toggleThreads} — or in the margin: run **Toggle comments margin** from the command palette (or click **Show in margin** under a thread) to see every thread beside the text, on a wide enough panel. Drag the margin's edge to resize it.`,
      'Threads are kept as blocks on the **Comments (km)** page.',
    ]),

    sect('Typed blocks — behaviour from a tag', [
      'Beyond identity, a type can attach *behaviour* to a block. Tag a block by typing `#` in its text (see **Properties & types**), or via the `types` property. A few types that ship by default:',
      {
        content: "**Todo** — type `todo` adds a checkbox to the block; click it to toggle done (done items strike through). While editing, `Cmd+Enter` cycles the state; on a phone, swiping the block right does it.",
        children: [
          { content: 'Buy milk — tick the checkbox to mark me done.', type: TODO_TYPE },
        ],
      },
      {
        content: "**Video** — paste a video URL (YouTube, Vimeo, and more) as a block's content and it renders an inline player — no type needed. Switch the player to its **notes view** (the notes icon on the player) to jot notes beside the video; `1:23`-style timestamps you type there become clickable seeks. The block below is a live demo — open its notes view and try the timestamps in the note beside it:",
        children: [
          {
            content: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
            children: [
              { content: 'Notes sit beside the player. Click 0:10 to jump there, or 1:00 for later — each timestamp is a seek link.' },
            ],
          },
        ],
      },
      {
        content: '**Counters** — type `char-counter` shows a live character count on the block, with an optional limit (visual only: it never blocks typing). Type `word-counter` counts the words in the block and everything nested under it.',
        children: [
          {
            content: 'Draft a post here — edit me and watch the count track length against the 280 limit (it warns past it, never blocks).',
            type: CHAR_COUNTER_TYPE,
            // `char:limit` is a type-lifted field on char-counter, so it's set
            // via addType (typeProperties), not a raw property.
            typeProperties: { 'char:limit': 280 },
          },
          {
            content: 'My word count totals me and the two lines nested under me. Add a line and watch it grow.',
            type: WORD_COUNTER_TYPE,
            children: [
              { content: 'The first paragraph of a draft.' },
              { content: 'A second paragraph, a little longer than the first.' },
            ],
          },
        ],
      },
      {
        content: '**Spaced repetition** — turn any block into a flashcard and let the app schedule reviews for you (SM-2.5 algorithm).',
        children: [
          { content: `Grade a block to make it a card and set its next review: ${km.srsGrade}. On touch, the swipe menu carries the four grades.` },
          { content: `Review what's due: run **Open SRS review** (or ${sharedKeys.srsReview}) and pick a deck. In the review, \`Space\` (or \`Enter\`) shows the answer and, pressed again, grades it Good; \`1\`–\`4\` grade Again / Hard / Good / Easy.` },
          { content: 'In the deck picker, the calendar button beside a deck puts its due count on today\'s daily note, one click from a review.' },
          {
            content: 'Demo card — What\'s the capital of France? Grade me (or open SRS review) to schedule my first review; the answer is the child below.',
            type: SRS_SM25_TYPE,
            children: [
              { content: 'Paris' },
            ],
          },
        ],
      },
    ]),

    // Expanded: carries the live scripted demo.
    sect('Interactive documents', [
      'A block typed **HTML document** holds a small web page: HTML and CSS, plus scripts if you allow them. Reach for one where bullets can\'t do the job — a diagram, a calculator, a chart, a timer.',
      'The diagram near the top of this tutorial, the link diagram under **Panels** and the **Cheat sheet** at the end are HTML documents. They have no scripts, so they render straight away.',
      {
        content: 'This one runs code, so it waits for you: click **Run scripts** in its top strip, confirm, then start the timer.',
        children: [htmlDocument(focusTimerDocument)],
      },
      'Scripts wait until you allow them — for that version of the document, on this device: edit its source and it asks again, and **Stop scripts** halts them. A document never sees your notes, but once its scripts run they can capture what you type and reach the network, which is what the prompt asks you to accept.',
      `Make one: ${km.insertHtmlExample} — it adds a bread-hydration calculator under the block. Or tag any block \`#\` → **HTML document** and write the page as its text.`,
      `Edit a document: ${km.editHtmlSource}. Leaving the editor reloads the page with your changes.`,
      'Colour a document with the app\'s theme variables — `hsl(var(--primary))`, `hsl(var(--muted-foreground))`, `hsl(var(--border))` and the rest — and it follows the light or dark theme. The source of any document here shows them in use.',
      'Keep page links in the blocks around a document: a link inside one can\'t open your blocks, and its text isn\'t read for references.',
    ]),

    advancedSect('Places & maps', [
      'Real-world locations are first-class. Every place — a Google POI, a friend\'s neighborhood, a coordinate pin on a hike — becomes a typed **Place** block carrying `place:lat`, `place:lng`, `place:address`, and `place:googlePlaceId`.',
      'Type `@` at the start of a block or after whitespace to open the **place picker**. It searches your existing Places first, then offers Google Places matches; picking either inserts a wikilink with the place\'s name and creates the Place page if it didn\'t exist yet.',
      '`@` with no query (or `@here`) surfaces a **Use current location** option — pulls nearby POIs from browser geolocation, plus "Drop pin at exact location" and "Create named place here…" fallbacks for ad-hoc spots.',
      'Give any block a **location property**: open its properties panel (see **Properties & types**) and add a `location` field — its value is a ref to a Place page. Many notes can share one Place (the coords live in exactly one block, so editing the Place updates every reference).',
      'The [[Locations]] page at the workspace root holds every Place. Open it to see a **map of every Place** in your workspace; click a marker for an info card with name/address and a jump-to link.',
      {
        content: 'Make any block its own map: add `map` to its `types`. The block then renders an inline map above its children showing every Place reachable in its subtree — descendants with a `location` prop AND descendants that link to a Place (wikilink or block ref). A trip page tagged `map` becomes a map of the trip. Live demo (a `map`-tagged block over two Places):',
        type: MAP_TYPE,
        children: [
          // Place blocks pin at their own lat/lng. `place:*` are type-lifted
          // fields on PLACE_TYPE, so coordinates go via addType (typeProperties).
          // Two landmarks close together (both central Paris) so the map's
          // auto-fit lands on the city, not on water between distant pins.
          { content: 'Eiffel Tower', type: PLACE_TYPE, typeProperties: { 'place:lat': 48.8584, 'place:lng': 2.2945 } },
          { content: 'Louvre Museum', type: PLACE_TYPE, typeProperties: { 'place:lat': 48.8606, 'place:lng': 2.3376 } },
        ],
      },
      'Each Place page itself renders with a mini-map of just that one pin, so a Place behaves like a "location card" with the coordinates always visible.',
    ]),

    advancedSect('Properties & types', [
      `Properties are typed fields on a block — a date, a number, a link to another block. To open a block's properties: ${km.properties}. Then **+ Field** adds one: pick an existing property or name a new one.`,
      'Try giving me one — say a `priority`. It appears under my text.',
      'Faster: in an empty block nested under the one you want to annotate, type `::`. The empty block goes away and its parent\'s field picker opens.',
      'The quickest way to give a block a **type**: type `#` in its text and pick from the autocomplete — `#todo` turns the block into a todo on the spot, and **Create type "…"** mints a brand-new type. Most types render as removable `#name` chips after the content (todo skips the chip — its checkbox is the display).',
      "Under the hood, types live in the special `types` property, and a page's names live in its `aliases` list — wiki links resolve through aliases, so a page is reachable from multiple names (different casing, spaces, shorthands), wherever the block lives in the tree.",
      `Grown a de-facto schema by hand? **Extract type from this block** turns a prototype block into a named type — pick which of its properties belong to the type, then retag the blocks that match. To run it: ${km.extractTypePath}.`,
      'Every property you define is catalogued on the [[Properties]] page, and every type on the [[Types]] page — open either to see what exists in this workspace.',
    ]),

    advancedSect('Paste, images & files', [
      'Paste from a web page or a doc and its structure comes along: headings become blocks with their content nested under them, and lists, links, tables and formatting are kept as Markdown.',
      'While editing, pasting multi-line text splits it into an outline of blocks; `Cmd+Shift+V` pastes it as one block instead.',
      `Copy a block ref / embed: ${km.copyRef}. (See **Links & references** for what those are.)`,
      'Paste an image (or any file) straight into your notes and it renders inline right where you pasted. What lands there is a block ref to a reusable media asset — copy that ref anywhere else and the same image renders there too.',
      'On a phone, the keyboard toolbar has an **Insert image** button. If an upload fails (offline, say), run **Retry failed media uploads** from the command palette once you\'re back.',
    ]),

    advancedSect('Settings — preferences, shortcuts, themes & extensions', [
      `Open preferences: run **Open preferences** from the command palette (${sharedKeys.commandPalette}) — it has no default shortcut.`,
      'Remap any shortcut: run **Customize keyboard shortcuts** from the command palette. It lists every action grouped by context — click a binding and press the new keys to rebind it, or reset / disable it; conflicts are flagged, and your overrides sync to your other devices. **Shortcuts & gestures** can rebind too: press the chord there, then the pencil.',
      'Change the look: run **Cycle through themes** from the command palette. Eight ship built-in — light and dark variants of Sunset Warm, Indigo, and Solarized, plus a plain Light and Dark — and extensions can register their own.',
      "Run **Manage extensions** from the command palette to open the extensions tree — extensions can be toggled on or off there (a few core ones are essential and locked on), and the toggle syncs to your other devices. Vim mode itself is an extension (`system:vim-normal-mode`); it's off by default. Tick it to get vim normal-mode keys — the tutorial written for them is [[Tutorial (vim)]] — or untick it for the default click-to-edit experience." + km.colemakNote,
      'Keep a backup the browser can\'t wipe: in desktop Chrome or Edge, **Mirror database to a folder (backup settings)** copies this device\'s database into a folder you choose, on a schedule, while the app is idle.',
      'Coming from Roam? Run **Import Roam JSON export** from the command palette to bring a graph in.',
    ]),

    advancedSect('On mobile', [
      'On a phone-sized screen the app swaps in touch affordances:',
      'A **bottom navigation bar** gives one-tap access to the sidebar, a new block, append-to-today, today\'s daily note, search, the command palette, and undo.',
      'While editing, a **keyboard toolbar** floats above the on-screen keyboard with indent / outdent, move up / down, `[[` page-reference and `((` block-reference inserts, comment and suggest-edit buttons, an insert-image button, undo / redo, and a Done button to dismiss the keyboard.',
      '**Hold a block\'s text** for half a second to select it; then tap other blocks to add or remove them. A toolbar along the bottom acts on the selection: outdent, indent, move up / down, **Move to…**, undo, and done.',
      '**Hold a bullet**, then drag, to move its block (the whole selection, if the block is in it). Hold and let go without moving to open the block\'s menu.',
      {
        content: '**Swipe a block** to reveal its quick-actions menu — Copy, Copy Ref / Embed, Open in panel, Properties, Collapse, Zoom in, Delete. This is the touch route to per-block actions.',
        children: [
          { content: 'Other features add items of their own: **Reschedule** for dated blocks, and the four SRS grades.' },
          { content: '**Commands** focuses the block and opens the command palette; with vim mode on it also lists that block\'s own commands (without vim it shows only the app-wide ones).' },
          { content: 'Desktop\'s equivalent is the bullet\'s right-click menu; vim binds many of the same actions to keys (`z`, `t`, `y r`, …).' },
        ],
      },
      'Swipe a block to the right to cycle its todo / done state.',
      'Scrub a date: drag a **dated** block sideways with **two fingers** — right moves the date forward, left back, with an overlay previewing the new date as you drag. Two fingers so it never clashes with one-finger scroll or the swipe menu. For a bigger jump, the swipe menu has a **Reschedule** sheet.',
    ]),

    advancedSect('Workspaces & encryption', [
      'A workspace is an independent collection of blocks — many top-level pages and daily notes, not a single tree. Create or switch workspaces from the workspace switcher in the left sidebar; you start as the owner and can invite others from **Workspace settings**.',
      'New workspaces can be **end-to-end encrypted** — tick "End-to-end encrypted" when creating one. Block content and properties are then encrypted on your device before syncing; the server only ever stores ciphertext.',
      'You hold the only key. The app shows the **workspace key once** and makes you save it (a password manager is ideal) and retype its last characters to confirm. There is **no recovery** — lose the key and the data becomes permanently unreadable. On a new device, paste the key to unlock.',
      'An existing workspace can be encrypted too: **Workspace settings** → **Encrypt this workspace…** (owner only, in desktop Chrome or Edge, with every other device and tab closed). It walks you through saving the key and a recovery copy, then re-seals everything on the server. It can\'t be undone.',
      'To collaborate on an encrypted workspace, invite the person via **Workspace settings**, then send them the key yourself over a channel you trust — the app never transmits it.',
    ]),

    advancedSect('Extensions', [
      '**Everything** in this app — the renderer, the vim plugin, daily notes — is an extension, and you can author your own. See [[extensions]] for how they load, a set of working examples, and a renderer demo to enable and play with.',
    ]),

    advancedSect('Agents — Claude and scripts in this workspace', [
      'Agents and scripts work on this workspace through the app itself: a command-line bridge talks to a running tab, so keep one open.',
      'Install it: `npm i -g @knowledge-medium/agent-cli` (Node 24 or later). That gives you the `kmagent` command and an MCP server, `km-mcp`. (Prefer not to install? Prefix commands with `npx @knowledge-medium/agent-cli` instead of `kmagent`.)',
      'Pair once: run `kmagent connect`, open the link it prints, generate a token in the **Pair agent CLI** dialog, and paste it into the waiting terminal. `kmagent ping` checks the connection.',
      {
        content: 'A few commands once paired:',
        children: [{
          content: markdownTable(['Command', 'What it does'], [
            ['`kmagent subtree today`', 'Prints today\'s daily note as an outline'],
            ['`kmagent search "project notes"`', 'Full-text search, with where each hit lives'],
            ['`kmagent append-markdown today -- \'- a new idea\'`', 'Adds an outline under a block, page or date'],
            ['`kmagent sql all "SELECT id, content FROM blocks LIMIT 5"`', 'SQL against this device\'s copy of the workspace'],
            ['`kmagent eval \'return repo.activeWorkspaceId\'`', 'Runs JavaScript inside the app'],
          ]),
        }],
      },
      'For an MCP client such as Claude Code or Claude Desktop, add the server `km-mcp`, e.g. `{"mcpServers": {"km": {"command": "km-mcp"}}}`. Its tools read pages, search, follow backlinks, and write blocks, comments and media; they can\'t run code in the app.',
      'Agents write as **contributors**: create one with `kmagent contributor create "Research assistant" --kind agent` (or the MCP `create_contributor` tool) before an agent edits. A block an agent created or edited shows a small badge naming it; click it to see who did what. Your own edits carry no badge.',
      `**Agent dispatch** (\`@knowledge-medium/agent-dispatch\`) is a small daemon that answers mentions: link the agent's page (by default, the page named claude) in a block or a comment along with your request, and it runs Claude Code (or Codex) with these tools and writes the reply back as a child block. A chip on the block shows it queued, working and replied. To ask about one block directly: ${km.askAgent}.`,
      'Every command, the security model and the environment overrides are in the `@knowledge-medium/agent-cli` README.',
    ]),

    // Last and expanded: the reference a reader comes back to.
    sect('Cheat sheet', [
      htmlDocument(cheatSheetDocument(variant)),
      'For everything else — and only what applies where you are — open **Shortcuts & gestures** with the **Help** button.',
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

// A section that seeds collapsed — the deeper / optional topics, so the page
// opens as a scannable outline of essentials and expanding IS folding in action.
const advancedSect = (
  title: string,
  children: ReadonlyArray<string | TutorialNode>,
): TutorialNode => ({
  ...sect(title, children),
  properties: { [isCollapsedProp.name]: true },
})

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
 *      properties) — and optionally a try-it block with instructions for
 *      adding the gating property after enabling the extension.
 */
export const extensionsPageOutline = (): TutorialNode[] => [
  { content: '**Anything** in this app is an extension — the default block renderer, the vim plugin, daily notes, find-and-replace. The host loads core ones at startup; the rest are blocks like the ones below.' },
  { content: "An extension block is a block with `types = ['extension']`. Its content is a TS/JSX module whose `default` export is an `AppExtension` — a `FacetContribution`, an array of them, or a function returning one. Imports resolve through the page-global importmap, so importing a symbol from its real module (e.g. `@/extensions/core.js`) returns the same module instance the running app uses." },
  { content: "Author one: create a block, give it `types = ['extension']`, paste the source, then run **Manage extensions** from the command palette and tick the row to enable it." },
  { content: 'User extensions start **disabled**. The **Manage extensions** tree lets you toggle each row; the choice syncs to your other devices and persists across reloads.' },
  { content: "After editing an extension's source, run **Reload extensions** from the command palette to pick up your changes." },
  { content: 'Re-insert these examples under a block: with your caret in it, run **Insert example extensions under current block** from the command palette (`Cmd+K`). On touch — or from a focused, not-editing block — it needs vim mode: `Cmd+K` on desktop, the swipe menu\'s **Commands** on a phone.' },
  ...exampleExtensions.map(exampleSection),
]

/**
 * Wraps a single example extension in a title bullet. Children are:
 * (1) a `how to use` bullet, (2) the source block, and (optionally)
 * (3) a try-it demo block with instructions for setting its gating property.
 */
const exampleSection = (example: (typeof exampleExtensions)[number]): TutorialNode => {
  const sourceBlock: TutorialNode = {
    content: example.source,
    type: EXTENSION_TYPE,
    typeProperties: {
      [extensionNameProp.name]: example.name,
      [extensionDescriptionProp.name]: example.description,
    },
  }

  const children: TutorialNode[] = [
    { content: `**How to use:** Enable it via **Manage extensions**, then ${HOW_TO_USE[example.id]}` },
    sourceBlock,
  ]
  const demo = TRY_IT_BLOCK[example.id]
  if (demo) children.push(demo)

  return { content: example.name, children }
}

// Keyed by `ExampleExtensionDefinition.id` — what drives each demo once
// enabled. Rendered after a shared "Enable it via Manage extensions, then"
// prefix (see `exampleSection`), so each entry starts mid-sentence.
const HOW_TO_USE: Record<string, string> = {
  'hello-renderer': 'add the property `user:hello = true` to any block — its content area will render with the custom hello variant.',
  'fold-all-action': '(with vim mode on, so the focused block is in normal mode) press `Cmd+Shift+U` — every visible descendant of the current view\'s root folds or unfolds together.',
  'emoji-react': "Alt+click any block (or, with vim mode on, focus a block and press `Cmd+Shift+E`) — cycles a 🔥 / 👍 / 🎉 / ❤️ reaction below the block's content.",
  'kudos-facet': "set a block's `renderer` property to `kudos-banner` — the block renders with the Kudos banner appended. Other extensions can contribute to the `user.kudos` facet to extend it.",
  'split-layout': "add the property `user:layout = split` to any block — its content and children will render side by side instead of stacked.",
  'layout-renderer-override': 'every panel gets wrapped in a custom debug-style frame. Untick the row to revert. (No per-block property — applies workspace-wide.)',
  'default-renderer-placeholder': 'empty blocks show a muted "empty block" placeholder in read mode (it swaps the fallback renderer). Untick to revert. (Applies workspace-wide.)',
}

// Demo properties belong to disabled extensions; users set them after enabling
// the owner so its definition exists before the first value is written.
const TRY_IT_BLOCK: Record<string, TutorialNode | undefined> = {
  'hello-renderer': {
    content: 'Try it: enable `hello-renderer` above, then add the property `user:hello = true` to this block to render its content with the custom variant.',
  },
  'split-layout': {
    content: 'Try it: enable `split-layout` above, then add the property `user:layout = split` to this block to render its content and children side by side. The bullet below me will appear to my right.',
    children: [
      { content: 'I sit beside the content in split mode.' },
    ],
  },
}
