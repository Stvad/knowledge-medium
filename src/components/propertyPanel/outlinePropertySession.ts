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
  reveal(ownerId: string, fieldRowId: string) {
    const previous = this.snapshot(ownerId)
    if (previous.revealed.includes(fieldRowId)) return
    this.listings.set(ownerId, {...previous, revealed: [...previous.revealed, fieldRowId]})
    this.changes.notify()
  }
  add(ownerId: string, selection: InlinePropertySelection) {
    const parentId = selection.fieldRowId ?? ownerId
    const previous = this.snapshot(parentId)
    this.listings.set(parentId, {...previous, pending: [
      ...previous.pending.filter(item => item.schema.fieldId !== selection.schema.fieldId),
      {...selection, ownerId, parentId},
    ]})
    if (selection.fieldRowId) this.reveal(ownerId, selection.fieldRowId)
    this.changes.notify()
  }
  remove(parentId: string, fieldId: string) {
    const previous = this.snapshot(parentId)
    this.listings.set(parentId, {...previous, pending: previous.pending.filter(item => item.schema.fieldId !== fieldId)})
    this.changes.notify()
  }
  clearOwner(ownerId: string) {
    for (const [parentId, state] of this.listings) {
      const pending = state.pending.filter(item => item.ownerId !== ownerId)
      const revealed = parentId === ownerId ? [] : state.revealed
      if (pending.length !== state.pending.length || revealed !== state.revealed) {
        this.listings.set(parentId, {pending, revealed})
      }
    }
    this.changes.notify()
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

