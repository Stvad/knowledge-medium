import { type ComponentType } from 'react'
import {
  type AnyPropertyEditorOverride,
  type AnyPropertySchema,
  type AnyJoinedValuePreset,
  type PropertyEditor,
  type TypeContribution,
} from '@/data/api'
import { getBlockTypes, typesProp } from '@/data/properties.js'
import {
  buildPropertyPanelSections,
  type PropertyPanelRow,
  type PropertyPanelSection,
} from '@/components/propertyPanelSections'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults'
import {
  resolveEditorOverride,
  type PropertyDefinitionRegistrySnapshot,
} from '@/data/propertyDefinitionRegistry'
import type { TypeDefinitionRegistrySnapshot } from '@/data/typeDefinitionRegistry'
import {
  isPropertyPanelHiddenProperty,
  isPropertyPanelReadOnlyProperty,
} from './visibility'
import {
  declarationOnlyDefinitionForName,
  declarationOnlyStatusText,
} from './declarationOnly'

const EMPTY_BLOCK_TYPES: readonly string[] = []

export interface PropertyPanelMetadataRow {
  readonly label: string
  readonly value: string
  /** When set, the value renders as a link opening this block (e.g.
   *  "Changed by" → the editing user's page). */
  readonly linkToBlockId?: string
}

export interface PropertyPanelModelRow {
  readonly name: string
  readonly encodedValue: unknown
  readonly isSet: boolean
  readonly labelText: string
  /** Codec type (open string). */
  readonly shape: string
  readonly schema: AnyPropertySchema
  readonly schemaUnknown: boolean
  readonly decodeFailed: boolean
  readonly value: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly Editor?: PropertyEditor<any>
  /** Resolved glyph: per-name `PropertyEditorOverride.Glyph` wins, else
   *  the matching `ValuePreset.Glyph`. Undefined falls back to the
   *  codec-type-keyed icon table inside `PropertyShapeGlyph`. */
  readonly Glyph?: ComponentType<{className?: string}>
  readonly canRename: boolean
  readonly canDelete: boolean
  readonly canChangeShape: boolean
  readonly isHidden: boolean
  /** Row-level lock independent of repository read-only mode. */
  readonly readOnly: boolean
  readonly statusText?: string
}

export interface PropertyPanelModelSection {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly rows: readonly PropertyPanelModelRow[]
}

export interface PropertyPanelModel {
  readonly blockTypes: readonly string[]
  readonly pinnedRows: readonly PropertyPanelModelRow[]
  readonly sections: readonly PropertyPanelModelSection[]
  readonly hiddenSection: PropertyPanelModelSection
  readonly metadataRows: readonly PropertyPanelMetadataRow[]
  readonly hiddenCount: number
  readonly showSectionLabels: boolean
}

export const HIDDEN_SECTION: PropertyPanelSection = {id: 'hidden', label: 'Hidden', rows: []}

const DECODE_FAILED = Symbol('decode-failed')

const safeDecode = (schema: AnyPropertySchema, encoded: unknown): unknown => {
  try {
    return schema.codec.decode(encoded)
  } catch {
    return DECODE_FAILED
  }
}

const readBlockTypes = (properties: Record<string, unknown>): readonly string[] => {
  try {
    return getBlockTypes({properties})
  } catch {
    return EMPTY_BLOCK_TYPES
  }
}

const partitionProperties = (
  properties: Record<string, unknown>,
  schemas: ReadonlyMap<string, AnyPropertySchema>,
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>,
  definitions: PropertyDefinitionRegistrySnapshot | null,
): {
  visibleProperties: Record<string, unknown>
  hiddenProperties: Record<string, unknown>
} => {
  const visibleProperties: Record<string, unknown> = {}
  const hiddenProperties: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(properties)) {
    if (isPropertyPanelHiddenProperty(name, schemas, uis, definitions)) hiddenProperties[name] = value
    else visibleProperties[name] = value
  }

  return {visibleProperties, hiddenProperties}
}

