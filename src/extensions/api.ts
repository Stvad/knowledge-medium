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
  appEffectsFacet,
  appMountsFacet,
  blockRenderersFacet,
  createRendererRegistry,
  headerItemsFacet,
  type AppEffect,
  type AppEffectCleanup,
  type AppEffectContext,
  type AppMountContribution,
  type HeaderItemContribution,
  type HeaderItemRegion,
  type RendererContribution,
} from '@/extensions/core.ts'

// DefaultBlockRenderer (the default block chrome — bullet, children,
// properties, edit affordances) is intentionally NOT re-exported here:
// it pulls in radix-ui's Dialog/ContextMenu, which transitively
// imports react-dom. Extension blocks resolve react-dom through the
// page-global importmap, but importing this API surface in vitest
// should not force that heavier renderer tree to load.
//
// Extension authors should import it directly:
//   import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'

// --- Block-interaction facets (click handlers, content renderers, content-surface props, shortcut activations) ---
export {
  blockChildrenFooterFacet,
  blockClickHandlersFacet,
  blockContentDecoratorsFacet,
  blockContentRendererFacet,
  blockContentSurfacePropsFacet,
  blockHeaderFacet,
  blockLayoutFacet,
  shortcutSurfaceActivationsFacet,
  enterBlockEditMode,
  focusBlock,
  getBlockContentRendererSlot,
  handleBlockSelectionClick,
  isSelectionClick,
  type BlockChildrenFooterContribution,
  type BlockClickContribution,
  type BlockHeaderContribution,
  type BlockContentDecorator,
  type BlockContentDecoratorContribution,
  type BlockContentRendererContribution,
  type BlockContentRendererSlot,
  type BlockContentSurfaceContribution,
  type BlockContentSurfaceProps,
  type BlockInteractionContext,
  type BlockResolveContext,
  type BlockLayout,
  type BlockLayoutContribution,
  type BlockLayoutSlots,
  type BlockShellProps,
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
export { Block } from '../data/block'
export { Repo } from '../data/repo'
export { getPanelsBlock } from '@/data/globalState.ts'
// PropertySchema authoring — extensions define their own typed
// properties via `defineProperty` from the data-layer api.
export { defineBlockType, defineProperty, definePropertyUi, codecs, ChangeScope } from '@/data/api'
export type {
  BlockData,
  Codec,
  PropertyEditorProps,
  PropertySchema,
  PropertyUiContribution,
  TypeContribution,
} from '@/data/api'
export { propertySchemasFacet, propertyUiFacet, typesFacet } from '@/data/facets.ts'
export {
  // System UI-state props extensions might want to read/write
  isCollapsedProp,
  showPropertiesProp,
  topLevelBlockIdProp,
  focusedBlockIdProp,
  // Extension-lifecycle prop
  extensionDisabledProp,
} from '@/data/properties.ts'
export type {
  BlockRenderer,
  BlockRendererProps,
  BlockContextType,
} from '@/types.ts'
