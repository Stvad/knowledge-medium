/** CSS custom property a fixed bar covering the bottom of the panes sets to
 *  its height (on `:root`) while it shows, so each pane's scrollport, or a
 *  stacked column that scrolls its panes, can scroll its last rows clear of
 *  it from md up. Below md the pane scrollport reserves the bottom nav's
 *  height instead. `PanelRenderer` and `LayoutRenderer` name it literally in
 *  their classes, since Tailwind reads class names from source. */
export const PANEL_BOTTOM_CLEARANCE = '--panel-bottom-clearance'

/** CSS custom property a panel mount beside the text sets on its panel to take
 *  width from the right of the pane; the panel's centred frames centre in what
 *  is left. `PanelRenderer` names it literally in its class, as above, and caps
 *  it at what the frame leaves free: a value gone stale in a shrunk pane must
 *  not narrow the text, which would re-wrap it and move the scroll position.
 *  Padding, not `position: relative` on the frame, because a panel's content
 *  can fill the panel with `absolute inset-0`. */
export const PANEL_RIGHT_CLEARANCE = '--panel-right-clearance'
