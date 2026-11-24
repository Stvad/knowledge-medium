import {ChangeScope} from '@/data/api'
import {keysBetween} from '@/data/orderKey'
import {navigateInPanel} from '@/utils/panelHistory'
import {captureAnchor} from '../anchor'
import {annotationMarginOpenProp} from '../marginSchema'
import {createThread} from '../threads'

const TOPIC = 'Synthetic outline for comments'
const ROW_COUNT = 72

export async function seedMarginFixture() {
  const repo = window.__omniliner?.repo
  const workspaceId = repo?.activeWorkspaceId
  const panelId = document.querySelector<HTMLElement>('[data-panel-active="true"]')?.dataset.panelId
  if (!repo || !workspaceId || !panelId) throw new Error('The local workspace has no active panel')

  const keys = keysBetween(null, null, ROW_COUNT)
  const rows = await repo.tx(async tx => {
    const outline = await tx.create({workspaceId, parentId: null, orderKey: 'a0', content: TOPIC})
    const rows = []
    for (const [index, orderKey] of keys.entries()) {
      const content = `Outline row ${index + 1} with alpha, beta, and gamma.`
      const id = await tx.create({workspaceId, parentId: outline, orderKey, content})
      rows.push({id, content})
    }
    return {outline, rows}
  }, {scope: ChangeScope.BlockDefault})

  const threadAt = async (index: number, comment: string, quote?: string) => {
    const {id, content} = rows.rows[index]
    const start = quote ? content.indexOf(quote) : -1
    const anchor = quote ? captureAnchor(content, start, start + quote.length) : null
    const {threadId} = await createThread(repo, {targetId: id, anchor, comment})
    return {threadId, targetId: id}
  }

  const first = await threadAt(3, 'First card in a dense group.')
  const displaced = await threadAt(3, 'Second card in a dense group.', 'alpha')
  await threadAt(3, 'Third card in a dense group.', 'beta')
  await threadAt(4, 'Comment on the next outline row.')
  const tall = await threadAt(11, Array.from({length: 48}, (_, line) =>
    `Review paragraph ${line + 1}. The sample outline explains the sequence and gives each decision context.`
  ).join('\n\n'))
  const reveal = await threadAt(16, 'Comment following the long discussion.')
  const sparse = await threadAt(60, 'Comment after a run of unannotated outline rows.')
  await threadAt(ROW_COUNT - 1, 'First discussion on the last row.')
  await threadAt(ROW_COUNT - 1, 'Second discussion on the last row.', 'alpha')
  const last = await threadAt(ROW_COUNT - 1, 'Last discussion on the last row.', 'beta')

  const panel = repo.block(panelId)
  await navigateInPanel(panel, rows.outline)
  await panel.set(annotationMarginOpenProp, true)
  return {first, displaced, tall, reveal, sparse, last}
}
