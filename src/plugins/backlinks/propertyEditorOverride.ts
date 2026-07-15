import { definePropertyEditorOverride } from '@/data/api'
import { dailyNoteBacklinksDefaultsProp } from './dailyNoteDefaults.ts'
import { BacklinksFilterPropertyEditor } from './BacklinksFilterPropertyEditor.tsx'

export const dailyNoteBacklinksDefaultsUi = definePropertyEditorOverride(dailyNoteBacklinksDefaultsProp, {
  label: 'Daily note backlinks defaults',
  Editor: BacklinksFilterPropertyEditor,
})
