import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {selectInlineProperty} from '@/data/inlineProperty'
import {focusBlock} from '@/data/properties'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {outlinePropertySession} from './outlinePropertySession'

/** Shared by the typed scaffold and add-field command; no editor view needed. */
export const beginInlineProperty = async ({owner, schema, ui, scope, source, isActive = () => true}: {
  owner: Block; schema: AnyPropertySchema; ui: Block; scope?: string; source?: Block; isActive?: () => boolean
}): Promise<void> => {
  let interrupted = false
  const interrupt = () => { interrupted = true }
  const session = outlinePropertySession(ui, scope)
  const active = () => !interrupted && isActive() && session.hasOwner(owner.id)
  document.addEventListener('pointerdown', interrupt, true)
  try {
    const selected = await selectInlineProperty(owner, schema, source)
    if (active() && selected.fieldRowId) {
      await Promise.all([owner.repo.block(selected.fieldRowId).load(), selected.valueId ? owner.repo.block(selected.valueId).load() : Promise.resolve()])
    }
    if (active()) await focusBlock(ui, owner.id, {edit: false, renderScopeId: scope})
    if (!session.hasOwner(owner.id)) return
    if (selected.valueId && selected.fieldRowId) {
      if (!active()) return
      session.reveal(owner.id, selected.fieldRowId)
      await enterEditModeForBlock(owner.repo.block(selected.valueId), ui, scope, {start: 0})
    } else {
      // Selection already removed the scaffold: interruption cancels focus,
      // not the pending row. An unfocused draft lives until blur or unmount.
      session.add(owner.id, selected, active())
    }
  } finally { document.removeEventListener('pointerdown', interrupt, true) }
}
