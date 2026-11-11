/* The markup by which a panel mount showing rows beside the panel's own
 * content declares them a navigation lane; spatial navigation reads it. */

/** Marks the root of such a mount; the value names the lane. Spatial
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
