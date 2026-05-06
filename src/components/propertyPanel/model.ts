import {
  type AnyPropertySchema,
  type AnyPropertyUiContribution,
  type PropertyEditor,
  type PropertyKind,
  type TypeContribution,
} from '@/data/api'
import { getBlockTypes, typesProp } from '@/data/properties.ts'
import {
  buildPropertyPanelSections,
  type PropertyPanelRow,
  type PropertyPanelSection,
} from '@/components/propertyPanelSections'
import { resolvePropertyDisplay } from '@/components/propertyEditors/defaults'
import { isPropertyPanelHiddenProperty } from './visibility'

const EMPTY_BLOCK_TYPES: readonly string[] = []

export interface PropertyPanelMetadataRow {
  readonly label: string
  readonly value: string
}

export interface PropertyPanelModelRow {
  readonly name: string
  readonly encodedValue: unknown
  readonly isSet: boolean
  readonly labelText: string
  readonly kind: PropertyKind
  readonly schema: AnyPropertySchema
  readonly schemaUnknown: boolean
  readonly decodeFailed: boolean
  readonly value: unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly customEditor?: PropertyEditor<any>
  readonly canRename: boolean
  readonly canDelete: boolean
  readonly canChangeKind: boolean
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
  uis: ReadonlyMap<string, AnyPropertyUiContribution>,
): {
  visibleProperties: Record<string, unknown>
  hiddenProperties: Record<string, unknown>
} => {
  const visibleProperties: Record<string, unknown> = {}
  const hiddenProperties: Record<string, unknown> = {}

  for (const [name, value] of Object.entries(properties)) {
    if (isPropertyPanelHiddenProperty(name, schemas, uis)) hiddenProperties[name] = value
    else visibleProperties[name] = value
  }

  return {visibleProperties, hiddenProperties}
}

const resolveModelRow = (
  row: PropertyPanelRow,
  args: {
    schemas: ReadonlyMap<string, AnyPropertySchema>
    uis: ReadonlyMap<string, AnyPropertyUiContribution>
    hidden: boolean
  },
): PropertyPanelModelRow | null => {
  const display = resolvePropertyDisplay({
    name: row.name,
    encodedValue: row.isSet ? row.encodedValue : undefined,
    schemas: args.schemas,
    uis: args.uis,
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
    kind: display.kind,
    schema: display.schema,
    schemaUnknown: !display.isKnown,
    decodeFailed,
    value: decodeFailed ? row.encodedValue : decodedValue,
    customEditor: display.customEditor,
    canRename: !args.hidden && !display.isKnown,
    canDelete: !args.hidden && row.isSet && !isTypeMembershipRow,
    canChangeKind: !args.hidden && !display.isKnown,
    isHidden: args.hidden,
  }
}

const resolveSection = (
  section: PropertyPanelSection,
  args: {
    schemas: ReadonlyMap<string, AnyPropertySchema>
    uis: ReadonlyMap<string, AnyPropertyUiContribution>
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
  properties: Record<string, unknown>
  schemas: ReadonlyMap<string, AnyPropertySchema>
  uis: ReadonlyMap<string, AnyPropertyUiContribution>
  typesRegistry: ReadonlyMap<string, TypeContribution>
}): PropertyPanelModel => {
  const blockTypes = readBlockTypes(args.properties)
  const {visibleProperties, hiddenProperties} = partitionProperties(
    args.properties,
    args.schemas,
    args.uis,
  )
  const rawSections = buildPropertyPanelSections({
    properties: visibleProperties,
    blockTypes,
    typesRegistry: args.typesRegistry,
    schemas: args.schemas,
    syntheticRows: [{
      name: typesProp.name,
      encodedValue: typesProp.codec.encode(blockTypes),
      isSet: true,
    }],
  })

  const sections = rawSections
    .map(section => resolveSection(section, {
      schemas: args.schemas,
      uis: args.uis,
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
    hidden: true,
  }) ?? {...HIDDEN_SECTION, rows: []}

  const metadataRows = [
    {label: 'ID', value: args.blockId},
    {label: 'Last changed', value: new Date(args.updatedAt).toLocaleString()},
    {label: 'Changed by', value: args.updatedBy},
  ]

  return {
    blockTypes,
    sections,
    hiddenSection,
    metadataRows,
    hiddenCount: metadataRows.length + hiddenSection.rows.length,
    showSectionLabels: sections.length > 1,
  }
}
