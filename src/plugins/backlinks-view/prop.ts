import {
  ChangeScope,
  seedProperty,
  type BlockData,
} from '@/data/api'
import { hasBlockType } from '@/data/properties.js'
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'

export const FLAT_BACKLINKS_VIEW_ID = 'flat'
export const GROUPED_BACKLINKS_VIEW_ID = 'grouped'
export const DEFAULT_BACKLINKS_VIEW_ID = FLAT_BACKLINKS_VIEW_ID

export const defaultBacklinksViewIdForBlock = (
  data: Pick<BlockData, 'properties'> | null | undefined,
): string =>
  data && hasBlockType(data, DAILY_NOTE_TYPE)
    ? GROUPED_BACKLINKS_VIEW_ID
    : FLAT_BACKLINKS_VIEW_ID

/** Optional per-block backlinks-view variant override. When unset, the
 *  coordinator derives the view from the target block: grouped for
 *  daily-note pages, flat otherwise. */
export const backlinksViewProp = seedProperty({
  seedKey: 'system:backlinks-view/property/view-id',
  revision: 1,
  name: 'backlinks:viewId',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})
