/** CodeMirror surface for the supertags plugin: the `#` completion
 *  source contributed via `EditorState.languageData`, picked up by the
 *  single central `autocompletion()` call in
 *  `src/editor/autocomplete.ts` (which also themes the dropdown).
 *
 *  Candidates come from the live merged type registry (`repo.types` —
 *  kernel + plugin + user-defined, minus `hideFromCompletion`
 *  plumbing).
 *
 *  Pick semantics: the source deletes the `#query` command span from
 *  the view optimistically (including start/end separator whitespace
 *  when safe) and then flushes the editor (`flushEditorContent`, in the
 *  pick `apply`) so the stored row carries the deletion BEFORE `pickType`
 *  here tags the block. Flush-before-tag is load-bearing: a types change
 *  remounts the per-block editor (types participate in
 *  `DefaultBlockRenderer`'s slot identity), and the fresh editor seeds
 *  from the cache — if the cached content still held the command span
 *  (the editor's own persistence is otherwise a 300ms-debounced
 *  `setContent`), the deleted text would resurrect under the user's
 *  cursor and could permanently fork from what they type next. Because
 *  the flush lands the clean content first, `pickType` never writes
 *  content — the editor owns it.
 *
 *  Picking the `Create type "…"` sentinel re-checks the registry for a
 *  same-named type first (an earlier create may not have published
 *  when the sentinel was built — without the re-check, tagging two
 *  blocks `#Recipe` in quick succession mints two "Recipe" types),
 *  then materializes a definition block via `createTypeBlock` (which
 *  resolves only once the new id is live in the registry).
 *
 *  Failures surface as a toast + command-span restore (handled by the
 *  source; `restoreTrigger` covers the unmounted-view case). */

import { EditorState } from '@codemirror/state'
import type { CompletionSource } from '@codemirror/autocomplete'
import type {
  CodeMirrorExtensionContext,
  CodeMirrorExtensionContribution,
} from '@/editor/codeMirrorExtensions.js'
import { ChangeScope } from '@/data/api'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
import { getBlockTypes } from '@/data/properties'
import { createTypeBlock, typeifyBlockInTx } from '@/data/typeExtraction'
import { showError } from '@/utils/toast'
import {
  buildTypeTagCandidates,
  findCompletableTypeByName,
  planTriggerRestore,
  typeTagCompletionSource,
  type TypeTagCandidate,
  type TypeTagPickContext,
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

  /** Tag the block. Content is NOT touched here: the pick `apply`
   *  already stripped the command span from the view and flushed it to
   *  the row (see module doc), so `data.content` is the clean title by
   *  the time this tx opens. */
  const applyTag = async (typeId: string): Promise<void> => {
    await repo.tx(async tx => {
      const data = await tx.get(block.id)
      if (!data || data.deleted) return
      const snapshot = repo.snapshotTypeRegistries()
      await repo.addTypeInTx(tx, block.id, typeId, {}, snapshot)
      // `#type` turns the block ITSELF into a user-defined type: adopt
      // its content as the type's name, tag it as a page, and claim the
      // alias — so `book #type` yields a type named "book" that
      // `[[book]]` resolves to.
      if (typeId === BLOCK_TYPE_TYPE) {
        await typeifyBlockInTx(repo, tx, block.id, snapshot)
      }
    }, {scope: ChangeScope.BlockDefault, description: `tag type ${typeId}`})
  }

  const pickType = async (
    candidate: TypeTagCandidate,
    // ctx (docBefore/docAfter) is only for the failure-restore path,
    // owned by the completion `apply`; the tag itself never touches
    // content, so pickType doesn't need it.
    _ctx: TypeTagPickContext,
  ): Promise<void> => {
    try {
      if (candidate.kind === 'existing') {
        await applyTag(candidate.id)
        return
      }
      // Create flow — reuse a same-named type that published since the
      // candidate list was built, else mint the definition block.
      const existing = findCompletableTypeByName(repo.types, candidate.label)
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
      await applyTag(typeId)
    } catch (err) {
      // "Couldn't finish": the create flow can fail AFTER the
      // definition block committed (registration timeout) — the type
      // may still appear moments later, and re-picking then reuses it
      // via the registry re-check above.
      showError(candidate.kind === 'create'
        ? `Couldn't finish creating type "${candidate.label}"`
        : `Couldn't tag with "${candidate.label}"`)
      throw err
    }
  }

  // Unmounted-view fallback for a failed pick's command-span restore.
  const restoreTrigger = async (ctx: TypeTagPickContext): Promise<void> => {
    await repo.tx(async tx => {
      const data = await tx.get(block.id)
      if (!data || data.deleted) return
      const restored = planTriggerRestore(data.content, ctx)
      if (restored !== null) {
        await tx.update(block.id, {content: restored})
      }
    }, {scope: ChangeScope.BlockDefault, description: 'restore type-tag command text'})
  }

  return typeTagCompletionSource({getCandidates, pickType, restoreTrigger})
}

export const supertagsCodeMirrorExtensions: CodeMirrorExtensionContribution = (ctx) => {
  const source = buildTypeTagSource(ctx)
  return [EditorState.languageData.of(() => [{autocomplete: source}])]
}
