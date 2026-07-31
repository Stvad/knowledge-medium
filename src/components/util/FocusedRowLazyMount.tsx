import { useEffect } from 'react'
import { usePropertyValue } from '@/hooks/block.js'
import { focusedBlockLocationProp } from '@/data/properties.js'
import type { Block } from '@/data/block.js'
import { lazyBlockCacheKey, requestLazyMount } from './lazyMountRegistry.js'

/** How long to let the ordinary path work before walking ancestors. A row
 *  that exists (mounted, or a placeholder the request just mounted) needs
 *  nothing more, and that's every keystroke of a `j` walk — so the walk must
 *  not sit on that path. What's left after this delay is a target with no row
 *  in the tree at all, which is the case the walk exists for. */
const ANCESTOR_WALK_DELAY_MS = 150

/**
 * Keeps the panel's focused row mounted, so a focus write that lands on a
 * lazy placeholder isn't a dead end (why that matters: `lazyMountRegistry`).
 * Focus targets come from the block model — `nextVisibleBlock` for the
 * keyboard, a search hit, a jump — which knows nothing about which rows
 * happen to be deferred.
 *
 * Three things it does, each for a reason the registry can't cover:
 *
 *   - Holds the want for as long as the row is focused rather than firing
 *     once, so a row that renders a commit or two later still mounts.
 *   - Walks the ancestor chain when the target has no row in this panel at
 *     all: `BlockChildren` renders a child's lazy wrapper only once the
 *     parent is mounted, so a target under a deferred ancestor has nothing
 *     to register. Wanting each level lets the cascade resolve itself.
 *   - Acts on the focus value the panel ARRIVES with too. That value used to
 *     be exempt, because mounting its row makes `BlockFocusShellDecorator`
 *     scroll it into view and that fought the pixel `scrollTop` the panel was
 *     restoring — the stored cursor and the stored scroll position disagreed
 *     whenever the user had scrolled away from their cursor. `PanelRenderer`
 *     now restores BY the cursor (`alignScrollportToRow`) rather than by a
 *     pixel offset, so the two want the same thing and the exemption had
 *     nothing left to protect. Dropping it also fixes what it cost: a restored
 *     panel used to stay keyboard-dead until the user clicked or scrolled,
 *     because normal mode needs a mounted focused row to activate at all.
 *
 * One instance per panel (rendered by `PanelRenderer`), subscribed to that
 * panel's focused location only — one subscription per panel, not per row.
 * Deliberately NOT contributed through `panelMountsFacet` like its
 * `PanelFocusRecovery` neighbour: every contributor there belongs to a
 * toggleable plugin, and this upholds a correctness invariant for core paths
 * (including the edit-mode arrow keys), so it must not be switchable off.
 */
export function FocusedRowLazyMount({block, scopeRootId}: {block: Block; scopeRootId: string}) {
  const [focusedLocation] = usePropertyValue(block, focusedBlockLocationProp)
  const focusedBlockId = focusedLocation?.blockId
  const renderScopeId = focusedLocation?.renderScopeId
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

    const timer = setTimeout(() => {
      if (cancelled || typeof document === 'undefined') return
      // Scope the probe to THIS panel's copy: `data-block-id` is also on
      // other panels' rows, on inline reference links, and on property rows,
      // so a document-wide hit would skip the walk for a row that genuinely
      // isn't here. The render scope is the panel's own.
      if (renderScopeId && document.querySelector(
        `[data-block-id="${CSS.escape(focusedBlockId)}"][data-render-scope-id="${CSS.escape(renderScopeId)}"]`,
      )) return
      void (async () => {
        // One recursive query for the whole chain, then a synchronous cache
        // walk — the repo's established hydrate-then-walk idiom (see
        // `getRootBlock`). Stops at the panel's scope root; a chain that
        // never reaches it isn't this panel's outline, so wanting more of it
        // would only force-mount unrelated blocks.
        await repo.load(focusedBlockId, {ancestors: true})
        if (cancelled) return
        const chain: string[] = []
        const seen = new Set<string>([focusedBlockId])
        let parentId = repo.cache.getSnapshot(focusedBlockId)?.parentId
        while (parentId && parentId !== scopeRootId && !seen.has(parentId)) {
          seen.add(parentId)
          chain.push(parentId)
          parentId = repo.cache.getSnapshot(parentId)?.parentId
        }
        if (parentId !== scopeRootId) return
        for (const ancestorId of chain) want(ancestorId)
      })().catch(() => {
        // A failed ancestor load just means no cascade; the row stays
        // deferred exactly as it would have without this component.
      })
    }, ANCESTOR_WALK_DELAY_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
      for (const withdraw of withdrawals) withdraw()
    }
  }, [focusedBlockId, renderScopeId, scopeRootId, repo])

  return null
}
