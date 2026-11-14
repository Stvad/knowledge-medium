import type {Block} from '@/data/block'
import type {InlinePropertySelection} from '@/data/inlineProperty'
import {CallbackSet} from '@/utils/callbackSet'

export interface PendingOutlineProperty extends InlinePropertySelection {
  ownerId: string
  parentId: string
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
    if (this.revealField(ownerId, fieldRowId)) this.changes.notify()
  }
  add(ownerId: string, selection: InlinePropertySelection) {
    const parentId = selection.fieldRowId ?? ownerId
    const previous = this.snapshot(parentId)
    this.listings.set(parentId, {...previous, pending: [
      ...previous.pending.filter(item => item.schema.fieldId !== selection.schema.fieldId),
      {...selection, ownerId, parentId},
    ]})
    if (selection.fieldRowId) this.revealField(ownerId, selection.fieldRowId)
    this.changes.notify()
  }
  remove(parentId: string, fieldId: string) {
    const previous = this.snapshot(parentId)
    const pending = previous.pending.filter(item => item.schema.fieldId !== fieldId)
    if (pending.length === previous.pending.length) return
    this.setListing(parentId, {...previous, pending})
    this.changes.notify()
  }
  clearOwner(ownerId: string) {
    let changed = false
    for (const [parentId, state] of this.listings) {
      const pending = state.pending.filter(item => item.ownerId !== ownerId)
      const revealed = parentId === ownerId ? EMPTY.revealed : state.revealed
      if (pending.length !== state.pending.length || revealed.length !== state.revealed.length) {
        this.setListing(parentId, {pending, revealed})
        changed = true
      }
    }
    if (changed) this.changes.notify()
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

