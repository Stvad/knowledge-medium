import type {Block} from '@/data/block'
import {commitInlineProperty, type InlinePropertySelection} from '@/data/inlineProperty'
import {CallbackSet} from '@/utils/callbackSet'

export interface PendingOutlineProperty extends InlinePropertySelection {
  ownerId: string
  parentId: string
  ghost?: boolean
  text?: string
  committing?: boolean
}
export interface ListingState {
  pending: readonly PendingOutlineProperty[]
  revealed: readonly string[]
}
const EMPTY: ListingState = {pending: [], revealed: []}

/** View state only: drafts have no block identity and never enter the repo. */
export class OutlinePropertySession {
  private listings = new Map<string, ListingState>()
  private changes = new CallbackSet()
  private revision = 0
  snapshotRevision = () => this.revision
  private publish() {
    this.revision++
    this.changes.notify()
  }
  subscribe = (notify: () => void) => this.changes.add(notify)
  snapshot = (parentId: string): ListingState => this.listings.get(parentId) ?? EMPTY
  private setListing(parentId: string, state: ListingState) {
    if (state.pending.length || state.revealed.length) this.listings.set(parentId, state)
    else this.listings.delete(parentId)
  }
  private revealField(ownerId: string, fieldRowId: string): boolean {
    const previous = this.snapshot(ownerId)
    if (previous.revealed.includes(fieldRowId)) return false
    this.listings.set(ownerId, {...previous, revealed: [...previous.revealed, fieldRowId]})
    return true
  }
  reveal(ownerId: string, fieldRowId: string) {
    if (this.revealField(ownerId, fieldRowId)) this.publish()
  }
  add(ownerId: string, selection: InlinePropertySelection) {
    const parentId = selection.fieldRowId ?? ownerId
    const previous = this.snapshot(parentId)
    if (previous.pending.some(item => item.schema.fieldId === selection.schema.fieldId)) return
    this.listings.set(parentId, {...previous, pending: [
      ...previous.pending.filter(item => item.schema.fieldId !== selection.schema.fieldId),
      {...selection, ownerId, parentId},
    ]})
    if (selection.fieldRowId) this.revealField(ownerId, selection.fieldRowId)
    this.publish()
  }
  remove(parentId: string, fieldId: string) {
    const previous = this.snapshot(parentId)
    const pending = previous.pending.filter(item => item.schema.fieldId !== fieldId)
    if (pending.length === previous.pending.length) return
    this.setListing(parentId, {...previous, pending})
    this.publish()
  }
  setText(draft: PendingOutlineProperty, text: string) {
    const previous = this.snapshot(draft.parentId)
    const entry = previous.pending.find(item => item.schema.fieldId === draft.schema.fieldId)
    if (entry?.committing || (entry?.text ?? '') === text) return
    const pending = entry
      ? previous.pending.map(item => item === entry ? {...entry, text} : item)
      : [...previous.pending, {...draft, text}]
    this.setListing(draft.parentId, {...previous, pending})
    if (draft.fieldRowId) this.revealField(draft.ownerId, draft.fieldRowId)
    this.publish()
  }
  async submit(owner: Block, draft: PendingOutlineProperty) {
    const previous = this.snapshot(draft.parentId)
    const entry = previous.pending.find(item => item.schema.fieldId === draft.schema.fieldId)
    if (!entry?.text || entry.committing) return null
    const submitting = {...entry, committing: true}
    this.setListing(draft.parentId, {...previous, pending: previous.pending.map(item => item === entry ? submitting : item)})
    this.publish()
    try {
      const target = await commitInlineProperty(owner, submitting, entry.text)
      if (this.snapshot(draft.parentId).pending.includes(submitting)) this.remove(draft.parentId, draft.schema.fieldId)
      return target
    } catch (error) {
      const current = this.snapshot(draft.parentId)
      this.setListing(draft.parentId, {...current, pending: current.pending.map(item => item === submitting ? {...item, committing: false} : item)})
      this.publish()
      throw error
    }
  }
  disposeOwner(ownerId: string): PendingOutlineProperty[] {
    const removed: PendingOutlineProperty[] = []
    let changed = false
    for (const [parentId, state] of this.listings) {
      removed.push(...state.pending.filter(item => item.ownerId === ownerId))
      const pending = state.pending.filter(item => item.ownerId !== ownerId)
      const revealed = parentId === ownerId ? EMPTY.revealed : state.revealed
      if (pending.length !== state.pending.length || revealed.length !== state.revealed.length) {
        this.setListing(parentId, {pending, revealed})
        changed = true
      }
    }
    if (changed) this.publish()
    return removed
  }
  /** Unsaved text outlives focus, including its containing field; empty drafts may expire. */
  clearOwner(ownerId: string) {
    let changed = false
    for (const [parentId, state] of this.listings) {
      const pending = state.pending.filter(item => item.ownerId !== ownerId || item.text)
      const revealed = parentId === ownerId ? state.revealed.filter(id => this.snapshot(id).pending.some(item => item.text)) : state.revealed
      if (pending.length !== state.pending.length || revealed.length !== state.revealed.length) {
        this.setListing(parentId, {pending, revealed})
        changed = true
      }
    }
    if (changed) this.publish()
  }
}

const sessions = new WeakMap<Block, Map<unknown, OutlinePropertySession>>()
export const outlinePropertySession = (uiStateBlock: Block, scope: unknown): OutlinePropertySession => {
  let scopes = sessions.get(uiStateBlock)
  if (!scopes) sessions.set(uiStateBlock, scopes = new Map())
  let session = scopes.get(scope)
  if (!session) scopes.set(scope, session = new OutlinePropertySession())
  return session
}

