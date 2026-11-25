import { RefPropertyEditor } from '@/components/propertyEditors/RefPropertyEditor'
import type { PropertyEditorProps } from '@/data/api'
import { Block } from '@/data/block'
import { useBlockExists } from '@/hooks/block'
import { storedIsoDay } from './dayProperty'

function LiteralDayReference({target, editorProps}: {
  target: Block; editorProps: PropertyEditorProps<string | undefined>
}) {
  const exists = useBlockExists(target)
  return exists
    ? <RefPropertyEditor {...editorProps}/>
    : <span className="block truncate text-sm text-muted-foreground" title={target.id}>{target.id}</span>
}

/** The property panel reads the owner’s projected value, even when the outline has value blocks. */
export function DayReferencePanelEditor(props: PropertyEditorProps<string | undefined>) {
  if (props.block instanceof Block && props.value && storedIsoDay(props.value)) {
    return <LiteralDayReference target={props.block.repo.block(props.value)} editorProps={props}/>
  }
  return <RefPropertyEditor {...props}/>
}
