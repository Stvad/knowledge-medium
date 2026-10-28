import { useSyncExternalStore } from 'react'
import { appMountsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { getArmedCut, subscribeArmedCut } from '@/paste/armedCut.js'

/** Block ids are generated (uuids, deterministic hashes); anything else is
 *  left undimmed rather than spliced into a selector. */
const SAFE_ID = /^[\w-]+$/

/** One rule per cut root. The shell wraps its children, so the subtree dims
 *  with it; rows that mount later (another panel, after navigating) match the
 *  same rule, so nothing per row has to track the cut. */
export const armedCutStyles = (rootIds: readonly string[]): string => {
  const selectors = rootIds
    .filter(id => SAFE_ID.test(id))
    .map(id => `[data-block-shell][data-block-id="${id}"]`)
  return selectors.length ? `${selectors.join(',\n')} { opacity: 0.45; }` : ''
}

/** Dims the blocks of the armed cut (`@/paste/armedCut.js`) until a paste
 *  moves them or another copy disarms them. Can outlive the cut when the
 *  user copies something in another app (the app can't see that) — cosmetic
 *  only: whether a paste moves is decided by the clipboard text, and the next
 *  paste in the app clears it. */
export function ArmedCutDim() {
  const cut = useSyncExternalStore(subscribeArmedCut, getArmedCut, () => null)
  const css = cut ? armedCutStyles(cut.rootIds) : ''
  return css ? <style>{css}</style> : null
}

export const armedCutAppMountExtension: AppExtension = [
  appMountsFacet.of(
    {id: 'core.armed-cut-dim', component: ArmedCutDim},
    {source: 'core'},
  ),
]
