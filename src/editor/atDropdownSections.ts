import type { CompletionSection } from '@codemirror/autocomplete'

/** Section order of the shared `@` dropdown, where two plugins' sources
 *  answer at once: contributors, and the places row that hands off to
 *  `@@`. Both sources return `filter: false`, so these ranks are what
 *  orders one source's rows against the other's; a source without a
 *  section would sort by registration order instead.
 *
 *  The places row leads on an empty query, so a bare `@` + Enter goes to
 *  places rather than mentioning the first contributor (a mention can
 *  dispatch an agent run). */
export const AT_DROPDOWN_SECTIONS = {
  placesLeading: {name: 'Places', rank: 0},
  contributors: {name: 'Contributors', rank: 1},
  placesTrailing: {name: 'Places', rank: 2},
} as const satisfies Record<string, CompletionSection>
