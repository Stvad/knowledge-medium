import { RefPropertyEditor } from '@/components/propertyEditors/RefPropertyEditor'
import type { PropertyEditorProps } from '@/data/api'
import { storedIsoDay } from './dayProperty'

/** The property panel reads the owner’s projected value, even when the outline has value blocks. */
export function DayReferencePanelEditor(props: PropertyEditorProps<string | undefined>) {
  const missingTargetText = props.value && storedIsoDay(props.value) ? props.value : undefined
  return <RefPropertyEditor {...props} missingTargetText={missingTargetText}/>
}
