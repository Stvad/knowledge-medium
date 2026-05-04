import type { Extension as CodeMirrorExtension } from '@codemirror/state'
import type { Block } from '@/data/block.ts'
import type { Repo } from '@/data/repo.ts'
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
