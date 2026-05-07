import { definePropertyEditorOverride } from '@/data/api'
import {
  groupedBacklinksDefaultsProp,
  type GroupedBacklinksConfig,
} from './config.ts'
import { GroupedBacklinksDefaultsEditor } from './GroupedBacklinksConfigEditor.tsx'

export const groupedBacklinksDefaultsUi = definePropertyEditorOverride<GroupedBacklinksConfig>({
  name: groupedBacklinksDefaultsProp.name,
  label: 'Grouped backlinks defaults',
  Editor: GroupedBacklinksDefaultsEditor,
})
