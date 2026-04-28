// Curated public surface for extension blocks. An extension can do
//
//   import * as km from '@/extensions/api.js'
//
// to discover everything it needs in one shot, or pull individual
// symbols by name. The blob-URL extension modules resolve `@/...`
// through the page-global importmap, so what they import is the same
// module instance the running app uses.
//
// Authors are not constrained to this surface — direct imports from
// any `@/...` path work too. This module is the convention, not a
// fence; it exists to make discovery cheap (`Object.keys(km)`) and to
// give the agent bridge an answer to "what's in the box?".

// --- Facet primitives ---
export {
  defineFacet,
  isFunction,
  combineLastContributionResult,
  resolveLastContributionResult,
  type AppExtension,
  type Facet,
  type FacetContribution,
  type FacetContributionOptions,
  type FacetResolveContext,
  type FacetRuntime,
  type OptionalContributionResult,
} from '@/extensions/facet.ts'

// --- Blessed core facets ---
export {
  actionsFacet,
  actionContextsFacet,
  blockRenderersFacet,
  createRendererRegistry,
  type RendererContribution,
} from '@/extensions/core.ts'

// --- Block-interaction facets (click handlers, content renderers, gestures, shortcut activations) ---
export {
  blockClickHandlersFacet,
  blockContentRendererFacet,
  blockContentGestureHandlersFacet,
  shortcutSurfaceActivationsFacet,
  enterBlockEditMode,
  focusBlock,
  handleBlockSelectionClick,
  isSelectionClick,
  type BlockClickContribution,
  type BlockContentGestureContribution,
  type BlockContentRendererContribution,
  type BlockInteractionContext,
  type ShortcutActivationContribution,
  type ShortcutSurfaceContext,
} from '@/extensions/blockInteraction.ts'

// --- Markdown rendering pipeline ---
export { markdownExtensionsFacet } from '@/markdown/extensions.ts'

// --- Action / shortcut helpers ---
export {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type Action,
  type ShortcutBinding,
  type KeyCombination,
} from '@/shortcuts/types.ts'
export {
  bindBlockActionContext,
  createSharedBlockActions,
  extendSelectionDown,
  extendSelectionUp,
} from '@/shortcuts/blockActions.ts'

// --- Block / data primitives ---
export { Block } from '@/data/block.ts'
export { Repo } from '@/data/repo.ts'
export {
  boolProp,
  booleanProperty,
  numberProperty,
  stringProperty,
  listProperty,
  objectProperty,
  fromList,
  uiChangeScope,
  // System UI-state props extensions might want to read/write
  isCollapsedProp,
  showPropertiesProp,
  topLevelBlockIdProp,
  focusedBlockIdProp,
  // Extension-lifecycle prop
  extensionDisabledProp,
} from '@/data/properties.ts'
export type {
  BlockData,
  BlockProperty,
  BlockProperties,
  BlockRenderer,
  BlockRendererProps,
  BlockContextType,
} from '@/types.ts'
