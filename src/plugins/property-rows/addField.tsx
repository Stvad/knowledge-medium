import type {ActionConfig} from '@/shortcuts/types'
import {makeCMMode} from '@/shortcuts/utils'
import {ActionContextTypes} from '@/shortcuts/types'
import {useRef} from 'react'
import type {Block} from '@/data/block'
import type {AnyPropertySchema} from '@/data/api'
import {readIsChildBackedWorkspace} from '@/data/workspaceSchema'
import {openDialog, type DialogContextProps} from '@/utils/dialogs'
import {showError} from '@/utils/toast'
import {Dialog, DialogContent, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {InlinePropertyPicker} from '@/components/propertyPanel/InlinePropertyPicker'
import {beginInlineProperty} from '@/components/propertyPanel/inlinePropertyFlow'

export const AddFieldDialog = ({owner, resolve, cancel}: {owner: Block} & DialogContextProps<AnyPropertySchema>) => {
  const selected = useRef(false)
  return <Dialog open onOpenChange={open => { if (!open) cancel() }}>
    <DialogContent onCloseAutoFocus={event => { if (selected.current) event.preventDefault() }}>
      <DialogHeader><DialogTitle>Add field</DialogTitle></DialogHeader>
      <InlinePropertyPicker owner={owner} onCancel={cancel} onPick={async schema => {
        selected.current = true
        resolve(schema)
      }}/>
    </DialogContent>
  </Dialog>
}

export const addFieldAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: 'property-rows.add-field', description: 'Add field to this block',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block, uiStateBlock, renderScopeId}) => {
    try {
      if (block.repo.isReadOnly) throw new Error('This workspace is read-only.')
      const owner = await block.load()
      if (!owner) throw new Error('This block is no longer available.')
      if (!await readIsChildBackedWorkspace(block.repo.db, owner.workspaceId)) {
        throw new Error('This workspace does not yet support properties in the outline.')
      }
      const schema = await openDialog(AddFieldDialog, {owner: block})
      if (!schema) return
      await beginInlineProperty({owner: block, schema, ui: uiStateBlock, scope: renderScopeId})
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Could not add field')
    }
  },
}

export const addFieldActions = [addFieldAction, makeCMMode(addFieldAction)]
