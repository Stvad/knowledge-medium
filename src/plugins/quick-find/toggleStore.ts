import { createToggleStore } from '@/utils/toggleStore.js'

export const QUICK_FIND_ACTION_ID = 'quick_find'

/** Open/closed state for the quick-find dialog. The mounted `QuickFind`
 *  surface reads it via `useSyncExternalStore`; the action and header
 *  button flip it. External callers reach it through
 *  `runActionById(QUICK_FIND_ACTION_ID)`. */
export const quickFindToggle = createToggleStore('quick-find')
