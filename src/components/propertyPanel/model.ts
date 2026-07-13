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
import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'
import { isPropertyPanelHiddenProperty } from './visibility'

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
    hidden: boolean
  },
): PropertyPanelModelRow | null => {
  const display = resolvePropertyDisplay({
    name: row.name,
    encodedValue: row.isSet ? row.encodedValue : undefined,
    schemas: args.schemas,
    uis: args.uis,
    presets: args.presets,
  })

  if (!row.isSet && !display.isKnown) return null

  const decodedValue = row.isSet
    ? display.isKnown
      ? safeDecode(display.schema, row.encodedValue)
      : row.encodedValue
    : display.schema.defaultValue
  const decodeFailed = row.isSet && display.isKnown && decodedValue === DECODE_FAILED
  const ui = args.uis.get(row.name)
  const isTypeMembershipRow = row.name === typesProp.name

  return {
    name: row.name,
    encodedValue: row.encodedValue,
    isSet: row.isSet,
    labelText: ui?.label ?? row.name,
    shape: display.shape,
    schema: display.schema,
    schemaUnknown: !display.isKnown,
    decodeFailed,
    value: decodeFailed ? row.encodedValue : decodedValue,
    Editor: display.Editor,
    Glyph: display.Glyph,
    canRename: !args.hidden && !display.isKnown,
    canDelete: !args.hidden && row.isSet && !isTypeMembershipRow,
    canChangeShape: !args.hidden && !display.isKnown,
    isHidden: args.hidden,
  }
}

const resolveSection = (
  section: PropertyPanelSection,
  args: {
    schemas: ReadonlyMap<string, AnyPropertySchema>
    uis: ReadonlyMap<string, AnyPropertyEditorOverride>
    presets: ReadonlyMap<string, AnyJoinedValuePreset>
    hidden: boolean
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
  uis: ReadonlyMap<string, AnyPropertyEditorOverride>
  presets: ReadonlyMap<string, AnyJoinedValuePreset>
  typesRegistry: ReadonlyMap<string, TypeContribution>
  syntheticRows?: readonly PropertyPanelRow[]
}): PropertyPanelModel => {
  const blockTypes = readBlockTypes(args.properties)
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
      hidden: false,
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
      hidden: false,
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
    hidden: true,
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
