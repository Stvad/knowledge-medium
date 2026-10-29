import { useEffect, useSyncExternalStore } from 'react'
import { appMountsFacet } from '@/extensions/core.js'
import type { AppExtension } from '@/facets/facet.js'
import { disarmCut, getArmedCut, subscribeArmedCut } from '@/paste/armedCut.js'

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

/** The armed cut's page-level surface (`@/paste/armedCut.js`):
 *  - a native copy or cut anywhere in the page (selected editor text) puts
 *    new content on the clipboard, so it disarms. Block cut and copy go
 *    through the async clipboard API, which fires no such event;
 *  - the cut's blocks are dimmed until a paste moves them or a copy disarms
 *    them. The dim can outlive the cut when the user copies in another app,
 *    which the page can't see: cosmetic only, since whether a paste moves is
 *    decided by the clipboard text, and the next paste in the app clears it. */
export function ArmedCutMount() {
  useEffect(() => {
    const onClipboardWrite = () => disarmCut()
    document.addEventListener('copy', onClipboardWrite, true)
    document.addEventListener('cut', onClipboardWrite, true)
    return () => {
      document.removeEventListener('copy', onClipboardWrite, true)
      document.removeEventListener('cut', onClipboardWrite, true)
    }
  }, [])
  const cut = useSyncExternalStore(subscribeArmedCut, getArmedCut, () => null)
  const css = cut ? armedCutStyles(cut.rootIds) : ''
  return css ? <style>{css}</style> : null
}

export const armedCutAppMountExtension: AppExtension = [
  appMountsFacet.of(
    {id: 'core.armed-cut', component: ArmedCutMount},
    {source: 'core'},
  ),
]
