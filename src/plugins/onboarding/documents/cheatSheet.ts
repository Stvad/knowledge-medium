// The Tutorial's closing cheat sheet: an `html-document` block whose tabs are
// radio buttons, so it switches with no script and renders without the
// "Run scripts" prompt. Rows use the outline's own notation — `chord` spans
// become key caps — and the same accuracy invariant as `../keys.ts`.

import type { TutorialVariant } from '../outline'

type Row = readonly [action: string, keys: string]
interface Tab { title: string; rows: readonly Row[] }

const sharedNavigate: readonly Row[] = [
  ['Command palette: every action, searchable', '`Cmd+K`'],
  ['Find or create a page or block', '`Cmd+P`'],
  ['Find and replace', '`Cmd+Shift+F`'],
  ['Shortcuts & gestures (Help)', '`?` or `Cmd+/`'],
  ['Back / forward', '`Cmd+[` / `Cmd+]`'],
  ["Today's daily note", '`` Ctrl+Shift+` ``'],
  ['Previous / next daily note', '`Ctrl+Shift+[` / `Ctrl+Shift+]`'],
  ['New block on today, in the sidebar stack', '`Ctrl+Shift+N`'],
  ['Review due flashcards', '`Ctrl+Shift+R`'],
]

const sharedLinks: readonly Row[] = [
  ['Link → this panel', 'click'],
  ['Link → the main panel', '`Alt` + click'],
  ['Link → the sidebar stack', '`Shift` + click'],
  ['Link → a new panel', '`Shift+Alt` + click'],
  ['Link → a new browser tab', '`Cmd` + click'],
]

const sharedComments: readonly Row[] = [
  ['Comment on the selected text', '`Ctrl+Shift+/`'],
  ['Highlight the selected text', '`Ctrl+Shift+H`'],
  ['Suggest an edit to it', '`Ctrl+Shift+S`'],
  ['More, on rendered text', 'right-click the selection'],
]

