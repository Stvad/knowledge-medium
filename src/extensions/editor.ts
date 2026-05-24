import type { CompletionSource } from '@codemirror/autocomplete'
import type { Extension as CodeMirrorExtension } from '@codemirror/state'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { defineFacet, isFunction } from './facet.ts'

export interface CodeMirrorExtensionContext {
  repo: Repo
  block: Block
}

export type CodeMirrorExtensionContribution =
  (context: CodeMirrorExtensionContext) => readonly CodeMirrorExtension[]

export type CodeMirrorExtensionResolver =
  (context: CodeMirrorExtensionContext) => readonly CodeMirrorExtension[]

export const codeMirrorExtensionsFacet = defineFacet<
  CodeMirrorExtensionContribution,
  CodeMirrorExtensionResolver
>({
  id: 'core.codemirror-extensions',
  combine: contributions => context =>
    contributions.flatMap(contribution => contribution(context)),
  empty: () => () => [],
  validate: isFunction<CodeMirrorExtensionContribution>,
})

/** Per-block CodeMirror completion source contribution.
 *
 *  CodeMirror's `autocompletion({override})` config can only be set
 *  once per editor — calling `autocompletion()` from two plugins with
 *  different `override` arrays throws "Config merge conflict for field
 *  override". Plugins that want to add a completion dropdown contribute
 *  a factory here; a single central CM extension (wired in
 *  `defaultEditorInteractions`) reads the facet, builds every source
 *  with the per-block context, and installs one `autocompletion()`
 *  extension whose `override` is the combined list.
 *
 *  Contributing a factory (rather than a constructed `CompletionSource`)
 *  is what lets sources close over `{repo, block}` — same shape every
 *  existing source already needs. */
export type CompletionSourceContribution =
  (context: CodeMirrorExtensionContext) => CompletionSource

export const completionSourcesFacet = defineFacet<
  CompletionSourceContribution,
  readonly CompletionSourceContribution[]
>({
  id: 'core.completion-sources',
  combine: contributions => contributions,
  empty: () => [],
  validate: isFunction<CompletionSourceContribution>,
})
