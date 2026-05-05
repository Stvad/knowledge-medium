import {
  type AnyPropertySchema,
  type TypeContribution,
} from '@/data/api'

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
}): readonly PropertyPanelSection[] => {
  const hasProperty = (name: string) => Object.prototype.hasOwnProperty.call(args.properties, name)
  const assigned = new Set<string>()
  const sections: PropertyPanelSection[] = []

  const setRowsFirst = (rows: PropertyPanelRow[]): PropertyPanelRow[] => [
    ...rows.filter(row => row.isSet),
    ...rows.filter(row => !row.isSet),
  ]

  const seenTypeIds = new Set<string>()
  for (const typeId of args.blockTypes) {
    if (seenTypeIds.has(typeId)) continue
    seenTypeIds.add(typeId)

    const contribution = args.typesRegistry.get(typeId)
    if (!contribution) continue

    const rows: PropertyPanelRow[] = []
    for (const declared of contribution.properties ?? []) {
      if (assigned.has(declared.name)) continue

      const active = args.schemas.get(declared.name)
      if (!active) continue

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
        rows: setRowsFirst(rows),
      })
    }
  }

  const otherRows: PropertyPanelRow[] = []
  const unregisteredRows: PropertyPanelRow[] = []

  for (const name of Object.keys(args.properties)) {
    if (assigned.has(name)) continue

    const row: PropertyPanelRow = {
      name,
      encodedValue: args.properties[name],
      isSet: true,
    }
    if (args.schemas.has(name)) otherRows.push(row)
    else unregisteredRows.push(row)
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
