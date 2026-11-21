import { completionKeymap, type CompletionContext } from '@codemirror/autocomplete'
import type { KeyBinding } from '@codemirror/view'

/** Where a trigger-based completion source should stop reading its query.
 *
 *  CodeMirror anchors every `CompletionContext` at `state.selection.main.from`
 *  (`cur()` in @codemirror/autocomplete, since 6.5.0) — not at the head. With a
 *  plain caret the two coincide, so `context.pos` is the caret and nothing
 *  here changes. But `closeBrackets` wrapping a *selection* leaves a range
 *  behind: select `world`, type `[` `[`, and you get `[[world]]` with `world`
 *  still selected. That range's `from` sits immediately after the `[[`, so a
 *  source that reads its query up to `context.pos` sees the empty string and
 *  offers bare-trigger suggestions instead of completing on the text the user
 *  just wrapped.
 *
 *  Read to the end of the selection instead. The wrapped text is the query,
 *  and a source that reports this as its result `to` has the whole selection
 *  replaced when a completion is accepted.
 *
 *  The `pos === from` guard is defence in depth — the autocomplete plugin
 *  always builds the context at `cur()` — so that a context handed some other
 *  position keeps that position rather than silently jumping to the selection
 *  end. */
export const completionQueryEnd = ({state, pos}: CompletionContext): number => {
  const selection = state.selection.main
  return pos === selection.from ? selection.to : pos
}

const handlesEscape = (binding: KeyBinding) =>
  binding.key === 'Escape' ||
  binding.mac === 'Escape' ||
  binding.linux === 'Escape' ||
  binding.win === 'Escape'

export const completionKeymapWithEscapeFallthrough: readonly KeyBinding[] =
  completionKeymap
    .filter(binding => !handlesEscape(binding))
    .map(binding => ({...binding, stopPropagation: true}))
