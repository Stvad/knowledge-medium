/** CSS custom property a fixed bar covering the bottom of the panes sets to
 *  its height (on `:root`) while it shows, so each pane's scrollport, or a
 *  stacked column that scrolls its panes, can scroll its last rows clear of
 *  it from md up. Below md the pane scrollport reserves the bottom nav's
 *  height instead. `PanelRenderer` and `LayoutRenderer` name it literally in
 *  their classes, since Tailwind reads class names from source. */
export const PANEL_BOTTOM_CLEARANCE = '--panel-bottom-clearance'

/** CSS custom property a panel mount beside the text sets on its panel to take
 *  width from the right of the pane; the panel's centred frames centre in what
 *  is left, narrowing once that is under `PANEL_TEXT_MAX_WIDTH_PX`.
 *  `PanelRenderer` names it literally in its class, as above, and caps it so
 *  the text keeps `PANEL_TEXT_MIN_WIDTH_PX`, which a value gone stale in a
 *  shrunk pane would otherwise take. Padding, not `position: relative` on the
 *  frame, because a panel's content can fill the panel with `absolute
 *  inset-0`. */
export const PANEL_RIGHT_CLEARANCE = '--panel-right-clearance'

/** The width of a panel's centred frames (`max-w-3xl`), and the least a
 *  `PANEL_RIGHT_CLEARANCE` may narrow them to. `PanelRenderer` names both
 *  literally in its classes. */
export const PANEL_TEXT_MAX_WIDTH_PX = 768
export const PANEL_TEXT_MIN_WIDTH_PX = 480
