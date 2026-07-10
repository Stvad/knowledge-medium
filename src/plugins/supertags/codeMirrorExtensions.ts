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
 *  when safe), then `pickType` → `applyTag` persists that deletion
 *  (`ctx.docAfter`) and adds the type as two `repo.undoGroup`-folded txs
 *  (one undo entry — see `applyTag`). Persisting the stripped content
 *  before the type-add is load-bearing: a types change remounts the
 *  per-block editor (types participate in `DefaultBlockRenderer`'s slot
 *  identity) and the fresh editor seeds from the cache — if the cached
 *  content still held the command span (the editor's own persistence is
 *  otherwise a 300ms-debounced `setContent`), the deleted text would
 *  resurrect under the user's cursor and could permanently fork from what
 *  they type next.
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
import { ChangeScope, ProcessorRejection } from '@/data/api'
import { getBlockTypes } from '@/data/properties'
import { createTypeBlock } from '@/data/typeExtraction'
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
   *  the time this tx opens. When `typeId` is `block-type`, the kernel
   *  `blockTypeTypeify` same-tx processor completes the type (adopt
   *  content→label, add PAGE_TYPE, claim the label alias) — it fires for
   *  every block-type tag, so `#type` needs no special work here.
   *
   *  Two grouped txs, folded into ONE undo entry via `repo.undoGroup`:
   *   1. persist the view's stripped content (`ctx.docAfter`) so the
   *      type-add remount reseeds from a clean cache;
   *   2. add the type.
   *  Grouped so a single cmd-Z reverts the whole acceptance (strip +
   *  tag). Kept as SEPARATE txs (not one) so the tag tx stays
   *  content-neutral — a content change in the same tx as the tag would
   *  make `aliasSyncProcessor` append a drift-heal alias; isolating the
   *  content write in tx 1 (where the block has no alias yet) avoids that
   *  entirely. Non-atomic is fine: if the tag tx fails, tx 1's clean
   *  content is exactly what the failure-restore path expects. */
  const applyTag = async (typeId: string, ctx: TypeTagPickContext): Promise<void> => {
    await repo.undoGroup(async grouped => {
      await grouped.tx(async tx => {
        const data = await tx.get(block.id)
        if (data && !data.deleted && data.content !== ctx.docAfter) {
          await tx.update(block.id, {content: ctx.docAfter})
        }
      }, {scope: ChangeScope.BlockDefault, description: 'strip type-tag command'})
      await grouped.tx(async tx => {
        const data = await tx.get(block.id)
        if (!data || data.deleted) return
        await repo.addTypeInTx(tx, block.id, typeId, {}, repo.snapshotTypeRegistries())
      }, {scope: ChangeScope.BlockDefault, description: `tag type ${typeId}`})
    })
  }

  const pickType = async (
    candidate: TypeTagCandidate,
    ctx: TypeTagPickContext,
  ): Promise<void> => {
    try {
      if (candidate.kind === 'existing') {
        await applyTag(candidate.id, ctx)
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
      await applyTag(typeId, ctx)
    } catch (err) {
      // Structured rejections (e.g. a name that collides with an
      // existing alias) already surface their own specific toast via
      // `repo.tx`'s userErrorListeners — a generic "couldn't finish" on
      // top would double up and bury the real reason. Only the
      // unexpected failures (e.g. the create flow failing AFTER the
      // definition block committed on a registration timeout — the type
      // may still appear moments later, re-picking reuses it) get the
      // generic toast.
      if (!(err instanceof ProcessorRejection)) {
        showError(candidate.kind === 'create'
          ? `Couldn't finish creating type "${candidate.label}"`
          : `Couldn't tag with "${candidate.label}"`)
      }
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
