import { defineBlockType, type TypeContribution } from '@/data/api'
import { aliasesProp } from '@/data/internals/coreProperties'

export const EXTENSION_TYPE = 'extension'
export const PAGE_TYPE = 'page'
export const PANEL_TYPE = 'panel'
export const DAILY_NOTE_TYPE = 'daily-note'

export const KERNEL_TYPE_CONTRIBUTIONS: readonly TypeContribution[] = [
  defineBlockType({id: EXTENSION_TYPE, label: 'Extension'}),
  defineBlockType({id: PAGE_TYPE, label: 'Page', properties: [aliasesProp]}),
  defineBlockType({id: PANEL_TYPE, label: 'Panel'}),
  defineBlockType({id: DAILY_NOTE_TYPE, label: 'Daily note', properties: [aliasesProp]}),
]