const resolveModelRow = (
  row: PropertyPanelRow,
  args: {
    schemas: ReadonlyMap<string, AnyPropertySchema>
    uis: ReadonlyMap<string, AnyPropertyEditorOverride>
    presets: ReadonlyMap<string, AnyJoinedValuePreset>
    definitions: PropertyDefinitionRegistrySnapshot | null
    hidden: boolean
    /** True when the block this panel is for is itself a materialized seed
     *  definition. Its whole property bag is code-owned (§5.1), so every row
     *  is locked — not just the `seed:key`/`seed:revision` provenance markers.
     *  Otherwise editing e.g. `property-schema:hidden` on a code-owned seed
     *  would mutate the definition metadata the panel itself trusts. */
    blockIsSeededDefinition: boolean
  },
): PropertyPanelModelRow | null => {
  const ui = resolveEditorOverride(
    row.name,
    args.definitions,
    args.uis,
    args.schemas.get(row.name),
  )
  const display = resolvePropertyDisplay({
    name: row.name,
    encodedValue: row.isSet ? row.encodedValue : undefined,
    schemas: args.schemas,
    override: ui,
    presets: args.presets,
  })
  const declarationOnly = declarationOnlyDefinitionForName(
    row.name,
    args.definitions,
  )
  const rowReadOnly =
    args.blockIsSeededDefinition ||
    declarationOnly !== undefined ||
    isPropertyPanelReadOnlyProperty(row.name)

  if (!row.isSet && !display.isKnown && declarationOnly === undefined) return null

  const decodedValue = declarationOnly
    ? row.encodedValue
    : row.isSet
    ? display.isKnown
      ? safeDecode(display.schema, row.encodedValue)
      : row.encodedValue
    : display.schema.defaultValue
  const decodeFailed = row.isSet && display.isKnown && decodedValue === DECODE_FAILED
  const isTypeMembershipRow = row.name === typesProp.name

  return {
    name: row.name,
    encodedValue: row.encodedValue,
    isSet: row.isSet,
    labelText: ui?.label ?? row.name,
    shape: display.shape,
    schema: display.schema,
    schemaUnknown: !display.isKnown && declarationOnly === undefined,
    decodeFailed,
    value: decodeFailed ? row.encodedValue : decodedValue,
    Editor: rowReadOnly ? undefined : display.Editor,
    Glyph: display.Glyph,
    canRename: !args.hidden && !display.isKnown && !rowReadOnly,
    canDelete: !args.hidden && row.isSet && !isTypeMembershipRow && !rowReadOnly,
    canChangeShape: !args.hidden && !display.isKnown && !rowReadOnly,
    isHidden: args.hidden,
    readOnly: rowReadOnly,
    ...(declarationOnly
      ? {
          statusText: declarationOnlyStatusText(declarationOnly),
        }
      : {}),
  }
}

const resolveSection = (
  section: PropertyPanelSection,
  args: {
    schemas: ReadonlyMap<string, AnyPropertySchema>
    uis: ReadonlyMap<string, AnyPropertyEditorOverride>
    presets: ReadonlyMap<string, AnyJoinedValuePreset>
    definitions: PropertyDefinitionRegistrySnapshot | null
    hidden: boolean
    blockIsSeededDefinition: boolean
  },
): PropertyPanelModelSection | null => {
  const rows = section.rows
    .map(row => resolveModelRow(row, args))
    .filter((row): row is PropertyPanelModelRow => row !== null)

  if (rows.length === 0) return null

  return {
    id: section.id,
    label: section.label,
    description: section.description,
    rows,
  }
}

