/** CSS custom property a fixed bar covering the bottom of the panes sets to
 *  its height (on `:root`) while it shows, so each pane's scrollport, or a
 *  stacked column that scrolls its panes, can scroll its last rows clear of
 *  it from md up. Below md the pane scrollport reserves the bottom nav's
 *  height instead. `PanelRenderer` and `LayoutRenderer` name it literally in
 *  their classes, since Tailwind reads class names from source. */
export const PANEL_BOTTOM_CLEARANCE = '--panel-bottom-clearance'
