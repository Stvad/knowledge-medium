import {ChangeScope, seedProperty} from '@/data/api'

/** Whether a panel shows the comments margin. On the panel's UI-state row, so
 *  it is per panel and survives a reload. Absent ≡ off. */
export const annotationMarginOpenProp = seedProperty({
  seedKey: 'system:annotations/property/margin-open',
  revision: 1,
  name: 'annotation:marginOpen',
  preset: 'boolean',
  changeScope: ChangeScope.UiState,
})

/** The margin's width as the user set it, as a share of the pane's width (0
 *  to 1), so it keeps its proportion when the pane narrows or widens. On the
 *  panel's UI-state row, like `annotationMarginOpenProp`. Absent ≡ automatic. */
export const annotationMarginShareProp = seedProperty({
  seedKey: 'system:annotations/property/margin-share',
  revision: 1,
  name: 'annotation:marginShare',
  preset: 'optional-number',
  changeScope: ChangeScope.UiState,
})
