import { defineFacet } from '@/facets/facet.js'
import { createToggleStore } from '@/utils/toggleStore.js'

export const alwaysShowLinkHintsFacet = defineFacet<true>({
  id: 'vim-link-hints.always-show',
})

export const linkHintsToggle = createToggleStore('vim-link-hints')
