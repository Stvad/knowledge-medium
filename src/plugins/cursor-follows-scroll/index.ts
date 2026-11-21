import type { AppExtension } from '@/facets/facet.js'
import { panelMountsFacet, type PanelMountContribution } from '@/extensions/core.js'
import { systemToggle } from '@/facets/togglable.js'
import { actionDispatchVerb } from '@/shortcuts/actionDispatch.js'
import { PanelCursorFollowsScroll } from './PanelCursorFollowsScroll.tsx'
import { consumeFollowOnDispatch } from './followOrigin.ts'

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
    'where the cursor stays put and the next motion snaps the view back to it. ' +
    'Requires Spatial navigation, which supplies the row tagging this reads.',
}).of([
  panelMountsFacet.of(cursorFollowsScrollMount, {source: 'cursor-follows-scroll'}),
  // Above spatial navigation's shift-click decorator (default precedence),
  // which reads the origin this one supplies.
  actionDispatchVerb.decorator(consumeFollowOnDispatch, {source: 'cursor-follows-scroll', precedence: 1}),
])

export {
  isRowInViewport,
  resolveViewportAnchor,
} from './viewportAnchor.ts'
