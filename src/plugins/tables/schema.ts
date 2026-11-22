/** What a table stores. A table is an ordinary block tagged {@link TABLE_TYPE}:
 *  its first {@link VIEW_TYPE} child names the view, and that view's
 *  {@link COLUMN_TYPE} children are the columns, in sibling order. Every other
 *  child of the host is a row. A column with no field shows the row's own
 *  content; its block content is an optional header label. A hidden column
 *  stays a column block, keeping its place and width, so showing it again
 *  restores it. */
import { ChangeScope, seedProperty, seedType } from '@/data/api'
import { PROPERTY_SCHEMA_TYPE } from '@/data/blockTypes'

export const TABLE_TYPE = 'tables:table'
export const VIEW_TYPE = 'tables:view'
export const COLUMN_TYPE = 'tables:column'

export const columnFieldProp = seedProperty({
  seedKey: 'system:tables/property/column-field',
  revision: 1,
  name: 'tables:columnField',
  preset: 'optional-ref',
  config: {targetTypes: [PROPERTY_SCHEMA_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const columnWidthProp = seedProperty({
  seedKey: 'system:tables/property/column-width',
  revision: 1,
  name: 'tables:columnWidth',
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

/** Absent ≡ shown. Showing a column unsets it rather than writing false. */
export const columnHiddenProp = seedProperty({
  seedKey: 'system:tables/property/column-hidden',
  revision: 1,
  name: 'tables:columnHidden',
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

/** The table's query, on the host: its value block's text is the query.
 *  Unset means the rows are the host's children. */
export const queryProp = seedProperty({
  seedKey: 'system:tables/property/query',
  revision: 1,
  name: 'tables:query',
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** On a view: the column its rows sort by. Unset means no sort. */
export const viewSortColumnProp = seedProperty({
  seedKey: 'system:tables/property/view-sort-column',
  revision: 1,
  name: 'tables:viewSortColumn',
  preset: 'optional-ref',
  config: {targetTypes: [COLUMN_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const SORT_DIRECTIONS = ['asc', 'desc'] as const
export type SortDirection = typeof SORT_DIRECTIONS[number]

export const viewSortDirectionProp = seedProperty({
  seedKey: 'system:tables/property/view-sort-direction',
  revision: 1,
  name: 'tables:viewSortDirection',
  preset: 'strict-enum',
  config: {options: SORT_DIRECTIONS.map(value => ({value, label: value === 'asc' ? 'Ascending' : 'Descending'}))},
  defaultValue: 'asc',
  changeScope: ChangeScope.BlockDefault,
})

export const TABLE_PROPERTY_SEEDS = [
  columnFieldProp, columnWidthProp, columnHiddenProp, queryProp, viewSortColumnProp, viewSortDirectionProp,
] as const

export const TABLE_TYPE_SEEDS = [
  seedType({
    seedKey: 'system:tables/type/table',
    revision: 1,
    id: TABLE_TYPE,
    label: 'Table',
    description: 'Shows the block’s children as rows of a grid, one column per property.',
  }),
  seedType({
    seedKey: 'system:tables/type/view',
    revision: 1,
    id: VIEW_TYPE,
    label: 'Table view',
    description: 'One way of showing a table. Its children are the columns, in order.',
  }),
  seedType({
    seedKey: 'system:tables/type/column',
    revision: 1,
    id: COLUMN_TYPE,
    label: 'Table column',
    description: 'A table column. Its field is the property it shows; with no field it shows the row’s own text.',
    properties: [columnFieldProp, columnWidthProp, columnHiddenProp],
  }),
]
