import { defineVerbFacet } from '@/facets/verbFacet.ts'
import type { PasteChordIntent } from './operations.ts'

/**
 * What the editor should do with a paste. The default impl reproduces the
 * historical hardcoded branching; plugins override the decision to
 * customize when pasted content splits into an outline vs lands as-is
 * (e.g. CSV → table rows, URL → titled link, source-dialect parsing).
 *
 * There are exactly two terminal actions — there is intentionally no
 * "let the browser paste natively" option: the editor always takes over
 * the paste (it `preventDefault`s synchronously, and the decision resolves
 * synchronously too — see `runSync`), so "native" single-line insert IS
 * `single-block` with the raw text.
 */
export type PasteDecision =
  /** Drop the (optionally rewritten) text into the current block, newlines
   *  kept. For single-line text this is an ordinary caret insert; for
   *  multiline it's Roam's "paste as plain text". */
  | {kind: 'single-block'; text?: string}
  /** Parse the (optionally rewritten) text as markdown and split it into a
   *  block tree at the cursor. */
  | {kind: 'split'; text?: string}

/** Where the paste is happening. `editor` has a text caret (in-block
 *  editing), so a plain single-line paste lands verbatim at the caret;
 *  `shell` is a focused-but-not-editing block with no caret, so the
 *  historical behavior is to parse the clipboard as an outline. The
 *  default decision is surface-aware for exactly this single-line case;
 *  plugins also get the surface to vary their own behavior.
 *
 *  Plugin authors: because the *default* differs by surface, a plain
 *  single-line clipboard yields `single-block` in the `editor` but `split`
 *  in the `shell`. An override that wants surface-uniform behavior for that
 *  case must return its own decision rather than deferring to `next` /
 *  `defaultPasteDecision`. */
export type PasteSurface = 'editor' | 'shell'

/** Caret/selection on the editor surface at paste time. The decision is
 *  resolved synchronously (`runSync`), so an override sees the live paste-time
 *  caret and has no opportunity to move it mid-decision. Present only on the
 *  `editor` surface (see the `surface ⟺ caret` invariant on `PasteRequest`).
 *  Lets overrides vary by position (e.g. title line 1 vs body line 2+) without
 *  re-deriving it from the DOM. */
export interface PasteCaret {
  /** 1-based line of the caret WITHIN the block's editor document
   *  (`doc.lineAt(from).number`). A block is usually one logical line but
   *  keeps newlines after a single-block paste, so this can exceed 1. This
   *  is an editor-doc line, NOT an outline position. */
  line: number
  /** Total lines in the block's editor document (`doc.lines`); `line ===
   *  lineCount` ⟺ caret on the last line. */
  lineCount: number
  /** Selection range as character offsets in the block's editor document;
   *  `from === to` for a bare caret with no selection. */
  from: number
  to: number
}

/** A paste to decide on. Modeled as a discriminated union on `surface` so
 *  the invariant `surface === 'editor' ⟺ caret is present` is enforced by
 *  the type, not by convention: the `editor` surface always has a text
 *  caret, the `shell` (focused-but-not-editing block, or programmatic /
 *  vim paste) never does. Overrides narrow on `surface` to read `caret`. */
export type PasteRequest = PasteRequestBase &
  ({surface: 'editor'; caret: PasteCaret} | {surface: 'shell'; caret?: undefined})

interface PasteRequestBase {
  /** Clipboard `text/plain`. */
  text: string
  /** Clipboard `text/html`, if any — lets format-aware overrides inspect
   *  richer content (tables, CSV pasted from a spreadsheet). */
  html?: string
  /** Latched paste chord: plain Cmd/Ctrl+V (`split`) vs Cmd/Ctrl+Shift+V
   *  (`single-block`). The paste `ClipboardEvent` carries no modifier
   *  state, so the renderer captures this on keydown. */
  intent: PasteChordIntent
}

/**
 * The historical paste decision, now the replaceable `defaultImpl` of the
 * paste verb:
 *   - `single-block` chord → verbatim into the current block.
 *   - plain chord with a newline → split into an outline.
 *   - plain chord, single line → `single-block` in the `editor` (a verbatim
 *     caret insert, like the browser's native paste) but `split` in the
 *     `shell` (no caret; parse as an outline, the historical behavior).
 *
 * Because the default never returns `single-block` for a single-line shell
 * paste, the shell can honor `single-block` literally (no extra guard): the
 * applied behavior always matches the decision, and an "always paste
 * verbatim" plugin works on single-line shell pastes too.
 */
export const defaultPasteDecision = (request: PasteRequest): PasteDecision => {
  if (request.intent === 'single-block') return {kind: 'single-block'}
  if (request.text.includes('\n')) return {kind: 'split'}
  return request.surface === 'editor' ? {kind: 'single-block'} : {kind: 'split'}
}

/**
 * The paste verb — the first home of `defineVerbFacet` outside
 * navigation. Decides, per paste, how clipboard content lands in the
 * outline. Plugins contribute:
 *   - `pasteDecisionVerb.impl(fn)`      — replace the decision wholesale,
 *   - `pasteDecisionVerb.decorator(fn)` — wrap it (e.g. rewrite CSV →
 *     markdown then defer to `next`),
 *   - `pasteDecisionVerb.before/after`  — observe pastes.
 * With no contributions the decision is `defaultPasteDecision`, so the editor
 * behaves exactly as before the seam existed. Call sites resolve it with
 * `runSync` (the decision is pure and is needed at the synchronous
 * `preventDefault` boundary), so `impl`/`decorator` contributions must be
 * **synchronous** — an async one violates the contract and falls back to
 * `defaultPasteDecision` (these are pure policy with no I/O; async before/after
 * observers are still fine, they're fire-and-forget).
 */
export const pasteDecisionVerb = defineVerbFacet<PasteRequest, PasteDecision>({
  id: 'core.paste-decision',
  defaultImpl: defaultPasteDecision,
  // Pure decision verb: a buggy plugin should degrade to the default decision,
  // not break paste. Safe because `defaultPasteDecision` (and any well-behaved
  // override) is effect-free — the renderers apply the side effect.
  onError: 'fallback',
  // Guard the renderers (which read `decision.kind`/`.text` right after
  // `preventDefault`) against an untyped plugin returning `undefined`/`{}`:
  // an invalid shape falls back to `defaultPasteDecision`.
  validateResult: decision =>
    decision != null &&
    (decision.kind === 'single-block' || decision.kind === 'split') &&
    (decision.text === undefined || typeof decision.text === 'string'),
})
