/** CodeMirror surface for the supertags plugin: the `#` completion
 *  source contributed via `EditorState.languageData`, picked up by the
 *  single central `autocompletion()` call in
 *  `src/editor/autocomplete.ts` (which also themes the dropdown).
 *
 *  Candidates come from the live merged type registry (`repo.types` —
 *  kernel + plugin + user-defined, minus `structural` plumbing).
 *
 *  Pick semantics: the source deletes the `#query` trigger text from
 *  the view optimistically; `pickType` here commits the tag AND the
 *  matching content deletion in ONE tx. The single tx is load-bearing:
 *  a types change remounts the per-block editor (types participate in
 *  `DefaultBlockRenderer`'s slot identity), and the fresh editor seeds
 *  from the cache — if the cached content still held the trigger text
 *  (the editor's own persistence is a 300ms-debounced `setContent`),
 *  the deleted text would resurrect under the user's cursor and could
 *  permanently fork from what they type next.
 *
 *  Picking the `Create type "…"` sentinel re-checks the registry for a
 *  same-named type first (an earlier create may not have published
 *  when the sentinel was built — without the re-check, tagging two
 *  blocks `#Recipe` in quick succession mints two "Recipe" types),
 *  then materializes a definition block via `createTypeBlock` (which
 *  resolves only once the new id is live in the registry).
 *
 *  Failures surface as a toast + trigger-text restore (handled by the
 *  source; `restoreTrigger` covers the unmounted-view case). */

import { EditorState } from '@codemirror/state'
import type { CompletionSource } from '@codemirror/autocomplete'
import type {
  CodeMirrorExtensionContext,
  CodeMirrorExtensionContribution,
} from '@/editor/codeMirrorExtensions.js'
import { ChangeScope } from '@/data/api'
import { getBlockTypes } from '@/data/properties'
import { createTypeBlock } from '@/data/typeExtraction'
import { showError } from '@/utils/toast'
import {
  buildTypeTagCandidates,
  findTaggableTypeByName,
  typeTagCompletionSource,
  type TypeTagCandidate,
} from './typeAutocomplete'

/** Exported for the integration test — production wiring goes through
 *  `supertagsCodeMirrorExtensions` below. */
export const buildTypeTagSource = ({repo, block}: CodeMirrorExtensionContext): CompletionSource => {
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

  /** Tag + trigger-text removal in one tx (see module doc for why the
   *  atomicity matters). The content edit mirrors what the view already
   *  did: remove the first occurrence of the trigger text if the cached
   *  content still carries it (it won't if the editor's debounced
   *  `setContent` won the race — that's fine, the deletion already
   *  persisted). */
  const applyTag = async (typeId: string, triggerText: string): Promise<void> => {
    await repo.tx(async tx => {
      const data = await tx.get(block.id)
      if (!data || data.deleted) return
      await repo.addTypeInTx(tx, block.id, typeId)
      const idx = data.content.indexOf(triggerText)
      if (idx !== -1) {
        await tx.update(block.id, {
          content: data.content.slice(0, idx) + data.content.slice(idx + triggerText.length),
        })
      }
    }, {scope: ChangeScope.BlockDefault, description: `tag type ${typeId}`})
  }

  const pickType = async (
    candidate: TypeTagCandidate,
    {triggerText}: {triggerText: string},
  ): Promise<void> => {
    try {
      if (candidate.kind === 'existing') {
        await applyTag(candidate.id, triggerText)
        return
      }
      // Create flow — reuse a same-named type that published since the
      // candidate list was built, else mint the definition block.
      const existing = findTaggableTypeByName(repo.types, candidate.label)
      let typeId = existing?.id
      if (!typeId) {
        const workspaceId = block.peek()?.workspaceId ?? repo.activeWorkspaceId
        if (!workspaceId) {
          throw new Error('no workspace to create the type in')
        }
        typeId = await createTypeBlock(repo, {
          workspaceId,
          label: candidate.label,
          propertySchemaIds: [],
        })
      }
      await applyTag(typeId, triggerText)
    } catch (err) {
      showError(candidate.kind === 'create'
        ? `Couldn't create type "${candidate.label}"`
        : `Couldn't tag with "${candidate.label}"`)
      throw err
    }
  }

  // Unmounted-view fallback for a failed pick's trigger-text restore:
  // read-modify-write the stored content, appending the text back where
  // the (already persisted) deletion left off — i.e. at the end of what
  // the user had typed before the pick.
  const restoreTrigger = async ({triggerText}: {triggerText: string}): Promise<void> => {
    await repo.tx(async tx => {
      const data = await tx.get(block.id)
      if (!data || data.deleted) return
      if (data.content.includes(triggerText)) return
      await tx.update(block.id, {content: data.content + triggerText})
    }, {scope: ChangeScope.BlockDefault, description: 'restore type-tag trigger text'})
  }

  return typeTagCompletionSource({getCandidates, pickType, restoreTrigger})
}

export const supertagsCodeMirrorExtensions: CodeMirrorExtensionContribution = (ctx) => {
  const source = buildTypeTagSource(ctx)
  return [EditorState.languageData.of(() => [{autocomplete: source}])]
}
