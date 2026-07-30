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

/** How long to let the ordinary path work before walking ancestors. A row
 *  that exists (mounted, or a placeholder the request just mounted) needs
 *  nothing more, and that's every keystroke of a `j` walk — so the walk below
 *  must not be on that path. What's left after this delay is a target with no
 *  row in the tree at all, which is the case the walk exists for. */
const ANCESTOR_WALK_DELAY_MS = 150

/** Depth guard for the ancestor walk — outlines are deep but not unbounded,
 *  and a cycle in `parentId` must not spin forever. */
const MAX_ANCESTOR_HOPS = 64

export function FocusedRowLazyMount({block, scopeRootId}: {block: Block; scopeRootId: string}) {
  const [focusedLocation] = usePropertyValue(block, focusedBlockLocationProp)
  const focusedBlockId = focusedLocation?.blockId
  const repo = block.repo

  useEffect(() => {
    if (!focusedBlockId) return
    let cancelled = false
    const withdrawals: Array<() => void> = []
    const want = (blockId: string) => {
      const withdraw = requestLazyMount(lazyBlockCacheKey(blockId))
      if (cancelled) withdraw()
      else withdrawals.push(withdraw)
    }

    want(focusedBlockId)

    // A row deferred *under a deferred ancestor* has no placeholder to reach:
    // `BlockChildren` only renders a child's lazy wrapper once the parent is
    // mounted. Wanting the ancestors too makes the cascade resolve itself —
    // each level mounts, renders its children, and those see the standing
    // want. Reachable on a restored session whose stored focus is a nested
    // row below the fold; deliberately delayed so the ordinary case never
    // pays for it.
    const timer = setTimeout(() => {
      if (cancelled) return
      if (document.querySelector(`[data-block-id="${CSS.escape(focusedBlockId)}"]`)) return
      void (async () => {
        let current = repo.block(focusedBlockId)
        for (let hop = 0; hop < MAX_ANCESTOR_HOPS && !cancelled; hop++) {
          const parentId = (await current.load())?.parentId
          if (!parentId || parentId === scopeRootId) return
          want(parentId)
          current = repo.block(parentId)
        }
      })()
    }, ANCESTOR_WALK_DELAY_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      for (const withdraw of withdrawals) withdraw()
    }
  }, [focusedBlockId, scopeRootId, repo])

  return null
}
