/** Central autocompletion installer.
 *
 *  Calls `autocompletion()` exactly once per editor. No `override` —
 *  sources are collected from CodeMirror's `EditorState.languageData`
 *  facet (the `autocomplete` field on each data entry), which plugins
 *  contribute to via their own `codeMirrorExtensionsFacet` registration.
 *  This is the CM-native contributory path; multiple language-data
 *  callbacks just concat. */

import { autocompletion } from '@codemirror/autocomplete'
import { keymap } from '@codemirror/view'
import { completionKeymapWithEscapeFallthrough } from '@/utils/codemirrorCompletion.js'
import {
  codeMirrorExtensionsFacet,
  type CodeMirrorExtensionContribution,
} from './editor.ts'
import type { AppExtension } from '@/facets/facet.js'

const editorAutocompleteContribution: CodeMirrorExtensionContribution = () => [
  autocompletion({
    defaultKeymap: false,
    icons: false,
    // Reuses the existing reference-autocomplete theme class so the
    // styles in `referenceAutocompleteTheme` (contributed by the
    // references plugin) apply to every dropdown uniformly. A plugin
    // that needs distinct visual treatment can scope it via the
    // completion entry's `type` / `boost` instead.
    tooltipClass: () => 'tm-reference-autocomplete',
  }),
  keymap.of(completionKeymapWithEscapeFallthrough),
]

export const editorAutocompleteExtension: AppExtension =
  codeMirrorExtensionsFacet.of(editorAutocompleteContribution, {source: 'editor-autocomplete'})
