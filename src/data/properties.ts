/**
 * Kernel + UI-state property handles. Each export is a code-owned seed
 * declaration whose codec is built through its ValuePreset core; the same
 * object remains the typed, workspace-agnostic handle passed to block.get/set.
 * Per-definition editor overrides for the rare property that needs one live
 * separately under `propertyEditorOverridesFacet` during the B3 cutover.
 *
 * Migration note (1.6): legacy creator helpers (`stringProperty`,
 * `boolProp`, `objectProperty`, etc.) returned a record-shape
 * `{name, type, value}` that doubled as schema AND value. The new
 * shape is flat — `block.set(schema, value)` / `block.get(schema)`
 * encode/decode through the codec; storage holds the encoded value
 * directly. Helpers like `aliasProp(['x','y'])` (which embedded a
 * default value into the descriptor) are gone — the handle's
 * `defaultValue` is the single source of truth, callers pass values
 * via `block.set(schema, value)`.
 */
import type { Block } from './block'
import type { BlockData, ChangedRow } from '@/data/api'
import {ChangeScope, type PropertySchema} from '@/data/api'
import {
  seedProperty,
  type AnyPropertySeedDeclaration,
  type PropertySeedDeclaration,
} from './propertySeeds'
import { outlineRenderScopeId } from '@/utils/renderScope'

// ──── UI-state schemas (changeScope: UiState) ────

export const showPropertiesProp = seedProperty({
  seedKey: 'system:kernel-data/property/show-properties',
  revision: 1,
  name: 'system:showProperties',
  preset: 'boolean',
  changeScope: ChangeScope.UiState,
  hidden: true,
})

export const isEditingProp = seedProperty({
  seedKey: 'system:kernel-data/property/is-editing',
  revision: 1,
  name: 'isEditing',
  preset: 'boolean',
  changeScope: ChangeScope.UiState,
  hidden: true,
})

export const topLevelBlockIdProp = seedProperty({
  seedKey: 'system:kernel-data/property/top-level-block-id',
  revision: 1,
  name: 'topLevelBlockId',
  preset: 'optional-string',
  changeScope: ChangeScope.UiState,
  hidden: true,
})

export interface FocusedBlockLocation {
  blockId: string
  renderScopeId: string
}

// Focus is persisted as a rendered location. Retired legacy `focusedBlockId`
// keys are ignored so stale state cannot compete with this scoped value.
export const focusedBlockLocationProp = seedProperty<FocusedBlockLocation | undefined>({
  seedKey: 'system:kernel-data/property/focused-block-location',
  revision: 1,
  name: 'focusedBlockLocation',
  preset: 'optional-json',
  changeScope: ChangeScope.UiState,
  hidden: true,
})

export const activePanelIdProp = seedProperty({
  seedKey: 'system:kernel-data/property/active-panel-id',
  revision: 1,
  name: 'activePanelId',
  preset: 'optional-string',
  changeScope: ChangeScope.UiState,
})

export const scrollTopProp = seedProperty({
  seedKey: 'system:kernel-data/property/scroll-top',
  revision: 1,
  name: 'scrollTop',
  preset: 'optional-number',
  changeScope: ChangeScope.UiState,
})

/** Editor-selection state for the active block. Object-typed; the
 *  `unsafeIdentity` codec is appropriate because the shape is engine-
 *  controlled and not exposed for plugin extension. The optional
 *  `line` / `x` / `y` fields are placement hints used by CodeMirror's
 *  cursor-restoration helpers — start/end are the linear offsets,
 *  x/y are pixel coordinates for visual restoration after a wrap. */
export interface EditorSelectionState {
  blockId: string
  start?: number
  end?: number
  line?: 'first' | 'last'
  x?: number
  y?: number
}

export const editorSelection = seedProperty<EditorSelectionState | undefined>({
  seedKey: 'system:kernel-data/property/editor-selection',
  revision: 1,
  name: 'editorSelection',
  preset: 'optional-json',
  changeScope: ChangeScope.UiState,
  hidden: true,
})

