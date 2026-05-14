import { definePropertyEditorOverride } from '@/data/api'
import { dailyNoteBacklinksDefaultsProp } from './dailyNoteDefaults.ts'
import type { StoredBacklinksFilter } from './filterProperty.ts'
import { BacklinksFilterPropertyEditor } from './BacklinksFilterPropertyEditor.tsx'

export const dailyNoteBacklinksDefaultsUi = definePropertyEditorOverride<StoredBacklinksFilter>({
  name: dailyNoteBacklinksDefaultsProp.name,
  label: 'Daily note backlinks defaults',
  Editor: BacklinksFilterPropertyEditor,
})
