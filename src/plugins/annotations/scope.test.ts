// @vitest-environment node
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {isReadOnlySql} from '@knowledge-medium/agent-cli/protocol'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE, USER_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {backlinksDataExtension} from '@/plugins/backlinks/dataExtension.js'
import {contributorsDataExtension} from '@/plugins/contributors/dataExtension.js'
import {createContributor} from '@/plugins/contributors/profiles.js'
import {referencesDataExtension} from '@/plugins/references/dataExtension.js'
import {captureAnchor} from './anchor'
import {annotationsDataExtension} from './dataExtension'
import {COMMENTS_RECIPE_QUIET_MS, COMMENTS_RECIPE_SQL, threadIdsInScope} from './scope'
import {annotationTargetProp} from './schema'
import {createThread, setThreadStatus} from './threads'

const WS = 'ws'
const CLAUDE = '3f2a9c1d-0000-4000-8000-0000000000c1'
const SCOPE = '3f2a9c1d-0000-4000-8000-0000000000a1'
const OTHER = '3f2a9c1d-0000-4000-8000-0000000000a2'
const BLOCK = '3f2a9c1d-0000-4000-8000-0000000000b1'
const NESTED = '3f2a9c1d-0000-4000-8000-0000000000b2'
const AWAY = '3f2a9c1d-0000-4000-8000-0000000000b3'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

/** The page under review (`scope`), a block on it, a nested block, and a
 *  block on another page; threads on each, and one anchored to a comment. */
let ids: {
  nested: string
  onBlock: string
  onNested: string
  onComment: string
  resolved: string
  elsewhere: string
  comment: string
  reply: string
  commentOnComment: string
}

const page = (tx: Parameters<Parameters<Repo['tx']>[0]>[0], id: string, title: string, orderKey: string) =>
  tx.create({id, workspaceId: WS, parentId: null, orderKey, content: title,
    properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: [title]}})

beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({
    db: db.db,
    user: {id: 'alex', name: 'Alex'},
    extensions: [referencesDataExtension, backlinksDataExtension, contributorsDataExtension, annotationsDataExtension],
    // Wall-clock stamps: the recipe compares edit times with SQLite's now.
    appGenerators: true,
  }).repo
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async tx => {
    await page(tx, CLAUDE, 'claude', 'a0')
    await page(tx, SCOPE, 'Review', 'a1')
    await page(tx, OTHER, 'Other', 'a2')
    await tx.create({id: BLOCK, workspaceId: WS, parentId: SCOPE, orderKey: 'a0', content: 'Ship it Thursday'})
    await tx.create({id: NESTED, workspaceId: WS, parentId: BLOCK, orderKey: 'a0', content: 'Vendor confirms'})
    await tx.create({id: AWAY, workspaceId: WS, parentId: OTHER, orderKey: 'a0', content: 'Unrelated'})
  }, opts)
  await repo.awaitProcessors()

  const quote = (content: string, text: string) => {
    const from = content.indexOf(text)
    return captureAnchor(content, from, from + text.length)
  }
  const onBlock = await createThread(repo, {targetId: BLOCK, anchor: quote('Ship it Thursday', 'Thursday'), comment: 'Is it confirmed?'})
  const reply = await repo.mutate.createChild({parentId: onBlock.commentId!, content: 'Not yet'})
  const onNested = await createThread(repo, {targetId: NESTED, anchor: null})
  const onComment = await createThread(repo, {targetId: onBlock.commentId!, anchor: null, comment: 'About this question'})
  const resolved = await createThread(repo, {targetId: BLOCK, anchor: null, comment: 'Old point'})
  await setThreadStatus(repo, resolved.threadId, 'resolved')
  const elsewhere = await createThread(repo, {targetId: AWAY, anchor: null, comment: 'Not in scope'})
  await repo.awaitProcessors()
  ids = {
    nested: NESTED,
    onBlock: onBlock.threadId,
    onNested: onNested.threadId,
    onComment: onComment.threadId,
    resolved: resolved.threadId,
    elsewhere: elsewhere.threadId,
    comment: onBlock.commentId!,
    reply,
    commentOnComment: onComment.commentId!,
  }
})

/** Moves every row's edit time back past the recipe's quiet period. */
const goQuiet = () => db.db.execute(
  'UPDATE blocks SET updated_at = updated_at - ?, user_updated_at = user_updated_at - ?',
  [COMMENTS_RECIPE_QUIET_MS + 1_000, COMMENTS_RECIPE_QUIET_MS + 1_000],
)

const recipe = async (mentionTargets: string[] = [CLAUDE]): Promise<string[]> =>
  (await db.db.getAll<{id: string}>(COMMENTS_RECIPE_SQL, [SCOPE, JSON.stringify(mentionTargets)]))
    .map(row => row.id).sort()

describe('threadIdsInScope', () => {
  it('covers threads on blocks under the scope, and threads on their comments', async () => {
    expect((await threadIdsInScope(repo, SCOPE)).sort()).toEqual(
      [ids.onBlock, ids.onNested, ids.onComment, ids.resolved].sort(),
    )
  })

  it('takes only thread roots for threads, not any block holding a target ref', async () => {
    const stray = await repo.mutate.createChild({parentId: OTHER, content: 'Points at the block'})
    await repo.tx(tx => tx.setProperty(stray, annotationTargetProp, BLOCK), opts)
    await repo.awaitProcessors()
    expect(await threadIdsInScope(repo, SCOPE)).not.toContain(stray)
  })

  it('stops at the scope', async () => {
    expect(await threadIdsInScope(repo, ids.nested)).toEqual([ids.onNested])
    expect(await threadIdsInScope(repo, OTHER)).toEqual([ids.elsewhere])
  })

  it('leaves out a deleted thread, and answers nothing for a deleted scope', async () => {
    await repo.tx(tx => tx.delete(ids.onBlock), opts)
    // The thread on its comment went with it: its target is no longer covered.
    expect((await threadIdsInScope(repo, SCOPE)).sort()).toEqual([ids.onNested, ids.resolved].sort())
    await repo.tx(tx => tx.delete(SCOPE), opts)
    expect(await threadIdsInScope(repo, SCOPE)).toEqual([])
  })
})

