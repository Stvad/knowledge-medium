import { propertyEditorOverridesFacet } from '@/data/facets'
import { codeMirrorExtensionsFacet } from '@/editor/codeMirrorExtensions'
import { blockLayoutFacet, shortcutSurfaceActivationsFacet, type BlockLayoutContribution } from '@/extensions/blockInteraction'
import { actionContextsFacet, actionsFacet } from '@/extensions/core'
import type { AppExtension } from '@/facets/facet'
import { systemToggle } from '@/facets/togglable'
import { propertyRowsPlugin } from '@/plugins/property-rows'
import { drawsPropertyRows } from '@/plugins/property-rows/fieldRow'
import { spatialNavExclusionsFacet } from '@/plugins/spatial-navigation/exclusionsFacet'
import { tableConversionActions } from './actions'
import { tableChildrenViews } from './childrenViews'
import { cellEditorExtension } from './cellEdits'
import { tablesDataExtension } from './dataExtension'
import { queryPropertyUi } from './QueryUi'
import { queryCompletionExtension } from './query/completion'
import { tableRowVerbs } from './rowVerbs'
import {
  tableActionContexts, tableActions, tableOutlineVerbRedirects, tableRoleOf, tableShortcutActivation,
} from './keys'
import { tableVerticalSteps } from './navigation'
import { CELL_SURFACE, TableCellLayout, TableHostLayout, TableRowLayout } from './TableLayout'
import { TABLE_TYPE } from './schema'

const SOURCE = 'tables'

/** Cell and row before host: a row may itself be a table. Precedence 100 puts these above
 *  the property-rows field layout (-100), which a value row would otherwise get. */
const tableLayoutContribution: BlockLayoutContribution = ({block, blockContext, types}) => {
  const role = tableRoleOf(block.id, blockContext)
  if (role === 'cell') return {id: 'tables.cell', label: 'Table cell', render: TableCellLayout}
  if (role === 'row') return {id: 'tables.row', label: 'Table row', render: TableRowLayout}
  if (types.includes(TABLE_TYPE) && drawsPropertyRows(blockContext)) {
    return {id: 'tables.table', label: 'Table', render: TableHostLayout}
  }
  return null
}

export const tablesPlugin: AppExtension = systemToggle({
  id: 'system:tables',
  name: 'Tables',
  description: 'Show a block’s children as a grid: one row per child, one column per property, each cell its real value block.',
}).of([
  // Cells draw value rows through its inline controls and value completions.
  propertyRowsPlugin,
  tablesDataExtension,
  tableChildrenViews,
  blockLayoutFacet.of(tableLayoutContribution, {source: SOURCE, precedence: 100}),
  shortcutSurfaceActivationsFacet.of(tableShortcutActivation, {source: SOURCE}),
  spatialNavExclusionsFacet.of(CELL_SURFACE, {source: SOURCE}),
  codeMirrorExtensionsFacet.of(cellEditorExtension, {source: SOURCE}),
  codeMirrorExtensionsFacet.of(queryCompletionExtension, {source: SOURCE}),
  propertyEditorOverridesFacet.of(queryPropertyUi, {source: SOURCE}),
  tableActionContexts.map(config => actionContextsFacet.of(config, {source: SOURCE})),
  [...tableActions, ...tableConversionActions].map(action => actionsFacet.of(action, {source: SOURCE})),
  tableOutlineVerbRedirects,
  tableRowVerbs,
  tableVerticalSteps,
])
