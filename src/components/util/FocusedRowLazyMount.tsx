import { useEffect } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import { focusedBlockLocationProp } from '@/data/properties.js'
import type { Block } from '@/data/block.js'
import { lazyBlockCacheKey, requestLazyMount } from './lazyMountRegistry.js'

/**
 * Keeps the panel's focused row mounted, so a focus write that lands on a
 * lazy placeholder isn't a dead end (why that matters: `lazyMountRegistry`).
 * Focus targets come from the block model — `nextVisibleBlock` for the
 * keyboard, a search hit, a restored panel — which knows nothing about which
 * rows happen to be deferred.
 *
 * The want is held for as long as the row is focused rather than fired once,
 * so a row that renders a commit or two later (a freshly mounted parent's
 * children arrive only when its `childIds` handle resolves) still mounts.
 *
 * Limit worth knowing: this reaches rows whose placeholder exists, i.e. whose
 * parent is already mounted. One step of `j`/`k` never needs more (the next
 * visible block is a child of the current row or of a mounted ancestor), but
 * a multi-step jump can land inside a subtree whose parent row is itself
 * deferred, and that target won't be reachable this way.
 *
 * Keyed by block id, not by rendered location: a request mounts every copy of
 * the block, so whichever copy the focused location names is covered without
 * this component having to reason about render scopes.
 *
 * One instance per panel (rendered by `PanelRenderer`), subscribed to that
 * panel's focused location only — one subscription per panel, not per row.
 * Deliberately NOT contributed through `panelMountsFacet` like its
 * `PanelFocusRecovery` neighbour: every contributor there belongs to a
 * toggleable plugin, and this upholds a correctness invariant for core paths
 * (including the edit-mode arrow keys), so it must not be switchable off.
 */
export function FocusedRowLazyMount({block}: {block: Block}) {
  const [focusedLocation] = usePropertyValue(block, focusedBlockLocationProp)
  const focusedBlockId = focusedLocation?.blockId

  useEffect(() => {
    if (!focusedBlockId) return
    return requestLazyMount(lazyBlockCacheKey(focusedBlockId))
  }, [focusedBlockId])

  return null
}
