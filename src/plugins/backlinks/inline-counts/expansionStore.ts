import { createKeyedToggleSet } from '@/utils/toggleStore'

/** Which blocks have their inline backlinks manually expanded, this tab.
 *  Keyed by block id alone — ids are globally unique, and the set lives
 *  only for the tab's lifetime, so no workspace qualifier is needed. */
const expansion = createKeyedToggleSet('backlink-expansion')

export const toggleBacklinkExpansion = expansion.toggle

/** Reactive: is this block's inline backlinks section expanded? */
export const useBacklinkExpansion = expansion.useHas
