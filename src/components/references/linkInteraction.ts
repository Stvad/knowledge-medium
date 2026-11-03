import type { MouseEvent } from 'react'

const RICH_CONTENT_SELECTOR =
  'img, video, audio, iframe, canvas, button, [role="button"], [data-block-interaction="ignore"]'

/** Nested links own navigation; unlinked media and controls own their gestures.
 * The current anchor is excluded so its plain text remains navigable. */
export const classifyLinkInteraction = (event: MouseEvent): 'anchor' | 'rich' | null => {
  const {target, currentTarget} = event
  if (!(target instanceof Element)) return null
  let rich = false
  for (let el: Element | null = target; el && el !== currentTarget; el = el.parentElement) {
    if (el.matches('a[href]')) return 'anchor'
    if (!rich && el.matches(RICH_CONTENT_SELECTOR)) rich = true
  }
  return rich ? 'rich' : null
}
