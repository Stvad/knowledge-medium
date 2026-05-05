import { defineBlockType, type TypeContribution } from '@/data/api'

export const EXTENSION_TYPE = 'extension'
export const PAGE_TYPE = 'page'
export const PANEL_TYPE = 'panel'
export const JOURNAL_TYPE = 'journal'
export const DAILY_NOTE_TYPE = 'daily-note'

export const KERNEL_TYPE_CONTRIBUTIONS: readonly TypeContribution[] = [
  defineBlockType({id: EXTENSION_TYPE, label: 'Extension'}),
  defineBlockType({id: PAGE_TYPE, label: 'Page'}),
  defineBlockType({id: PANEL_TYPE, label: 'Panel'}),
  defineBlockType({id: JOURNAL_TYPE, label: 'Journal'}),
  defineBlockType({id: DAILY_NOTE_TYPE, label: 'Daily note'}),
]

