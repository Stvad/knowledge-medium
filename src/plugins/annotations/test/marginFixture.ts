import {ChangeScope} from '@/data/api'
import {keysBetween} from '@/data/orderKey'
import {topLevelBlockIdProp} from '@/data/properties'
import {buildLayout} from '@/utils/routing'
import {captureAnchor} from '../anchor'
import {annotationMarginOpenProp} from '../marginSchema'
import {createThread, setThreadStatus} from '../threads'

const TOPIC = 'Synthetic outline for comments'
const ROW_COUNT = 72
const COMMENT_GROUP_ROW = 3
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

export async function createMarginFixtureOutline() {
  const repo = window.__omniliner?.repo
  const workspaceId = repo?.activeWorkspaceId
  if (!repo || !workspaceId) throw new Error('The local workspace has no repository')

  const keys = keysBetween(null, null, ROW_COUNT)
  const {outlineId, rows} = await repo.tx(async tx => {
    const outlineId = await tx.create({workspaceId, parentId: null, orderKey: 'a0', content: TOPIC})
    const children = keys.map((orderKey, index) => ({
      workspaceId, parentId: outlineId, orderKey,
      content: `Outline row ${index + 1} with alpha, beta, and gamma.`,
    }))
    const ids = await tx.createMany(children)
    return {outlineId, rows: ids.map((id, index) => ({id, content: children[index].content}))}
  }, {scope: ChangeScope.BlockDefault, description: 'seed comments margin outline'})
  return {outlineId, hash: buildLayout(workspaceId, [outlineId]), rows, firstSource: rows[COMMENT_GROUP_ROW]}
}

export async function seedMarginFixture({outlineId, rows}: Awaited<ReturnType<typeof createMarginFixtureOutline>>) {
  const repo = window.__omniliner?.repo
  const panelId = document.querySelector<HTMLElement>('[data-panel-active="true"]')?.dataset.panelId
  if (!repo || !panelId) throw new Error('The local workspace has no active panel')
  const panel = repo.block(panelId)
  if (panel.peekProperty(topLevelBlockIdProp) !== outlineId) throw new Error('The active panel did not open the fixture outline')

  const threadAt = async (index: number, comment: string, quote?: string) => {
    const {id, content} = rows[index]
    const start = quote ? content.indexOf(quote) : -1
    const anchor = quote ? captureAnchor(content, start, start + quote.length) : null
    const {threadId, commentId} = await createThread(repo, {targetId: id, anchor, comment}).catch(cause => {
      throw new Error(`Could not attach a fixture comment to outline row ${index + 1}. ${String(cause)}`, {cause})
    })
    return {threadId, targetId: id, commentId}
  }

  const first = await threadAt(COMMENT_GROUP_ROW, 'First card in a dense group.')
  const displaced = await threadAt(COMMENT_GROUP_ROW, 'Second card in a dense group.', 'alpha')
  await threadAt(COMMENT_GROUP_ROW, 'Third card in a dense group.', 'beta')
  const closed = await threadAt(COMMENT_GROUP_ROW, 'A closed discussion on the same source.', 'gamma')
  const reply = await repo.mutate.createChild({parentId: closed.commentId!, content: 'Reply to the closed discussion.'})
  await repo.mutate.createChild({parentId: reply, content: DEEP_REPLY_TEXT})
  await setThreadStatus(repo, closed.threadId, 'resolved')
  await threadAt(COMMENT_GROUP_ROW + 1, 'Comment on the next outline row.')
  const tall = await threadAt(11, Array.from({length: 48}, (_, line) =>
    `Review paragraph ${line + 1}. The sample outline explains the sequence and gives each decision context.`
  ).join('\n\n'))
  const reveal = await threadAt(16, 'Comment following the long discussion.')
  const sparse = await threadAt(60, 'Comment after a run of unannotated outline rows.')
  await threadAt(ROW_COUNT - 1, 'First discussion on the last row.')
  await threadAt(ROW_COUNT - 1, 'Second discussion on the last row.', 'alpha')
  const last = await threadAt(ROW_COUNT - 1, 'Last discussion on the last row.', 'beta')

  await panel.set(annotationMarginOpenProp, true)
  return {first, displaced, closed: {...closed, reply, deepReplyText: DEEP_REPLY_TEXT}, tall, reveal, sparse, last, rowCount: ROW_COUNT}
}