const tabs: Record<TutorialVariant, readonly Tab[]> = {
  default: [
    {title: 'Write', rows: [
      ['Edit a block', 'click its text'],
      ['Stop editing', '`Esc`'],
      ['New block / line break', '`Enter` / `Shift+Enter`'],
      ['Indent / outdent', '`Tab` / `Shift+Tab`'],
      ['Fold / unfold (editing)', '`Cmd+↑` / `Cmd+↓`'],
      ['Link the selected text', '`Cmd+Shift+L`'],
      ['Tag with a type', 'type `#`'],
      ['Cycle a todo (editing)', '`Cmd+Enter`'],
      ['Undo / redo', '`Cmd+Z` / `Cmd+Shift+Z`'],
    ]},
    {title: 'Move', rows: [
      ['Hop to the block above / below (editing)', '`↑` / `↓` at the edge'],
      ['Move a block up / down (editing)', '`Cmd+Shift+↑` / `Cmd+Shift+↓`'],
      ['Move a block anywhere', 'drag its bullet'],
      ['Zoom in / out (editing)', '`Cmd+.` / `Cmd+,`'],
      ['Select blocks (editing)', '`Shift+↑` / `Shift+↓` at the edge'],
      ['Extend / toggle the selection', '`Shift` + click / `Cmd` + click'],
      ['Cut the selection, then move it', '`Cmd+X`, then `Cmd+V` where it goes'],
      ['Delete the selection', '`Delete`'],
      ['Clear the selection', '`Esc`'],
    ]},
    {title: 'Navigate', rows: sharedNavigate},
    {title: 'Panels', rows: [
      ['Open in the sidebar stack (editing)', '`Cmd+Shift+.`'],
      ['Close the panel (editing)', '`Ctrl+W`'],
      ['Maximize / restore (editing)', '`Cmd+Shift+\\`'],
      ...sharedLinks,
    ]},
    {title: 'Comments', rows: [
      ...sharedComments,
      ['Show / hide a block\'s threads (editing)', '`Ctrl+Shift+M`'],
    ]},
  ],
  vim: [
    {title: 'Write', rows: [
      ['Edit / edit at the end', '`i` / `a`'],
      ['Stop editing', '`Esc`'],
      ['New block below / above', '`o` / `Shift+O`'],
      ['Indent / outdent', '`Tab` / `Shift+Tab`'],
      ['Fold / unfold', '`z`'],
      ['Link the selected text (editing)', '`Cmd+Shift+L`'],
      ['Tag with a type', 'type `#`'],
      ['Undo / redo', '`u` / `Ctrl+R`'],
    ]},
    {title: 'Move', rows: [
      ['Next / previous block', '`j` / `k`'],
      ['First / last block', '`gg` / `Shift+G`'],
      ['Jump about 8 blocks', '`Ctrl+d` / `Ctrl+u`'],
      ['Move a block down / up', '`Cmd+Shift+J` / `Cmd+Shift+K`'],
      ['Move a block anywhere', 'drag its bullet'],
      ['Zoom in / out', '`Cmd+.` / `Cmd+,`'],
      ['Select, then grow the selection', '`Space` then `Shift+J` / `Shift+K`'],
      ['Cut to move / paste after / before', '`Cmd+X` / `p` / `Shift+P`'],
      ['Delete', '`d d`'],
    ]},
    {title: 'Navigate', rows: [
      ['Panel to the left / right', '`h` / `l`'],
      ...sharedNavigate,
    ]},
    {title: 'Panels', rows: [
      ['Open in the sidebar stack', '`Cmd+Shift+.`'],
      ['Close the panel', '`Ctrl+W`'],
      ['Maximize / restore', '`Cmd+Shift+\\`'],
      ['Copy a reference / an embed', '`y r` / `y e`'],
      ...sharedLinks,
    ]},
    {title: 'Comments', rows: [
      ['Comment on the focused block', '`Ctrl+Shift+/`'],
      ...sharedComments,
      ['Show / hide a block\'s threads', '`Ctrl+Shift+M`'],
    ]},
  ],
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** `` `Cmd+Shift+L` `` → key caps; text outside backticks stays text. A chord's
 *  `+` splits keys unless it is the key itself (a trailing `+`). Double-backtick
 *  spans (`` `` ` `` ``) hold a lone backtick, as in the outline. */
export const renderKeys = (keys: string): string =>
  keys.split(/(``\s.*?\s``|`[^`]+`)/).map(part => {
    const chord = part.startsWith('``') ? part.slice(2, -2).trim()
      : part.startsWith('`') ? part.slice(1, -1)
        : null
    if (chord === null) return escapeHtml(part)
    return chord.split(' ').map(step =>
      step.split(/\+(?=.)/).map(key => `<kbd>${escapeHtml(key)}</kbd>`).join('+'),
    ).join(' ')
  }).join('')

const STYLE = `
  body { margin: 12px 14px; font-size: 14px; line-height: 1.4; }
  h3 { margin: 0 0 4px; font-size: 1rem; }
  p.note { margin: 0 0 10px; color: hsl(var(--muted-foreground)); font-size: 12px; }
  .tabs > input { position: absolute; opacity: 0; pointer-events: none; }
  .bar { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid hsl(var(--border)); margin-bottom: 8px; }
  .bar label { padding: 4px 10px; border-radius: calc(var(--radius) - 2px) calc(var(--radius) - 2px) 0 0; cursor: pointer; color: hsl(var(--muted-foreground)); }
  .bar label:hover { background: hsl(var(--muted)); color: hsl(var(--foreground)); }
  table { display: none; width: 100%; border-collapse: collapse; }
  td { padding: 4px 6px; border-bottom: 1px solid hsl(var(--border) / .6); vertical-align: top; }
  td:last-child { text-align: right; white-space: nowrap; color: hsl(var(--muted-foreground)); }
  kbd { display: inline-block; min-width: 1.4em; padding: 0 5px; border: 1px solid hsl(var(--border)); border-bottom-width: 2px; border-radius: 4px; background: hsl(var(--card)); color: hsl(var(--card-foreground)); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; }
  @media (max-width: 420px) { td:last-child { white-space: normal; } }
`

const tabCss = (count: number): string =>
  Array.from({length: count}, (_, i) =>
    `#tab-${i}:checked ~ .bar label[for="tab-${i}"] { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }\n` +
    `#tab-${i}:focus-visible ~ .bar label[for="tab-${i}"] { outline: 2px solid hsl(var(--ring)); }\n` +
    `#tab-${i}:checked ~ table.tab-${i} { display: table; }`,
  ).join('\n')

export const cheatSheetDocument = (variant: TutorialVariant): string => {
  const variantTabs = tabs[variant]
  const inputs = variantTabs.map((_, i) =>
    `<input type="radio" name="tab" id="tab-${i}"${i === 0 ? ' checked' : ''}>`).join('')
  const labels = variantTabs.map((tab, i) => `<label for="tab-${i}">${escapeHtml(tab.title)}</label>`).join('')
  const tables = variantTabs.map((tab, i) =>
    `<table class="tab-${i}">${tab.rows.map(([action, keys]) =>
      `<tr><td>${escapeHtml(action)}</td><td>${renderKeys(keys)}</td></tr>`).join('')}</table>`,
  ).join('\n')
  return `<!doctype html>
<title>Cheat sheet</title>
<style>${STYLE}${tabCss(variantTabs.length)}</style>
<h3>Cheat sheet${variant === 'vim' ? ' (vim)' : ''}</h3>
<p class="note">Mac keys: on Linux and Windows read Cmd as Ctrl. Ctrl chords are Ctrl everywhere.</p>
<div class="tabs">${inputs}<div class="bar">${labels}</div>
${tables}
</div>
`
}
