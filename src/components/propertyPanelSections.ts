import {
  type AnyPropertySchema,
  type TypeContribution,
} from '@/data/api'
import {typePropertyGroups} from '@/data/typePropertyGroups'

export interface PropertyPanelRow {
  readonly name: string
  readonly encodedValue: unknown
  readonly isSet: boolean
}

export interface PropertyPanelSection {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly rows: readonly PropertyPanelRow[]
}

export const buildPropertyPanelSections = (args: {
  properties: Record<string, unknown>
  blockTypes: readonly string[]
  typesRegistry: ReadonlyMap<string, TypeContribution>
  schemas: ReadonlyMap<string, AnyPropertySchema>
  syntheticRows?: readonly PropertyPanelRow[]
}): readonly PropertyPanelSection[] => {
  const hasProperty = (name: string) => Object.hasOwn(args.properties, name)
  const assigned = new Set<string>()
  const sections: PropertyPanelSection[] = []

  for (const {typeId, contribution, fields} of typePropertyGroups(args.blockTypes, args.typesRegistry, args.schemas)) {
    const rows: PropertyPanelRow[] = []
    for (const {declaration: declared, schema: active} of fields) {
      if (assigned.has(declared.name)) continue

      assigned.add(declared.name)
      const isSet = hasProperty(active.name)
      rows.push({
        name: active.name,
        encodedValue: args.properties[active.name],
        isSet,
      })
    }

    if (rows.length > 0) {
      sections.push({
        id: `type:${typeId}`,
        label: contribution.label ?? typeId,
        description: contribution.description,
        rows,
      })
    }
  }

  const otherRows: PropertyPanelRow[] = []
  const unregisteredRows: PropertyPanelRow[] = []

  const addLooseRow = (row: PropertyPanelRow): void => {
    if (assigned.has(row.name)) return
    if (args.schemas.has(row.name)) otherRows.push(row)
    else unregisteredRows.push(row)
  }

  for (const name of Object.keys(args.properties)) {
    if (assigned.has(name)) continue

    addLooseRow({
      name,
      encodedValue: args.properties[name],
      isSet: true,
    })
  }

  for (const row of args.syntheticRows ?? []) {
    if (hasProperty(row.name)) continue
    addLooseRow(row)
  }

  if (otherRows.length > 0) {
    sections.push({
      id: 'other',
      label: 'Other',
      rows: otherRows,
    })
  }

  if (unregisteredRows.length > 0) {
    sections.push({
      id: 'unregistered',
      label: 'Unregistered',
      rows: unregisteredRows,
    })
  }

  return sections
}
