import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {selectInlineProperty} from '@/data/inlineProperty'
import {focusBlock, isCollapsedProp} from '@/data/properties'
import {enterEditModeForBlock} from '@/extensions/blockInteraction'
import {outlinePropertySession} from './outlinePropertySession'

/** Shared by the typed scaffold and add-field command; no editor view needed. */
export const beginInlineProperty = async ({owner, schema, ui, scope, source, isActive = () => true}: {
  owner: Block; schema: AnyPropertySchema; ui: Block; scope?: string; source?: Block; isActive?: () => boolean
}): Promise<void> => {
  let interrupted = false
  const interrupt = () => { interrupted = true }
  const active = () => !interrupted && isActive()
  document.addEventListener('pointerdown', interrupt, true)
  try {
  const selected = await selectInlineProperty(owner, schema, source)
  if (!active()) return
  if (selected.fieldRowId) {
    await Promise.all([owner.repo.block(selected.fieldRowId).load(), selected.valueId ? owner.repo.block(selected.valueId).load() : Promise.resolve()])
    if (!active()) return
    if (owner.repo.block(selected.fieldRowId).peekProperty(isCollapsedProp)) {
      await owner.repo.block(selected.fieldRowId).set(isCollapsedProp, false)
    }
  }
  if (!active()) return
  if (owner.peekProperty(isCollapsedProp)) await owner.set(isCollapsedProp, false)
  if (!active()) return
  await focusBlock(ui, owner.id, {edit: false, renderScopeId: scope})
  if (!active()) return
  const session = outlinePropertySession(ui, scope)
  if (selected.valueId && selected.fieldRowId) {
    session.reveal(owner.id, selected.fieldRowId)
    await enterEditModeForBlock(owner.repo.block(selected.valueId), ui, scope, {start: 0})
  } else session.add(owner.id, selected)
  } finally { document.removeEventListener('pointerdown', interrupt, true) }
}
