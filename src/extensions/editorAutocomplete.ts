/** Central autocompletion extension. Reads `completionSourcesFacet`
 *  contributed by plugins and installs ONE `autocompletion({override})`
 *  per editor, avoiding the "Config merge conflict for field override"
 *  that CodeMirror throws when two plugins each call `autocompletion()`
 *  with their own override array.
 *
 *  Plugin authors should NOT call `autocompletion()` directly anymore —
 *  contribute a `CompletionSourceContribution` via the facet instead. */

import { autocompletion } from '@codemirror/autocomplete'
import { keymap } from '@codemirror/view'
import { completionKeymapWithEscapeFallthrough } from '@/utils/codemirrorCompletion.js'
import {
  codeMirrorExtensionsFacet,
  completionSourcesFacet,
  type CodeMirrorExtensionContribution,
} from './editor.ts'
import type { AppExtension } from './facet.ts'

const editorAutocompleteContribution: CodeMirrorExtensionContribution = (ctx) => {
  const runtime = ctx.repo.facetRuntime
  if (!runtime) return []
  const factories = runtime.read(completionSourcesFacet)
  if (factories.length === 0) return []
  const sources = factories.map(factory => factory(ctx))
  return [
    autocompletion({
      override: sources,
      defaultKeymap: false,
      icons: false,
      // Reuses the existing reference-autocomplete theme class so the
      // styles in `referenceAutocompleteTheme` (still contributed by
      // the references plugin) apply to every dropdown uniformly. A
      // plugin that needs distinct visual treatment can scope it via
      // the completion entry's `type` / `boost` instead of a separate
      // tooltip class.
      tooltipClass: () => 'tm-reference-autocomplete',
    }),
    keymap.of(completionKeymapWithEscapeFallthrough),
  ]
}

export const editorAutocompleteExtension: AppExtension =
  codeMirrorExtensionsFacet.of(editorAutocompleteContribution, {source: 'editor-autocomplete'})