export const buildPropertyPanelModel = (args: {
  blockId: string
  updatedAt: number
  updatedBy: string
  /** User page block id for `updatedBy`, so "Changed by" can link to it. */
  updatedByBlockId?: string
  properties: Record<string, unknown>
  schemas: ReadonlyMap<string, AnyPropertySchema>
  propertyDefinitions: PropertyDefinitionRegistrySnapshot | null
  typeDefinitions: TypeDefinitionRegistrySnapshot | null
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>
  presets: ReadonlyMap<string, AnyJoinedValuePreset>
  typesRegistry: ReadonlyMap<string, TypeContribution>
  syntheticRows?: readonly PropertyPanelRow[]
}): PropertyPanelModel => {
  const blockTypes = readBlockTypes(args.properties)
  // A materialized seed definition block's whole bag is code-owned. The
  // registry already parsed this block's provenance (seedKey present iff it's
  // a valid seed), so lock every row of its panel — not just the provenance
  // markers `isPropertyPanelReadOnlyProperty` catches by name. Check BOTH
  // registries: property-seed backing blocks are keyed in the property registry
  // by field id; type-seed (`block-type`) backing blocks are keyed in the type
  // registry by block id.
  const blockIsSeededDefinition =
    args.propertyDefinitions?.definitionsByFieldId.get(args.blockId)?.seedKey !== undefined ||
    args.typeDefinitions?.definitionsByBlockId.get(args.blockId)?.seedKey !== undefined
  const {visibleProperties, hiddenProperties} = partitionProperties(
    args.properties,
    args.schemas,
    args.uis,
    args.propertyDefinitions,
  )
  const pinnedRawRows: readonly PropertyPanelRow[] = [{
    name: typesProp.name,
    encodedValue: Object.hasOwn(visibleProperties, typesProp.name)
      ? visibleProperties[typesProp.name]
      : typesProp.codec.encode(blockTypes),
    isSet: true,
  }]
  const sectionProperties = {...visibleProperties}
  delete sectionProperties[typesProp.name]

  const pinnedRows = pinnedRawRows
    .map(row => resolveModelRow(row, {
      schemas: args.schemas,
      uis: args.uis,
      presets: args.presets,
      definitions: args.propertyDefinitions,
      hidden: false,
      blockIsSeededDefinition,
    }))
    .filter((row): row is PropertyPanelModelRow => row !== null)

  const rawSections = buildPropertyPanelSections({
    properties: sectionProperties,
    blockTypes,
    typesRegistry: args.typesRegistry,
    schemas: args.schemas,
    syntheticRows: args.syntheticRows,
  })

  const sections = rawSections
    .map(section => resolveSection({
      ...section,
      rows: section.rows.filter(row => !isPropertyPanelHiddenProperty(
        row.name,
        args.schemas,
        args.uis,
        args.propertyDefinitions,
      )),
    }, {
      schemas: args.schemas,
      uis: args.uis,
      presets: args.presets,
      definitions: args.propertyDefinitions,
      hidden: false,
      blockIsSeededDefinition,
    }))
    .filter((section): section is PropertyPanelModelSection => section !== null)

  const hiddenRows = Object.keys(hiddenProperties).sort().map(name => ({
    name,
    encodedValue: hiddenProperties[name],
    isSet: true,
  }))
  const hiddenSection = resolveSection({
    ...HIDDEN_SECTION,
    rows: hiddenRows,
  }, {
    schemas: args.schemas,
    uis: args.uis,
    presets: args.presets,
    definitions: args.propertyDefinitions,
    hidden: true,
    blockIsSeededDefinition,
  }) ?? {...HIDDEN_SECTION, rows: []}

  const metadataRows = [
    {label: 'ID', value: args.blockId},
    {label: 'Last changed', value: new Date(args.updatedAt).toLocaleString()},
    {label: 'Changed by', value: args.updatedBy, linkToBlockId: args.updatedByBlockId},
  ]

  return {
    blockTypes,
    pinnedRows,
    sections,
    hiddenSection,
    metadataRows,
    hiddenCount: metadataRows.length + hiddenSection.rows.length,
    showSectionLabels: sections.length > 1,
  }
}