export const editorFocusRequestProp = seedProperty({
  seedKey: 'system:kernel-data/property/editor-focus-request',
  revision: 1,
  name: 'editorFocusRequest',
  preset: 'number',
  changeScope: ChangeScope.UiState,
  hidden: true,
})

export interface BlockSelectionState {
  selectedBlockIds: string[]
  anchorBlockId: string | null
}

export const selectionStateProp = seedProperty<BlockSelectionState>({
  seedKey: 'system:kernel-data/property/block-selection-state',
  revision: 1,
  name: 'blockSelectionState',
  preset: 'json',
  defaultValue: {selectedBlockIds: [], anchorBlockId: null},
  changeScope: ChangeScope.UiState,
  hidden: true,
})

// ──── Block-content schemas (changeScope: BlockDefault) ────

export const isCollapsedProp = seedProperty({
  seedKey: 'system:kernel-data/property/system:collapsed',
  revision: 1,
  name: 'system:collapsed',
  preset: 'boolean',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export const typesProp = seedProperty({
  seedKey: 'system:kernel-data/property/types',
  revision: 1,
  name: 'types',
  preset: 'string-list',
  changeScope: ChangeScope.BlockDefault,
})

export const rendererProp = seedProperty({
  seedKey: 'system:kernel-data/property/renderer',
  revision: 1,
  name: 'renderer',
  preset: 'optional-string',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export const rendererNameProp = seedProperty({
  seedKey: 'system:kernel-data/property/renderer-name',
  revision: 1,
  name: 'rendererName',
  preset: 'optional-string',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export const createdAtProp = seedProperty({
  seedKey: 'system:kernel-data/property/created-at',
  revision: 1,
  name: 'createdAt',
  preset: 'optional-number',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

export const sourceBlockIdProp = seedProperty({
  seedKey: 'system:kernel-data/property/source-block-id',
  revision: 1,
  name: 'sourceBlockId',
  preset: 'optional-string',
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

// ──── extension block fields ────

/** Human-readable extension name. Kept on the block instead of inside
 *  executable extension code so disabled extensions can still be
 *  described in settings without compiling them. */
export const extensionNameProp = seedProperty({
  seedKey: 'system:kernel-data/property/extension-name',
  revision: 1,
  name: 'extension:name',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

/** Optional extension description displayed in the settings surface. */
export const extensionDescriptionProp = seedProperty({
  seedKey: 'system:kernel-data/property/extension-description',
  revision: 1,
  name: 'extension:description',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

// ──── property-schema kernel type fields (user-defined-properties §4) ────

/** User-supplied property name on a `'property-schema'` block. */
export const propertyNameProp = seedProperty({
  seedKey: 'system:kernel-data/property/property-schema-name',
  revision: 1,
  name: 'property-schema:name',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

/** Preset id on a `'property-schema'` block — matches a registered
 *  `ValuePreset.id` (and the codec's `type` for codecs built by that
 *  preset). */
export const presetIdProp = seedProperty({
  seedKey: 'system:kernel-data/property/property-schema-preset',
  revision: 1,
  name: 'property-schema:preset',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

/** Preset-specific config JSON. Stored as opaque JSON via the
 *  `unsafeIdentity` codec; validation happens in the preset's
 *  `configCodec.decode` at registration time. */
export const presetConfigProp = seedProperty<Record<string, unknown>>({
  seedKey: 'system:kernel-data/property/property-schema-config',
  revision: 1,
  name: 'property-schema:config',
  preset: 'json',
  defaultValue: {},
  changeScope: ChangeScope.BlockDefault,
  hidden: true,
})

/** Durable write semantics for a definition. Existing user schemas omit this
 * field and retain BlockDefault behavior. */
export const propertyChangeScopeProp = seedProperty({
  seedKey: 'system:kernel-data/property/property-schema-change-scope',
  revision: 1,
  name: 'property-schema:change-scope',
  preset: 'strict-enum',
  config: {options: [
    {value: ChangeScope.BlockDefault, label: 'Block default'},
    {value: ChangeScope.UiState, label: 'UI state'},
    {value: ChangeScope.UserPrefs, label: 'User preferences'},
    {value: ChangeScope.Automation, label: 'Automation'},
    {value: ChangeScope.References, label: 'References'},
  ]},
  defaultValue: ChangeScope.BlockDefault,
  changeScope: ChangeScope.BlockDefault,
})

/** Optional per-definition default, stored through the definition's own
 * built codec. Absence means the preset default; null can be a real encoded
 * absence value and is therefore distinct from an omitted key. */
export const propertyDefaultProp = seedProperty({
  seedKey: 'system:kernel-data/property/property-schema-default',
  revision: 1,
  name: 'property-schema:default',
  // Raw encoded value, deliberately NOT optionalIdentity: encoded null is a
  // meaningful explicit default for optional codecs and must remain distinct
  // from the property key being absent.
  preset: 'raw-json',
  changeScope: ChangeScope.BlockDefault,
})

/** Hide the property from ordinary property-panel presentation. */
export const propertyHiddenProp = seedProperty({
  seedKey: 'system:kernel-data/property/property-schema-hidden',
  revision: 1,
  name: 'property-schema:hidden',
  preset: 'boolean',
  changeScope: ChangeScope.BlockDefault,
})

/** Stable code provenance shared by property and future type seeds. */
export const seedKeyProp = seedProperty({
  seedKey: 'system:kernel-data/property/seed-key',
  revision: 1,
  name: 'seed:key',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

/** Monotonic code-owned seed payload revision. Background materialization
 * reads this for diagnostics only; upgrades remain an operator action. */
export const seedRevisionProp = seedProperty({
  seedKey: 'system:kernel-data/property/seed-revision',
  revision: 1,
  name: 'seed:revision',
  preset: 'number',
  changeScope: ChangeScope.BlockDefault,
})

// ──── block-type kernel fields (user-defined-types Phase 1) ────

/** Human-readable label on a `'block-type'` block. Shown in the type
 *  picker and as the section header in the property panel. */
export const blockTypeLabelProp = seedProperty({
  seedKey: 'system:kernel-data/property/block-type-label',
  revision: 1,
  name: 'block-type:label',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

/** Optional free-form description on a `'block-type'` block. */
export const blockTypeDescriptionProp = seedProperty({
  seedKey: 'system:kernel-data/property/block-type-description',
  revision: 1,
  name: 'block-type:description',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

/** RefList over `'property-schema'` blocks. UserTypesService resolves
 *  each ref to the merged property-schema map (via
 *  `UserSchemasService.getSchemaForBlockId`) to build the lifted
 *  property list on the resulting TypeContribution. */
export const blockTypePropertiesProp = seedProperty({
  seedKey: 'system:kernel-data/property/block-type-properties',
  revision: 1,
  name: 'block-type:properties',
  preset: 'refList',
  config: {targetTypes: ['property-schema']},
  changeScope: ChangeScope.BlockDefault,
})

/** Don't render this type's chip on blocks (the supertags `#type`
 *  row). Display-only — the type stays taggable and visible in
 *  pickers/panel. Lifted onto `TypeContribution.hideFromBlockDisplay`. */
export const blockTypeHideFromBlockDisplayProp = seedProperty({
  seedKey: 'system:kernel-data/property/block-type-hide-from-block-display',
  revision: 1,
  name: 'block-type:hide-from-block-display',
  preset: 'boolean',
  changeScope: ChangeScope.BlockDefault,
})

/** CSS color for this type's tag chip (any `color`-property value:
 *  `#e11d48`, `tomato`, `hsl(…)`, …). Empty = default chip styling.
 *  Lifted onto `TypeContribution.color`. */
export const blockTypeColorProp = seedProperty({
  seedKey: 'system:kernel-data/property/block-type-color',
  revision: 1,
  name: 'block-type:color',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

// ──── user page kernel fields ────

/** Opaque user id (the value stored in `created_by` / `updated_by`) on a
 *  `'user'` user-page block. Gives the page a structured, queryable link
 *  between the id and the display name (the block's content) alongside
 *  the human-friendly alias — so attribution surfaces can resolve either
 *  direction without parsing aliases. */
export const userIdProp = seedProperty({
  seedKey: 'system:kernel-data/property/user-id',
  revision: 1,
  name: 'user:id',
  preset: 'string',
  changeScope: ChangeScope.BlockDefault,
})

/** Alias list stored on alias-target / daily-note blocks (§7). The
 *  encoded shape in `properties_json` is `string[]`; the codec is the
 *  list-of-strings combinator.
 *
 *  This is the schema `parseReferences` writes when a tx inserts a
 *  target block (e.g. `[[Inbox]]` produces a target with
 *  `aliases: ['Inbox']`), and the same schema alias-lookup queries
 *  consult to resolve `[[alias]]` to a target id. */
// The shared string-list core exposes readonly values, while its decoder
// returns a fresh mutable array. Preserve aliasesProp's historical string[]
// handle contract without widening the public seedProperty overloads.
export const aliasesProp = seedProperty({
  seedKey: 'system:kernel-data/property/alias',
  revision: 1,
  name: 'alias',
  preset: 'string-list',
  changeScope: ChangeScope.BlockDefault,
}) as PropertySeedDeclaration<string[]>

// ──── Helpers ────

export const getBlockTypes = (data: Pick<BlockData, 'properties'>): readonly string[] => {
  const raw = data.properties[typesProp.name]
  return raw === undefined ? typesProp.defaultValue : typesProp.codec.decode(raw)
}

export const hasBlockType = (
  data: Pick<BlockData, 'properties'>,
  typeId: string,
): boolean => getBlockTypes(data).includes(typeId)

/** The block's `alias` list, tolerant of an absent / malformed value
 *  (treated as none). Shared by every reader that only needs "which
 *  aliases does this row claim" — the alias-sync processor, the
 *  block-type typeify processor, the type-editor seed. */
export const getAliases = (data: Pick<BlockData, 'properties'>): readonly string[] => {
  const raw = data.properties[aliasesProp.name]
  if (raw === undefined) return []
  try {
    return aliasesProp.codec.decode(raw)
  } catch {
    return []
  }
}

/** Type-membership delta helpers for same-tx processors that watch the
 *  `properties` field. `row.before` is null on insert; `row.after` is
 *  null on hard-delete — both are null-safe here, returning the
 *  appropriate one-sided diff. Order in the returned array matches
 *  `typesProp.codec.decode` order on whichever side is non-null. */
export const addedTypes = (row: ChangedRow): readonly string[] => {
  const before = row.before ? new Set(getBlockTypes(row.before)) : new Set<string>()
  const after = row.after ? getBlockTypes(row.after) : []
  return after.filter(t => !before.has(t))
}

export const removedTypes = (row: ChangedRow): readonly string[] => {
  const before = row.before ? getBlockTypes(row.before) : []
  const after = row.after ? new Set(getBlockTypes(row.after)) : new Set<string>()
  return before.filter(t => !after.has(t))
}

/** Raw membership writer for BlockData construction paths that do not
 *  have a Repo/Tx available. Does not run setup or materialise
 *  addType initial values. */
export const addBlockTypeToProperties = (
  properties: Record<string, unknown>,
  typeId: string,
): Record<string, unknown> => {
  const current = getBlockTypes({properties})
  if (current.includes(typeId)) return properties
  return {
    ...properties,
    [typesProp.name]: typesProp.codec.encode([...current, typeId]),
  }
}

/** Set the editing flag on the UI-state block. Refuses to enter edit
 *  mode in a read-only repo (workspace viewer) — the wrappers also
 *  short-circuit, but this gate keeps any new caller honest. */
export const setIsEditing = (uiStateBlock: Block, editing: boolean): void => {
  if (editing && uiStateBlock.repo.isReadOnly) return
  void uiStateBlock.set(isEditingProp, editing)
}

const decodeFocusedBlockLocation = (raw: unknown): FocusedBlockLocation | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const maybe = raw as Record<string, unknown>
  return typeof maybe.blockId === 'string' && typeof maybe.renderScopeId === 'string'
    ? {blockId: maybe.blockId, renderScopeId: maybe.renderScopeId}
    : undefined
}

export const focusedBlockLocationFromProperties = (
  properties: Record<string, unknown> | undefined,
): FocusedBlockLocation | undefined => {
  if (!properties) return undefined
  return decodeFocusedBlockLocation(properties[focusedBlockLocationProp.name])
}

export const peekFocusedBlockLocation = (uiStateBlock: Block): FocusedBlockLocation | undefined =>
  focusedBlockLocationFromProperties(uiStateBlock.peek()?.properties)

export const isFocusedBlock = (
  uiStateBlock: Block,
  blockId: string,
  renderScopeId?: string,
): boolean => {
  const location = peekFocusedBlockLocation(uiStateBlock)
  if (!location || location.blockId !== blockId) return false
  return renderScopeId ? location.renderScopeId === renderScopeId : true
}

export const sameFocusedBlockLocation = (
  a: FocusedBlockLocation | undefined,
  b: FocusedBlockLocation | undefined,
): boolean =>
  Boolean(a && b && a.blockId === b.blockId && a.renderScopeId === b.renderScopeId)

const isEditingFromProperties = (
  properties: Record<string, unknown> | undefined,
): boolean => {
  const encoded = properties?.[isEditingProp.name]
  return encoded === undefined
    ? isEditingProp.defaultValue
    : isEditingProp.codec.decode(encoded)
}

/** Atomically move focus to `blockId` and set the edit flag in one tx.
 *
 *  Focus is a rendered location, not just a logical block id: the
 *  same block can appear in the outline, backlinks, and any number of
 *  embeds at once. The render scope disambiguates those copies while
 *  keeping selection state separately keyed by block id.
 *
 *  Returns the tx-commit promise so callers that need to observe
 *  focus-derived state next can `await` instead of racing propagation. */
export const focusBlock = async (
  uiStateBlock: Block,
  blockId: string,
  options: {edit?: boolean; renderScopeId?: string} = {},
): Promise<void> => {
  const {edit = false, renderScopeId} = options
  // Match the legacy `setIsEditing` read-only gate: a viewer can't
  // transition into edit mode, but it can still mark focus (highlight,
  // nav anchor).
  const targetEdit = edit && !uiStateBlock.repo.isReadOnly ? true : false
  const currentLocation = peekFocusedBlockLocation(uiStateBlock)
  const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
  const fallbackRenderScopeId = currentLocation?.blockId === blockId
    ? currentLocation.renderScopeId
    : outlineRenderScopeId(topLevelBlockId ?? blockId)
  const location: FocusedBlockLocation = {
    blockId,
    renderScopeId: renderScopeId ?? fallbackRenderScopeId,
  }
  await uiStateBlock.repo.tx(async tx => {
    const current = targetEdit ? null : await tx.get(uiStateBlock.id)
    const preserveCurrentEditMode = !targetEdit &&
      sameFocusedBlockLocation(focusedBlockLocationFromProperties(current?.properties), location) &&
      isEditingFromProperties(current?.properties)

    await tx.setProperty(uiStateBlock.id, focusedBlockLocationProp, location)
    await tx.setProperty(uiStateBlock.id, isEditingProp, preserveCurrentEditMode || targetEdit)
  }, {scope: ChangeScope.UiState, description: 'focus block'})
}

/** Exit edit mode on behalf of `blockId` — but only if that block still
 *  owns edit mode when the tx commits.
 *
 *  `isEditing` is a single flag shared across the UI-state surface, so an
 *  unconditional clear is identity-less: it can't tell *whose* edit mode it
 *  ends. During a block→block tap the tapped block's `focusBlock(edit:true)`
 *  and the outgoing editor's blur-driven exit race. An anonymous clear that
 *  commits *after* the handoff clobbers the flag the new block just set,
 *  dropping edit mode entirely (on a soft keyboard it hides, needing a
 *  second tap) — and it only misfires under that timing, which is why it
 *  doesn't repro on fast/native paths.
 *
 *  Reading the focused location INSIDE the tx (commit-consistent — the same
 *  `tx.get` pattern `focusBlock` uses to preserve edit mode) makes this a
 *  compare-and-swap: whichever of the two txs commits second sees the
 *  other's effect, so both interleavings settle on the tapped block editing.
 *  Unlike a DOM-focus heuristic it's oblivious to *where* focus physically
 *  sits (the iOS soft-keyboard proxy input, the incoming block's shell, …). */
export const exitEditModeForBlock = async (
  uiStateBlock: Block,
  blockId: string,
  renderScopeId?: string,
): Promise<void> => {
  await uiStateBlock.repo.tx(async tx => {
    const location = focusedBlockLocationFromProperties((await tx.get(uiStateBlock.id))?.properties)
    // Another block owns the focused location now (or a different render-scope
    // copy of this block does) → the handoff already moved on; not ours to clear.
    if (location && location.blockId !== blockId) return
    if (location && renderScopeId !== undefined && location.renderScopeId !== renderScopeId) return
    await tx.setProperty(uiStateBlock.id, isEditingProp, false)
  }, {scope: ChangeScope.UiState, description: 'exit edit mode'})
}

export const requestEditorFocus = (uiStateBlock: Block): void => {
  const current = uiStateBlock.peekProperty(editorFocusRequestProp) ?? 0
  void uiStateBlock.set(editorFocusRequestProp, current + 1)
}

// Re-export PropertySchema for callers who want to type-narrow.
export type { PropertySchema }

// ──── Kernel bundle ────

/** Every kernel-owned property seed in one array. Consumed by
 *  `kernelDataExtension` through `definitionSeedsFacet`; the workspace-bound
 *  registry synthesizes the corresponding behavioral entries and identities.
 *
 *  Heterogeneous seed declarations flatten through
 *  `AnyPropertySeedDeclaration` for storage in the array — the precise
 *  per-property types stay at the export sites and reach typed callers
 *  via the handle reference (`block.set(typesProp, ...)` etc.). */
export const KERNEL_PROPERTY_SEEDS: readonly AnyPropertySeedDeclaration[] = [
  // UI-state schemas
  showPropertiesProp,
  isEditingProp,
  topLevelBlockIdProp,
  focusedBlockLocationProp,
  activePanelIdProp,
  scrollTopProp,
  editorSelection,
  editorFocusRequestProp,
  selectionStateProp,
  // BlockDefault schemas
  isCollapsedProp,
  typesProp,
  rendererProp,
  rendererNameProp,
  createdAtProp,
  sourceBlockIdProp,
  aliasesProp,
  // extension block fields
  extensionNameProp,
  extensionDescriptionProp,
  // property-schema fields
  propertyNameProp,
  presetIdProp,
  presetConfigProp,
  propertyChangeScopeProp,
  propertyDefaultProp,
  propertyHiddenProp,
  seedKeyProp,
  seedRevisionProp,
  // block-type fields
  blockTypeLabelProp,
  blockTypeDescriptionProp,
  blockTypePropertiesProp,
  blockTypeHideFromBlockDisplayProp,
  blockTypeColorProp,
  // user page fields
  userIdProp,
]
