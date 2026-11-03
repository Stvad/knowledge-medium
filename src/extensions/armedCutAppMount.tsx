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

/** A native copy or cut that put something on the clipboard. A handler that
 *  wrote its own data (CodeMirror) prevented the default; a plain one copies
 *  a non-empty selection. ⌘C/⌘X with nothing selected still fires the event
 *  but leaves the clipboard, and so the cut on it, alone. */
const wroteClipboard = (event: Event): boolean => {
  if (event.defaultPrevented) return true
  const target = event.target
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return (target.selectionStart ?? 0) !== (target.selectionEnd ?? 0)
  }
  return !(document.getSelection()?.isCollapsed ?? true)
}

/** The armed cut's page-level surface (`@/paste/armedCut.js`):
 *  - a native copy or cut that wrote the clipboard (selected editor text)
 *    disarms it, judged on the bubbling event once handlers have run. Block
 *    cut and copy go through the async clipboard API, which fires no event;
 *  - the cut's blocks are dimmed until a paste moves them or a copy disarms
 *    them. The dim can outlive the cut when the user copies in another app,
 *    which the page can't see: cosmetic only, since whether a paste moves is
 *    decided by the clipboard text, and the next paste in the app clears it. */
export function ArmedCutMount() {
  useEffect(() => {
    const onClipboardEvent = (event: Event) => {
      if (wroteClipboard(event)) disarmCut()
    }
    window.addEventListener('copy', onClipboardEvent)
    window.addEventListener('cut', onClipboardEvent)
    return () => {
      window.removeEventListener('copy', onClipboardEvent)
      window.removeEventListener('cut', onClipboardEvent)
    }
  }, [])
  const cut = useSyncExternalStore(subscribeArmedCut, getArmedCut, () => null)
  const css = cut && !cut.pasted ? armedCutStyles(cut.rootIds) : ''
  return css ? <style>{css}</style> : null
}

export const armedCutAppMountExtension: AppExtension = [
  appMountsFacet.of(
    {id: 'core.armed-cut', component: ArmedCutMount},
    {source: 'core'},
  ),
]
