/** CodeMirror surface for the supertags plugin: the `#` completion
 *  source contributed via `EditorState.languageData`, picked up by the
 *  single central `autocompletion()` call in
 *  `src/editor/autocomplete.ts` (which also themes the dropdown).
 *
 *  Candidates come from the live merged type registry (`repo.types` —
 *  kernel + plugin + user-defined). Picking an existing type calls
 *  `repo.addType`; picking the `Create type "…"` sentinel first
 *  materializes a type-definition block via `createTypeBlock` (which
 *  resolves only once the new id is live in the registry) and then
 *  tags the block with it. */

import { EditorState } from '@codemirror/state'
import type { CompletionSource } from '@codemirror/autocomplete'
import type {
  CodeMirrorExtensionContext,
  CodeMirrorExtensionContribution,
} from '@/editor/codeMirrorExtensions.js'
import { getBlockTypes } from '@/data/properties'
import { createTypeBlock } from '@/data/typeExtraction'
import {
  buildTypeTagCandidates,
  typeTagCompletionSource,
  type TypeTagCandidate,
} from './typeAutocomplete'

const buildTypeTagSource = ({repo, block}: CodeMirrorExtensionContext): CompletionSource => {
  const getCandidates = (query: string): TypeTagCandidate[] => {
    // The block is being edited, so its row is in cache; peek instead
    // of get so a just-deleted block degrades to "no current types"
    // rather than throwing mid-keystroke.
    const data = block.peek()
    return buildTypeTagCandidates({
      registry: repo.types,
      currentTypeIds: data ? getBlockTypes(data) : [],
      query,
    })
  }

  const pickType = async (candidate: TypeTagCandidate): Promise<void> => {
    if (candidate.kind === 'existing') {
      await repo.addType(block.id, candidate.id)
      return
    }
    const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId
    if (!workspaceId) {
      throw new Error('no workspace to create the type in')
    }
    const typeId = await createTypeBlock(repo, {
      workspaceId,
      label: candidate.label,
      propertySchemaIds: [],
    })
    await repo.addType(block.id, typeId)
  }

  return typeTagCompletionSource({getCandidates, pickType})
}

export const supertagsCodeMirrorExtensions: CodeMirrorExtensionContribution = (ctx) => {
  const source = buildTypeTagSource(ctx)
  return [EditorState.languageData.of(() => [{autocomplete: source}])]
}
