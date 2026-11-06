import {ChangeScope} from '@/data/api'
import {focusBlock} from '@/data/properties.js'
import {createTypedChild} from '@/data/typedRecords.js'
import {bindBlockActionContext, type BlockAction} from '@/shortcuts/blockActions.js'
import {ActionContextTypes} from '@/shortcuts/types.js'
import {HTML_DOCUMENT_TYPE} from './blockType.ts'
import exampleSource from './example.html?raw'

const insertExampleHtmlDocument: BlockAction = {
  id: 'html-document.insert-example',
  description: 'Insert example HTML document',
  handler: async ({block, uiStateBlock, renderScopeId}) => {
    const repo = block.repo
    if (repo.isReadOnly) return
    const typeSnapshot = repo.snapshotTypeRegistries()
    const id = await repo.tx(
      tx => createTypedChild(repo, tx, {
        parentId: block.id,
        content: exampleSource,
        types: [HTML_DOCUMENT_TYPE],
        typeSnapshot,
      }),
      {scope: ChangeScope.BlockDefault, description: 'insert example HTML document'},
    )
    await focusBlock(uiStateBlock, id, {renderScopeId})
  },
}

/** Both contexts: normal mode exists only with vim mode on, which is opt-in. */
export const htmlDocumentActions = [
  bindBlockActionContext(ActionContextTypes.NORMAL_MODE, insertExampleHtmlDocument),
  bindBlockActionContext(ActionContextTypes.EDIT_MODE_CM, insertExampleHtmlDocument, {idPrefix: 'edit.cm'}),
]
