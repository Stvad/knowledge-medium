/** CSS custom property a fixed bar covering the bottom of the panes sets to
 *  its height (on `:root`) while it shows, so each pane's scrollport, or a
 *  stacked column that scrolls its panes, can scroll its last rows clear of
 *  it from md up. Below md the pane scrollport reserves the bottom nav's
 *  height instead. `PanelRenderer` and `LayoutRenderer` name it literally in
 *  their classes, since Tailwind reads class names from source. */
export const PANEL_BOTTOM_CLEARANCE = '--panel-bottom-clearance'

/** CSS custom property a panel mount beside the text sets on its panel to take
 *  width from the right of the pane; the panel's centred frames centre in what
 *  is left, narrowing once that is under their `max-w-3xl`. `PanelRenderer`
 *  names it literally in its class, as above, and caps it so the text keeps
 *  `PANEL_TEXT_MIN_WIDTH_PX`, which a value gone stale in a shrunk pane would
 *  otherwise take. Padding, not `position: relative` on the frame, because a
 *  panel's content can fill the panel with `absolute inset-0`. */
export const PANEL_RIGHT_CLEARANCE = '--panel-right-clearance'

/** The least a `PANEL_RIGHT_CLEARANCE` may narrow a panel's centred frames
 *  to. `PanelRenderer` names it literally in its class. */
export const PANEL_TEXT_MIN_WIDTH_PX = 480

/** CSS custom property a panel mount beside the text sets on its panel to say
 *  where the panel's content now ends, as its distance from the pane's right
 *  edge. The panel's action buttons end there; unset, they end at the text
 *  frame's right edge. `.panel-actions` (`index.css`) names it literally. */
export const PANEL_CONTENT_RIGHT_INSET = '--panel-content-right-inset'

/** Marks the root of a panel mount that shows rows beside the panel's own
 *  content as a navigation lane of its own; the value names the lane. Spatial
 *  navigation moves left and right between a panel's lanes, by position, and
 *  keeps up and down within one. The panel's own content, outside every marked
 *  root, is a lane too. */
export const PANEL_LANE_ATTRIBUTE = 'data-panel-lane'

/** Mark an element in a lane as standing beside one row of the panel's own
 *  content, by that row's block and render scope: a move across lanes goes
 *  between the two, wherever the element was pushed, while both are on
 *  screen. */
export const PANEL_LANE_ANCHOR_BLOCK_ATTRIBUTE = 'data-lane-anchor-block-id'
export const PANEL_LANE_ANCHOR_SCOPE_ATTRIBUTE = 'data-lane-anchor-render-scope-id'
