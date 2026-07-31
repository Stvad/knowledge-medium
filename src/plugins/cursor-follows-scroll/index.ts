import type { AppExtension } from '@/facets/facet.js'
import { panelMountsFacet, type PanelMountContribution } from '@/extensions/core.js'
import { systemToggle } from '@/facets/togglable.js'
import { PanelCursorFollowsScroll } from './PanelCursorFollowsScroll.tsx'

const cursorFollowsScrollMount: PanelMountContribution = {
  id: 'cursor-follows-scroll.panel',
  component: PanelCursorFollowsScroll,
}

export const cursorFollowsScrollPlugin: AppExtension = systemToggle({
  id: 'system:cursor-follows-scroll',
  name: 'Cursor follows scroll',
  description:
    'Scrolling the focused block out of view moves the cursor to the top visible block, ' +
    'so the cursor and the viewport never disagree. Turn it off for vim-style behaviour, ' +
    'where the cursor stays put and the next motion snaps the view back to it.',
}).of([
  panelMountsFacet.of(cursorFollowsScrollMount, {source: 'cursor-follows-scroll'}),
])

export {
  isRowInViewport,
  resolveViewportAnchor,
} from './viewportAnchor.ts'
