import { createToggleStore } from '@/utils/toggleStore.js'

/** Open/closed state for the left sidebar. The mounted `LeftSidebar`
 *  reads it via `useSyncExternalStore`; the open action, header button,
 *  and in-sidebar navigation flip it. External callers reach it through
 *  `runActionById(OPEN_LEFT_SIDEBAR_ACTION_ID)`. */
export const leftSidebarToggle = createToggleStore('left-sidebar')
