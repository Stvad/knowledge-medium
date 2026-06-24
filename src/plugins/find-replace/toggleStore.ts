import { createToggleStore } from '@/utils/toggleStore.js'

/** Open/closed state for the find-replace dialog. The mounted
 *  `FindReplaceDialog` reads it via `useSyncExternalStore`; the action
 *  and header button flip it. External callers reach it through
 *  `runActionById(FIND_REPLACE_ACTION_ID)`. */
export const findReplaceToggle = createToggleStore('find-replace')
