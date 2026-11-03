import type { Extension as CodeMirrorExtension } from '@codemirror/state'
import type { Block } from '@/data/block.js'
import type { Repo } from '@/data/repo.js'
import { defineFacet, isFunction } from '@/facets/facet.js'

export interface CodeMirrorExtensionContext {
  repo: Repo
  /** The block the editor edits. Absent in a draft editor (`DraftEditor`),
   *  whose text becomes a block only once it is submitted: a contribution that
   *  reads or writes the block contributes nothing there. */
  block?: Block
}

/** The context of an editor bound to a block. */
export type BlockEditorExtensionContext = CodeMirrorExtensionContext & {block: Block}

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
