import type { Extension as CodeMirrorExtension } from '@codemirror/state'
import type { Block } from '@/data/block.js'
import type { AnyPropertySchema } from '@/data/api'
import type { Repo } from '@/data/repo.js'
import { defineFacet, isFunction } from '@/facets/facet.js'

export interface CodeMirrorExtensionContext {
  repo: Repo
  /** The block the editor edits. Absent in a draft editor (`DraftEditor`),
   *  whose text becomes a block only once it is submitted: a contribution that
   *  reads or writes the block contributes nothing there. */
  block?: Block
  /** Storage mode supplied by the renderer. */
  childBacked?: boolean
  /** Present on direct value children rendered in a property field. */
  propertyValueSchema?: AnyPropertySchema
  /** UI state and render location used for editor focus handoff. */
  uiStateBlock?: Block
  renderScopeId?: string
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
