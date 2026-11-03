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
