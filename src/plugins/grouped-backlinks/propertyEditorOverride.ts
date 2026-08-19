import { definePropertyEditorOverride } from '@/data/api'
import { groupedBacklinksDefaultsProp } from './config.ts'
import { GroupedBacklinksDefaultsEditor } from './GroupedBacklinksConfigEditor.tsx'

export const groupedBacklinksDefaultsUi = definePropertyEditorOverride(groupedBacklinksDefaultsProp, {
  label: 'Grouped backlinks defaults',
  Editor: GroupedBacklinksDefaultsEditor,
})
