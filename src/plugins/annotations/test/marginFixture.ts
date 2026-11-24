import {ChangeScope} from '@/data/api'
import {keysBetween} from '@/data/orderKey'
import {navigateInPanel} from '@/utils/panelHistory'
import {captureAnchor} from '../anchor'
import {annotationMarginOpenProp} from '../marginSchema'
import {createThread, setThreadStatus} from '../threads'

const TOPIC = 'Synthetic outline for comments'
const ROW_COUNT = 72
const DEEP_REPLY_TEXT = 'This nested reply finishes the closed discussion.'

declare global {
  interface Window {
    marginFixtureChildList: {requested: boolean; release: () => void; firstPlacedText?: string}
  }
}

export const holdChildList = (id: string) => {
  const repo = window.__omniliner?.repo
  if (!repo) throw new Error('The local workspace has no repository')
  const list = repo.query.childIds({id, hydrate: true, propertyChildren: 'none'})
  if (list.status() !== 'idle') throw new Error('The delayed child list must start cold')
  const load = list.load
  let release = () => {}
  const blocked = new Promise<void>(resolve => { release = resolve })
  const gate = {
    requested: false,
    release: () => {
      list.load = load
      release()
    },
  }
  window.marginFixtureChildList = gate
  list.load = async () => {
    gate.requested = true
    await blocked
    return load.call(list)
  }
}

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
    const {threadId, commentId} = await createThread(repo, {targetId: id, anchor, comment})
    return {threadId, targetId: id, commentId}
  }

  const first = await threadAt(3, 'First card in a dense group.')
  const displaced = await threadAt(3, 'Second card in a dense group.', 'alpha')
  await threadAt(3, 'Third card in a dense group.', 'beta')
  const closed = await threadAt(3, 'A closed discussion on the same source.', 'gamma')
  const reply = await repo.mutate.createChild({parentId: closed.commentId!, content: 'Reply to the closed discussion.'})
  await repo.mutate.createChild({parentId: reply, content: DEEP_REPLY_TEXT})
  await setThreadStatus(repo, closed.threadId, 'resolved')
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
  return {first, displaced, closed: {...closed, reply, deepReplyText: DEEP_REPLY_TEXT}, tall, reveal, sparse, last, rowCount: ROW_COUNT}
}
