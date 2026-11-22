import { useCallback, useMemo, useSyncExternalStore } from 'react'
import type { Block } from '@/data/block'
import type { BlockData, Handle } from '@/data/api'
import type { AncestorsResult } from '@/data/internals/kernelQueries'
import { useUIStateBlock } from '@/data/globalState'
import { focusedBlockLocationFromProperties, type FocusedBlockLocation } from '@/data/properties'
import { CallbackSet } from '@/utils/callbackSet'

/** One focus-chain subscription per panel. Listings select their direct child
 * from it; changing the focused leaf must not rerender every listing. The
 * ancestors query owns cold loads and invalidation when an ancestor moves. */
class FocusedChildren {
  private readonly listeners = new CallbackSet('FocusedChildren')
  private location: FocusedBlockLocation | undefined
  private focused: Block | undefined
  private ancestors: Handle<AncestorsResult> | undefined
  private children = new Map<string, BlockData>()
  private complete = false
  private unsubscribeFocus: (() => void) | undefined
  private followed: (() => void)[] = []

  constructor(private readonly uiStateBlock: Block) {
    this.selectFocus()
    this.refresh()
  }

  private selectFocus(): void {
    this.location = focusedBlockLocationFromProperties(this.uiStateBlock.peek()?.properties)
    this.focused = this.location ? this.uiStateBlock.repo.block(this.location.blockId) : undefined
    this.ancestors = this.location ? this.uiStateBlock.repo.query.ancestors({id: this.location.blockId}) : undefined
  }

  private refresh = (): void => {
    const children = new Map<string, BlockData>()
    const focused = this.focused?.peek()
    const chain = this.ancestors?.peek()
    const complete = !this.location || (focused !== undefined && this.ancestors?.status() === 'ready' &&
      chain?.stoppedAtParentId === null)
    if (focused) {
      for (const ancestor of [focused, ...(chain?.ancestors ?? [])]) {
        const row = this.uiStateBlock.repo.block(ancestor.id).peek()
        if (row && row.parentId !== null) children.set(row.parentId, row)
      }
    }
    if (complete === this.complete && children.size === this.children.size &&
      [...children].every(([id, row]) => this.children.get(id) === row)) return
    this.children = children
    this.complete = complete
    this.listeners.notify()
  }

  private followFocus = (): void => {
    const next = focusedBlockLocationFromProperties(this.uiStateBlock.peek()?.properties)
    if ((this.followed.length > 0 || !next) && next?.blockId === this.location?.blockId &&
      next?.renderScopeId === this.location?.renderScopeId) return
    for (const unsubscribe of this.followed) unsubscribe()
    this.followed = []
    this.selectFocus()
    if (this.focused && this.ancestors) {
      this.followed = [this.focused.subscribe(this.refresh), this.ancestors.subscribe(this.refresh)]
      for (const handle of [this.focused, this.ancestors]) {
        if (handle.status() === 'idle' || handle.status() === 'error') {
          void handle.load().catch(error => console.error('[FocusedChildren] load failed', error))
        }
      }
    }
    this.refresh()
    // A scope change can hide the same chain from one listing and reveal it
    // in another even when none of its rows changed.
    this.listeners.notify()
  }

  subscribe = (notify: () => void): (() => void) => {
    const off = this.listeners.add(notify)
    if (!this.unsubscribeFocus) {
      this.unsubscribeFocus = this.uiStateBlock.subscribe(this.followFocus)
      this.followFocus()
    }
    return () => {
      off()
      if (this.listeners.size > 0) return
      this.unsubscribeFocus?.()
      this.unsubscribeFocus = undefined
      for (const unsubscribe of this.followed) unsubscribe()
      this.followed = []
    }
  }

  private inScope(renderScopeId: unknown): boolean {
    return typeof renderScopeId !== 'string' || this.location?.renderScopeId === renderScopeId
  }

  child(parentId: string, renderScopeId: unknown): BlockData | null {
    if (!this.inScope(renderScopeId)) return null
    return this.children.get(parentId) ?? null
  }

  /** The focused chain's rows that `listed` still shows under `parentId`
   *  although the cache has them under another parent, space-separated. Any
   *  render scope: the cache's parent is right in every panel. */
  strays(parentId: string, listed: readonly string[]): string {
    let strays = ''
    for (const [rowParentId, row] of this.children) {
      if (rowParentId !== parentId && listed.includes(row.id)) strays += strays ? ` ${row.id}` : row.id
    }
    return strays
  }

  within(parentId: string, renderScopeId: unknown): boolean | undefined {
    if (!this.location || !this.inScope(renderScopeId)) return false
    if (this.location.blockId === parentId || this.children.has(parentId)) return true
    return this.complete ? false : undefined
  }
}

const stores = new WeakMap<Block, FocusedChildren>()
const focusedChildren = (uiStateBlock: Block): FocusedChildren => {
  let store = stores.get(uiStateBlock)
  if (!store) {
    store = new FocusedChildren(uiStateBlock)
    stores.set(uiStateBlock, store)
  }
  return store
}

/** The direct child containing this surface's focus, including focus on a
 * value or a nested comment beneath an otherwise hidden field row. */
export const useFocusedChild = (parent: Block, renderScopeId: unknown): BlockData | null => {
  const store = focusedChildren(useUIStateBlock())
  const snapshot = useCallback(() => store.child(parent.id, renderScopeId), [store, parent.id, renderScopeId])
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}

/** `listed` without the focused chain's rows that have moved to another
 *  parent: the cache moves them in the same commit that `useFocusedChild`
 *  places them at their new parent, while this listing's own query is still
 *  reloading. Kept, the moved row would be drawn twice, with two editors. */
export const useWithoutMovedFocusRows = (parent: Block, listed: string[]): string[] => {
  const store = focusedChildren(useUIStateBlock())
  const snapshot = useCallback(() => store.strays(parent.id, listed), [store, parent.id, listed])
  const strays = useSyncExternalStore(store.subscribe, snapshot, snapshot)
  return useMemo(() => {
    if (!strays) return listed
    const moved = new Set(strays.split(' '))
    return listed.filter(id => !moved.has(id))
  }, [listed, strays])
}

/** `undefined` while the focused chain is incomplete: retaining a temporary
 * row must not mistake an ancestor still loading for focus leaving its owner. */
export const useFocusWithin = (parent: Block, renderScopeId: unknown): boolean | undefined => {
  const store = focusedChildren(useUIStateBlock())
  const snapshot = useCallback(() => store.within(parent.id, renderScopeId), [store, parent.id, renderScopeId])
  return useSyncExternalStore(store.subscribe, snapshot, snapshot)
}

