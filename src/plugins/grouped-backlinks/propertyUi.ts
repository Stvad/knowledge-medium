import { definePropertyUi } from '@/data/api'
import {
  groupedBacklinksDefaultsProp,
  type GroupedBacklinksConfig,
} from './config.ts'
import { GroupedBacklinksDefaultsEditor } from './GroupedBacklinksConfigEditor.tsx'

export const groupedBacklinksDefaultsUi = definePropertyUi<GroupedBacklinksConfig>({
  name: groupedBacklinksDefaultsProp.name,
  label: 'Grouped backlinks defaults',
  category: 'Grouped Backlinks',
  Editor: GroupedBacklinksDefaultsEditor,
})
