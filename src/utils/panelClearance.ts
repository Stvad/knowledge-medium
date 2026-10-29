/** CSS custom property a fixed bar covering the bottom of the panes sets to
 *  its height (on `:root`) while it shows, so each pane's scrollport can
 *  scroll its last rows clear of it from md up. Below md the scrollport
 *  reserves the bottom nav's height instead. `PanelRenderer`'s scrollport
 *  class names it literally, since Tailwind reads class names from source. */
export const PANEL_BOTTOM_CLEARANCE = '--panel-bottom-clearance'
