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
} from '@/extensions/facet.js'

// --- Runtime toggle types (full surface lives in @/extensions/togglable.ts) ---
export type { Togglable } from '@/extensions/togglable.js'
export {
  defineVariantFacet,
  defineVariant,
  type Variant,
  type VariantContribution,
  type VariantResolver,
  type VariantSelection,
} from '@/extensions/variantFacet.js'

// --- Blessed core facets ---
export {
  actionTransformsFacet,
  actionsFacet,
  actionContextsFacet,
  appEffectsFacet,
  appMountsFacet,
  blockRenderersFacet,
  createRendererRegistry,
  headerItemsFacet,
  panelMountsFacet,
  type AppEffect,
  type AppEffectCleanup,
  type AppEffectContext,
  type AppMountContribution,
  type HeaderItemContribution,
  type HeaderItemRegion,
  type PanelMountContribution,
  type RendererContribution,
} from '@/extensions/core.js'

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
} from '@/extensions/blockInteraction.js'

// --- Markdown rendering pipeline ---
export { markdownExtensionsFacet } from '@/markdown/extensions.js'

// --- Action / shortcut helpers ---
export {
  ActionContextTypes,
  type ActionConfig,
  type ActionContextConfig,
  type ActionContextType,
  type Action,
  type ActionTransform,
  type ShortcutBinding,
  type KeyCombination,
} from '@/shortcuts/types.js'
export {
  actionRuntimeKey,
  getActiveActionById,
  getEffectiveActions,
} from '@/shortcuts/effectiveActions.js'
export {
  bindBlockActionContext,
  createSharedBlockActions,
  extendSelectionDown,
  extendSelectionUp,
} from '@/shortcuts/blockActions.js'

// --- Block / data primitives ---
export { Block } from '../data/block'
export { Repo } from '../data/repo'
export {
  getLayoutSessionBlock,
  getPluginPrefsBlock,
  getPluginUIStateBlock,
  getUserBlock,
  getUserPrefsBlock,
} from '@/data/stateBlocks.js'
// PropertySchema authoring — extensions define their own typed
// properties via `defineProperty` from the data-layer api.
export { defineBlockType, defineProperty, definePropertyEditorOverride, codecs, ChangeScope } from '@/data/api'
export type {
  BlockData,
  Codec,
  PropertyEditorOverride,
  PropertyEditorProps,
  PropertySchema,
  TypeContribution,
} from '@/data/api'
export { propertyEditorOverridesFacet, propertySchemasFacet, typesFacet } from '@/data/facets.js'
export {
  // System UI-state props extensions might want to read/write
  isCollapsedProp,
  showPropertiesProp,
  topLevelBlockIdProp,
  focusedBlockLocationProp,
  // Atomic focus + edit transition (single primitive — `setFocusedBlockId`
  // and `setIsEditing` were removed in favor of this).
  focusBlock,
} from '@/data/properties.js'
export type { FocusedBlockLocation } from '@/data/properties.js'
export type {
  BlockRenderer,
  BlockRendererProps,
  BlockContextType,
} from '@/types.js'

export { pluginBlockId } from '@/extensions/pluginIds.js'

// React hook for accessing the live Repo from inside an
// `appMountsFacet` component. Action handlers receive `repo` through
// `uiStateBlock.repo`; components rendered inside the app tree should
// use this hook instead so they participate in the same Repo
// instance + context the rest of the app uses.
export { useRepo } from '@/context/repo.js'

// Imperative dialog primitive. Renders `Component` and returns a
// promise that resolves with the user's choice (or `null` on
// cancel). The dialog component receives `resolve(value)` /
// `cancel()` as props. Use this from action handlers when an
// `appMountsFacet`-mounted persistent dialog is overkill.
export { openDialog } from '@/utils/dialogs.js'
export type { DialogComponent, DialogContextProps } from '@/utils/dialogs.js'

// User-feedback primitives. Prefer these over `window.alert` /
// `window.confirm` — they match the app's theme, queue cleanly, and
// `showProgress` is genuinely the right shape for long-running syncs
// (returns a `{update, done, fail}` handle for incremental updates +
// terminal resolution).
export {
  showError,
  showInfo,
  showSuccess,
  showProgress,
  showCustom,
  dismissToast,
} from '@/utils/toast.js'
export type { ProgressToast, ToastAction, ToastOptions } from '@/utils/toast.js'

// Fractional-index order keys for inserting blocks at deterministic
// positions among siblings. `keyAtEnd(lastChild.orderKey)` for "append
// to children"; `keysBetween(prev, next, count)` for "insert N items
// between these two existing siblings".
export {
  keyAtEnd,
  keyAtStart,
  keyBetween,
  keysBetween,
} from '@/data/orderKey.js'