describe('a thread root moved by hand under another thread\'s comment', () => {
  it('keeps its comments to its own thread, and is no comment of the other', async () => {
    const moved = await createThread(repo, {targetId: NESTED, anchor: null, comment: 'On the nested block'})
    await repo.tx(tx => tx.move(moved.threadId, {parentId: ids.comment, orderKey: 'z0'}), opts)
    await goQuiet()

    const rows = await db.db.getAll<{id: string; thread_id: string}>(COMMENTS_RECIPE_SQL, [SCOPE, JSON.stringify([])])
    expect(rows.filter(row => row.id === moved.commentId)).toEqual([{id: moved.commentId, thread_id: moved.threadId, content: 'On the nested block'}])
    expect(rows.map(row => row.id)).not.toContain(moved.threadId)
  })
})

describe('the comments recipe', () => {
  it('is SQL a query watcher accepts', () => {
    expect(isReadOnlySql(COMMENTS_RECIPE_SQL)).toBe(true)
  })

  it('selects the quiet comments of open threads in the scope, at any depth', async () => {
    await goQuiet()
    expect(await recipe()).toEqual([ids.comment, ids.reply, ids.commentOnComment].sort())
  })

  it('waits for a comment to go quiet, then selects it with its finished text', async () => {
    await goQuiet()
    const late = await repo.mutate.createChild({parentId: ids.reply, content: 'Typing'})
    expect(await recipe()).not.toContain(late)
    await repo.tx(tx => tx.update(late, {content: 'Typing done'}), opts)
    await goQuiet()
    const rows = await db.db.getAll<{id: string; content: string}>(COMMENTS_RECIPE_SQL, [SCOPE, JSON.stringify([CLAUDE])])
    expect(rows.find(row => row.id === late)?.content).toBe('Typing done')
  })

  it('takes a user page as a human author, whatever its stored kind', async () => {
    // A user page whose kind reads agent is still human (contributorKindOf).
    const person = await repo.mutate.createChild({parentId: OTHER, content: 'Alex'})
    await repo.tx(tx => tx.update(person, {properties: {[typesProp.name]: [USER_TYPE], 'contributor:kind': 'agent'}}), opts)
    await db.db.execute(
      `UPDATE blocks SET properties_json = json_set(properties_json, '$."attribution:creators"', json(?)) WHERE id = ?`,
      [JSON.stringify([person]), ids.reply],
    )
    await goQuiet()
    expect(await recipe()).toContain(ids.reply)
  })

  it('leaves out empty comments, comments that mention a dispatch target, and agent-authored comments', async () => {
    const empty = await repo.mutate.createChild({parentId: ids.reply, content: '  '})
    const blankLine = await repo.mutate.createChild({parentId: ids.reply, content: '\n\t'})
    const mention = await repo.mutate.createChild({parentId: ids.reply, content: '[[claude]] can you check?'})
    const agent = await createContributor(repo, WS, {name: 'Bot', kind: 'automation'})
    const agentReply = await repo.withTxContext({contributorId: agent.id, contributorSource: 'agent'})
      .mutate.createChild({parentId: ids.reply, content: 'An automated reply'})
    await repo.awaitProcessors()
    await goQuiet()

    const selected = await recipe()
    expect(selected).toEqual([ids.comment, ids.reply, ids.commentOnComment].sort())
    // Each exclusion is its own clause: the mention one keys on the page passed.
    expect(await recipe([])).toContain(mention)
    expect(selected).not.toContain(empty)
    expect(selected).not.toContain(blankLine)
    expect(selected).not.toContain(agentReply)
  })
})

describe('on a workspace that stores properties as child blocks', () => {
  it('never takes a thread root\'s field rows for comments', async () => {
    await resetTestDb(db.db)
    await db.db.execute(`INSERT INTO workspaces
      (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
      VALUES (?, 'Test', 'alex', 1, 1, 'none', NULL, 'children')`, [WS])
    repo = createTestRepo({
      db: db.db,
      user: {id: 'alex', name: 'Alex'},
      extensions: [referencesDataExtension, backlinksDataExtension, contributorsDataExtension, annotationsDataExtension],
      appGenerators: true,
    }).repo
    repo.setActiveWorkspaceId(WS)
    await repo.tx(async tx => {
      await page(tx, SCOPE, 'Review', 'a1')
      await tx.create({id: BLOCK, workspaceId: WS, parentId: SCOPE, orderKey: 'a0', content: 'Ship it Thursday'})
    }, opts)
    const thread = await createThread(repo, {targetId: BLOCK, anchor: null, comment: 'Is it confirmed?'})
    await repo.awaitProcessors()
    // The precondition: the root does hold field rows here.
    const fieldRows = await db.db.getAll<{id: string}>(
      'SELECT id FROM blocks WHERE parent_id = ? AND is_field_form = 1 AND deleted = 0', [thread.threadId])
    expect(fieldRows.length).toBeGreaterThan(0)
    await goQuiet()

    expect(await threadIdsInScope(repo, SCOPE)).toEqual([thread.threadId])
    expect(await recipe([])).toEqual([thread.commentId])
  })
})
