// @vitest-environment happy-dom
/* The daemon's two graph handles against the app itself: the real engine and
 * graph modules, over a bridge client that hands each wire command to the
 * runtime's own `executeCommand`, with the contributors processor installed. */
import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest'
import {withContributorId} from '@knowledge-medium/agent-cli/client'
import {ChangeScope} from '@/data/api'
import {PAGE_TYPE} from '@/data/blockTypes'
import {aliasesProp, typesProp} from '@/data/properties'
import type {Repo} from '@/data/repo'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import {staticDataExtensions} from '@/extensions/staticDataExtensions'
import {agentDispatchCompanionDataExtension} from '@/plugins/agent-dispatch-companion/dataExtension'
import {agentProtocolSeeds, agentActivityAtProp} from '@/plugins/agent-dispatch-companion/schema'
import {definitionSeedsFacet} from '@/data/facets'
import {createTestAgentContext} from '@/plugins/agent-runtime/test/createTestAgentContext'
import type {AgentRuntimeContext} from '@/plugins/agent-runtime/protocol'
import {attributionCreatorsProp, attributionEditorsProp} from '@/plugins/contributors/schema'
import {parseConfig, PROPS} from '../src/config'
import {createInProcessBridgeClient} from '../../../scripts/agent-eval/inProcessBridgeClient'
import {createEngine} from '../src/engine'
import {createGraph, createReplyWriter} from '../src/graph'
import type {AgentRunOptions, AgentRunResult} from '../src/runner'
import type {StateStore} from '../src/state'

const WS = 'ws'
const CLAUDE = '3f2a9c1d-0000-4000-8000-0000000000c1'
const MENTION = '3f2a9c1d-0000-4000-8000-0000000000d1'
const opts = {scope: ChangeScope.BlockDefault}

let db: TestDb
let repo: Repo
let context: AgentRuntimeContext
let agentId: string
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.cleanup() })

const inProcessClient = () => createInProcessBridgeClient(context)

beforeEach(async () => {
  await resetTestDb(db.db)
  repo = createTestRepo({db: db.db, user: {id: 'vlad', name: 'Vlad'}}).repo
  context = createTestAgentContext(repo, WS, staticDataExtensions)
  // The person's note, written in the tab: a human-only write records no
  // attribution.
  await repo.tx(async tx => {
    await tx.create({id: CLAUDE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'claude',
      properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['claude']}})
    await tx.create({id: 'page', workspaceId: WS, parentId: null, orderKey: 'a1', content: 'Notes',
      properties: {[typesProp.name]: [PAGE_TYPE]}})
    await tx.create({id: MENTION, workspaceId: WS, parentId: 'page', orderKey: 'a0', content: '[[claude]] summarize this'})
  }, opts)
  await repo.awaitProcessors()
  const agent = await inProcessClient().runCommand({type: 'create-contributor', name: 'Claude agent'}) as {id: string}
  agentId = agent.id
})

const memoryState = (): StateStore => ({
  getCursor: async () => null,
  setCursor: async () => {},
  getBaseline: async () => 0,
  setBaseline: async () => {},
  getLaunchTimes: async () => [],
  setLaunchTimes: async () => {},
})

/** The daemon's wiring: one client carrying the agent's contributor. */
const engineFor = (runTask: (options: AgentRunOptions) => Promise<AgentRunResult>, target = 'claude') => {
  const client = withContributorId(inProcessClient(), agentId)
  return createEngine({
    config: parseConfig({
      workspaceId: WS,
      watchers: [{kind: 'backlinks', name: 'mentions', target, settleMs: 0, streamReply: true}],
    }),
    graph: createGraph(client),
    replies: createReplyWriter(client),
    state: memoryState(),
    runTask,
    deliverToChannel: async () => {},
    mcpConfigPath: null,
    log: () => {},
    delay: async () => {},
  })
}

const attributionOf = async (id: string) => {
  const row = await repo.load(id)
  return {
    creators: row?.properties[attributionCreatorsProp.name] ?? [],
    editors: row?.properties[attributionEditorsProp.name] ?? [],
  }
}

/** A person's property write to the mention, as the Stop chip makes it. */
const writeInTab = (properties: Record<string, unknown>) => repo.tx(async tx => {
  const row = await tx.get(MENTION)
  await tx.update(MENTION, {properties: {...row!.properties, ...properties}})
}, opts)

const replyIds = async (): Promise<string[]> => {
  const rows = await db.db.getAll<{id: string}>(
    `SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 AND json_extract(properties_json, '$."${PROPS.reply}"') = 1`,
    [MENTION],
  )
  return rows.map(row => row.id)
}

const result = (overrides: Partial<AgentRunResult>): AgentRunResult => ({
  ok: true, resultText: '', sessionId: 'sess-1', exitCode: 0, timedOut: false, stderr: '', raw: {}, usage: null, ...overrides,
})

describe('dispatch attribution', () => {
  it('accepts activity writes when the app has no activity timestamp seed', async () => {
    context = createTestAgentContext(repo, WS, [
      staticDataExtensions.filter(extension => extension !== agentDispatchCompanionDataExtension),
      agentProtocolSeeds.filter(seed => seed !== agentActivityAtProp).map(seed => definitionSeedsFacet.of(seed)),
    ])
    expect(repo.propertySchemas.get(PROPS.activityAt)).toBeUndefined()
    const graph = createGraph(inProcessClient())
    await graph.setActivity(MENTION, 'km: comments', 123_000)
    const row = await repo.load(MENTION)
    expect(row?.properties).toMatchObject({[PROPS.activity]: 'km: comments', [PROPS.activityAt]: 123_000})
    await graph.setTaskProps(MENTION, {status: 'done', activity: null, nowMs: 124_000})
    expect((await repo.load(MENTION))?.properties).toMatchObject({
      [PROPS.status]: 'done', [PROPS.activity]: '', [PROPS.activityAt]: 0,
    })
  })

  it('leaves the mentioning block\'s authors untouched through a whole run, and attributes the reply', async () => {
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
    const engine = engineFor(async options => {
      options.onEvent?.({kind: 'session', sessionId: 'sess-1'})
      options.onEvent?.({kind: 'activity', label: 'Reading the page', stepId: 'read-page'})
      options.onEvent?.({kind: 'text', text: 'Half an answer'})
      // The progress writes land while the run is live, not only at its end.
      await vi.waitFor(async () => expect((await repo.load(MENTION))?.properties)
        .toMatchObject({[PROPS.activity]: 'Reading the page', [PROPS.session]: 'sess-1'}))
      return result({resultText: 'The summary.'})
    })

    await engine.tick()
    await engine.drain()

    const mention = await repo.load(MENTION)
    expect(mention?.properties).toMatchObject({[PROPS.status]: 'done', [PROPS.session]: 'sess-1', [PROPS.activity]: ''})
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
    const replies = await replyIds()
    expect(replies).toHaveLength(1)
    // Streaming edits the reply after creating it, so the agent is also its editor.
    expect((await attributionOf(replies[0])).creators).toEqual([agentId])
  })

  it('leaves a person\'s note under a reply untouched when the reply drops the node it sits under', async () => {
    const replies = createReplyWriter(withContributorId(inProcessClient(), agentId))
    await replies.reconcileReplyTree(MENTION, '- first\n- second', {replyKey: 'k', shape: 'outline'})
    const second = (await repo.query['core.childIds']({id: MENTION}).load()).at(-1)!
    const note = await repo.mutate.createChild({parentId: second, content: 'My note on this'})
    await replies.reconcileReplyTree(MENTION, 'All in one', {replyKey: 'k', shape: 'block', final: true})

    expect((await repo.load(note))?.parentId).toBe(MENTION)
    expect(await attributionOf(note)).toEqual({creators: [], editors: []})
  })

  it('leaves them untouched through a cancelled run', async () => {
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const engine = engineFor(options => new Promise(resolve => {
      started()
      options.signal?.addEventListener('abort', () => resolve(result({ok: false, exitCode: null})))
    }))

    await engine.tick()
    await running
    // The Stop chip's write, made in the tab.
    await writeInTab({[PROPS.cancel]: 'requested'})
    await engine.tick()
    await engine.drain()

    const mention = await repo.load(MENTION)
    expect(mention?.properties).toMatchObject({[PROPS.status]: 'error', [PROPS.error]: 'cancelled', [PROPS.cancel]: ''})
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
  })

  it('leaves them untouched when clearing a cancel no run owns', async () => {
    await writeInTab({[PROPS.status]: 'running', [PROPS.cancel]: 'requested'})
    const runTask = vi.fn(async () => result({}))

    await engineFor(runTask).tick()

    expect((await repo.load(MENTION))?.properties[PROPS.cancel]).toBe('')
    expect(runTask).not.toHaveBeenCalled()
    expect(await attributionOf(MENTION)).toEqual({creators: [], editors: []})
  })
})

describe('a child-backed workspace', () => {
  it('does not take the agent\'s own reply attribution, stored as property value blocks, for a mention', async () => {
    await db.db.execute(
      `INSERT OR REPLACE INTO workspaces (id, name, owner_user_id, create_time, update_time,
         encryption_mode, wk_canary, properties_migration)
       VALUES (?, 'ws', 'vlad', 1, 1, 'none', NULL, 'children')`, [WS])
    // The watcher watches the agent's own contributor page, so every block the
    // agent writes is attributed to the page it watches.
    await repo.tx(async tx => {
      await tx.update(MENTION, {content: `((${agentId})) summarize this`})
    }, opts)
    await repo.awaitProcessors()
    const runTask = vi.fn(async () => result({resultText: 'The summary.'}))
    const engine = engineFor(runTask, 'Claude agent')
    await engine.tick()
    await engine.drain()
    await repo.awaitProcessors()
    // The scenario reached the shape under test: the reply's attribution
    // value block links the agent's contributor page as plain content.
    const [reply] = await replyIds()
    const valueLinks = await db.db.getAll<{id: string}>(
      `SELECT v.id FROM blocks f JOIN blocks v ON v.parent_id = f.id
         JOIN block_references r ON r.source_id = v.id AND r.target_id = ? AND r.source_field = ''
        WHERE f.parent_id = ? AND f.is_field_form = 1 AND v.deleted = 0`, [agentId, reply])
    expect(valueLinks.length).toBeGreaterThan(0)

    await engine.tick()
    await engine.drain()

    expect(runTask).toHaveBeenCalledOnce()
  })

  it('counts as a property value only an unmarked child of a field row that has an owner', async () => {
    // Raw rows, so no processor re-derives the marks under test.
    await db.db.writeTransaction(async tx => {
      for (const [id, parentId, isFieldForm] of [
        ['field', 'page', 1], ['value', 'field', null], ['nested-field', 'field', 1],
        ['root-marked', null, 1], ['under-root-marked', 'root-marked', null], ['note-under-value', 'value', null],
      ] as const) {
        await tx.execute(
          `INSERT INTO blocks (id, workspace_id, parent_id, order_key, content, properties_json, references_json,
             created_at, updated_at, created_by, updated_by, deleted, reference_target_id, is_field_form)
           VALUES (?, ?, ?, ?, '', '{}', '[]', 1, 1, 'vlad', 'vlad', 0, ?, ?)`,
          [id, WS, parentId, `z-${id}`, CLAUDE, isFieldForm])
      }
    })

    const found = await createGraph(inProcessClient()).propertyValueBlocks(
      ['value', 'nested-field', 'under-root-marked', 'note-under-value', 'field', MENTION])

    expect([...found]).toEqual(['value'])
  })
})

describe('watcher memory against the app', () => {
  const memoryBlocks = () => db.db.getAll<{id: string, content: string}>(
    'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0', [CLAUDE])

  const replyText = async () => (await db.db.getAll<{content: string}>(
    `SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 AND json_extract(properties_json, '$."${PROPS.reply}"') = 1 ORDER BY order_key`,
    [MENTION],
  )).map(row => row.content).join('\n')

  /** One tick of a fresh engine whose run does `run`; the prompts it was given. */
  const runOnce = async (run: (prompt: string) => Promise<void> = async () => {}) => {
    const prompts: string[] = []
    const engine = engineFor(async options => {
      prompts.push(options.prompt)
      await run(options.prompt)
      return result({resultText: 'Done.'})
    })
    await engine.tick()
    await engine.drain()
    return prompts
  }

  it('creates the memory block under the watched page once, off the undo stack and unattributed, and shows the run its entries', async () => {
    repo.undoManager.clear()
    const prompts: string[] = []
    const run = async (options: AgentRunOptions) => {
      prompts.push(options.prompt)
      return result({resultText: 'Done.'})
    }
    const engine = engineFor(run)
    await engine.tick()
    await engine.drain()

    const [memory] = await memoryBlocks()
    expect(memory?.content).toBe('Memory')
    expect(await attributionOf(memory.id)).toEqual({creators: [], editors: []})
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(0)

    // The run's own write, as the km tools make it.
    await inProcessClient().runCommand({
      type: 'append-markdown', target: memory.id, markdown: '- Replies short.\n  - Keep technical details in linked notes.',
    })
    const [noteId] = await repo.query['core.childIds']({id: memory.id}).load()
    await writeInTab({[PROPS.status]: '', [PROPS.attempts]: 0})
    await repo.tx(async tx => { await tx.update(MENTION, {content: '[[claude]] summarize this again'}) }, opts)
    await engine.tick()
    await engine.drain()

    expect(await memoryBlocks()).toHaveLength(1)
    expect(prompts.at(-1)).toContain(`Replies short. (+1 child) ^${noteId}`)
    expect(prompts.at(-1)).not.toContain('Keep technical details in linked notes.')
    expect(prompts.at(-1)).toContain(`append_markdown with target ${memory.id}`)
  })

  it('uses a Memory block the person made under the watched page', async () => {
    const mine = await repo.mutate.createChild({parentId: CLAUDE, content: 'memory'})
    const prompts = await runOnce()

    expect((await memoryBlocks()).map(row => row.id)).toEqual([mine])
    expect(prompts[0]).toContain(`append_markdown with target ${mine}`)
  })

  it('keeps a title the person gave the memory block, and the block', async () => {
    const prompts: string[] = []
    const engine = engineFor(async options => {
      prompts.push(options.prompt)
      return result({resultText: 'Done.'})
    })
    await engine.tick()
    await engine.drain()
    const [memory] = await memoryBlocks()
    await repo.tx(async tx => { await tx.update(memory.id, {content: 'Memory for claude (keep)'}) }, opts)
    await writeInTab({[PROPS.status]: '', [PROPS.attempts]: 0})
    await repo.tx(async tx => { await tx.update(MENTION, {content: '[[claude]] summarize this again'}) }, opts)
    await engine.tick()
    await engine.drain()

    expect(await memoryBlocks()).toEqual([{id: memory.id, content: 'Memory for claude (keep)'}])
    expect(prompts.at(-1)).toContain(`append_markdown with target ${memory.id}`)
  })

  it('reports a note a run nests under another', async () => {
    let entryId = ''
    const engine = engineFor(async options => {
      const memoryId = /append_markdown with target (\S+)\./.exec(options.prompt)![1]
      if (!entryId) {
        await inProcessClient().runCommand({type: 'append-markdown', target: memoryId, markdown: 'Replies short.'})
        entryId = (await repo.query['core.childIds']({id: memoryId}).load())[0]
      } else {
        await inProcessClient().runCommand({type: 'append-markdown', target: entryId, markdown: 'Unless asked for detail.'})
      }
      return result({resultText: 'Done.'})
    })
    await engine.tick()
    await engine.drain()
    await writeInTab({[PROPS.status]: '', [PROPS.attempts]: 0})
    await repo.tx(async tx => { await tx.update(MENTION, {content: '[[claude]] summarize this again'}) }, opts)
    await engine.tick()
    await engine.drain()

    const replies = await db.db.getAll<{content: string}>(
      'SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0', [MENTION])
    expect(replies.map(row => row.content).join('\n')).toContain('saved [Unless asked for detail.]')
  })

  it('says in the reply what a run saved to its memory', async () => {
    await runOnce(async prompt => {
      const memoryId = /append_markdown with target (\S+)\./.exec(prompt)![1]
      await withContributorId(inProcessClient(), agentId).runCommand({type: 'append-markdown', target: memoryId, markdown: 'Prefers suggestions.'})
    })

    expect(await replyText()).toMatch(/Memory changed during this run: saved \[Prefers suggestions\.\]\(\(\([0-9a-f-]+\)\)\)/)
  })

  describe('shared notes it embeds', () => {
    const SHARED_PAGE = '3f2a9c1d-0000-4000-8000-0000000000e1'
    const SHARED = '3f2a9c1d-0000-4000-8000-0000000000e2'
    const SHARED_CHILD = '3f2a9c1d-0000-4000-8000-0000000000e3'
    const FOREIGN = '3f2a9c1d-0000-4000-8000-0000000000f1'
    const FOREIGN_CHILD = '3f2a9c1d-0000-4000-8000-0000000000f2'
    const FOREIGN_NOTE = '3f2a9c1d-0000-4000-8000-0000000000f3'
    const OWN_DEEP = '3f2a9c1d-0000-4000-8000-0000000000a1'

    /** A `Shared` page with a note and a sub-note, and the watcher's memory
     *  holding one note per given content. */
    const seedMemory = async (...notes: string[]): Promise<string> => {
      await repo.tx(async tx => {
        await tx.create({id: SHARED_PAGE, workspaceId: WS, parentId: null, orderKey: 'a2', content: 'Shared',
          properties: {[typesProp.name]: [PAGE_TYPE], [aliasesProp.name]: ['Shared']}})
        await tx.create({id: SHARED, workspaceId: WS, parentId: SHARED_PAGE, orderKey: 'a0', content: 'Cite sources.'})
        await tx.create({id: SHARED_CHILD, workspaceId: WS, parentId: SHARED, orderKey: 'a0', content: 'As links.'})
      }, opts)
      const memoryId = await repo.mutate.createChild({parentId: CLAUDE, content: 'Memory'})
      for (const note of notes) await repo.mutate.createChild({parentId: memoryId, content: note})
      await repo.awaitProcessors()
      return memoryId
    }

    const edit = (id: string, content: string) => inProcessClient().runCommand({type: 'update-block', id, content})

    it.each([
      ['a block embed', `!((${SHARED}))`],
      ['a page embed', '![[Shared]]'],
    ])('shows a shared note summary from %s and reports an edit to its hidden detail', async (_, embed) => {
      await seedMemory(embed)
      const prompts = await runOnce(async () => {
        await edit(SHARED_CHILD, 'As links, never bare URLs.')
      })

      expect(prompts[0]).toContain(`[shared] Cite sources. (+1 child) ^${SHARED}`)
      expect(prompts[0]).not.toContain('As links.')
      expect(await replyText()).toContain(`Memory changed during this run: edited [As links, never bare URLs.](((${SHARED_CHILD})))`)
    })

    it('reports a note added to an embedded page after the index was read', async () => {
      await seedMemory('![[Shared]]')
      const prompts = await runOnce(async () => {
        await inProcessClient().runCommand({type: 'append-markdown', target: SHARED_PAGE, markdown: 'New shared summary'})
      })
      expect(prompts[0]).not.toContain('New shared summary')
      expect(await replyText()).toContain('Memory changed during this run: saved [New shared summary]')
    })

    it('reports edits to a shared note embedded in a detail omitted from the index', async () => {
      const memoryId = await seedMemory('Writing preferences')
      const [noteId] = await repo.query['core.childIds']({id: memoryId}).load()
      await repo.mutate.createChild({parentId: noteId, content: `!((${SHARED}))`})
      await repo.awaitProcessors()

      const prompts = await runOnce(async () => {
        await edit(SHARED, 'Cite primary sources.')
      })
      expect(prompts[0]).toContain(`Writing preferences (+1 child) ^${noteId}`)
      expect(prompts[0]).not.toContain(SHARED)
      expect(await replyText()).toContain(`Memory changed during this run: edited [Cite primary sources.](((${SHARED})))`)
      expect(prompts[0]).toContain('embeds you encounter when reading details')
    })

    it('reports no edit to a block of another workspace: embedded, under the memory block or under a shared note', async () => {
      await repo.tx(async tx => {
        await tx.create({id: FOREIGN, workspaceId: 'ws-2', parentId: null, orderKey: 'a0', content: 'Elsewhere.'})
        await tx.create({id: FOREIGN_CHILD, workspaceId: 'ws-2', parentId: FOREIGN, orderKey: 'a0', content: 'Foreign child.'})
        await tx.create({id: FOREIGN_NOTE, workspaceId: 'ws-2', parentId: FOREIGN, orderKey: 'a1', content: 'Foreign note.'})
      }, {...opts, allowUnloadedWorkspace: true})
      const memoryId = await seedMemory(`!((${FOREIGN}))`, `!((${SHARED}))`)
      // Rows as sync applies them, verbatim: blocks of another workspace
      // under the memory block and under a shared note.
      await db.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [SHARED, FOREIGN_CHILD])
      await db.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [memoryId, FOREIGN_NOTE])

      await runOnce(async () => {
        await db.db.execute('UPDATE blocks SET content = ? WHERE id IN (?, ?, ?)', ['Changed.', FOREIGN, FOREIGN_CHILD, FOREIGN_NOTE])
        await edit(SHARED, 'Cite sources, always.')
      })

      expect((await repo.load(FOREIGN))?.content).toBe('Changed.')
      expect(await replyText()).toMatch(new RegExp(
        `^Memory changed during this run: edited \\[Cite sources, always\\.\\]\\(\\(\\(${SHARED}\\)\\)\\)$`, 'm'))
    })

    it.each([
      ['inside a shared note', () => SHARED],
      ['in the memory itself', (memoryId: string) => memoryId],
    ])('leaves out its own reply when the mention is %s', async (_, parentOf) => {
      const memoryId = await seedMemory('![[Shared]]')
      await db.db.execute('UPDATE blocks SET parent_id = ? WHERE id = ?', [parentOf(memoryId), MENTION])
      await runOnce()

      const text = await replyText()
      expect(text).toContain('Done.')
      expect(text).not.toContain('Memory changed')
    })

    it('reports a note once when the memory embeds one of its own', async () => {
      const memoryId = await seedMemory('Topic', `!((${OWN_DEEP}))`)
      const [topic] = await repo.query['core.childIds']({id: memoryId}).load()
      await repo.tx(async tx => {
        const sub = await tx.create({workspaceId: WS, parentId: topic, orderKey: 'a0', content: 'Subtopic'})
        await tx.create({id: OWN_DEEP, workspaceId: WS, parentId: sub, orderKey: 'a0', content: 'Deep note.'})
      }, opts)

      const prompts = await runOnce(async () => {
        await edit(OWN_DEEP, 'Deep note, revised.')
      })

      expect(prompts[0]).toContain(`[shared] Deep note. ^${OWN_DEEP}`)
      expect(prompts[0]).not.toContain('Subtopic')
      expect(await replyText()).toMatch(new RegExp(
        `^Memory changed during this run: edited \\[Deep note, revised\\.\\]\\(\\(\\(${OWN_DEEP}\\)\\)\\)$`, 'm'))
    })

    it('reports an embed the run adds or removes as that note, not as the shared notes appearing or going', async () => {
      const memoryId = await seedMemory(`!((${SHARED}))`)
      const [embedRow] = await repo.query['core.childIds']({id: memoryId}).load()
      await runOnce(async () => {
        await inProcessClient().runCommand({type: 'delete-block', id: embedRow})
        await inProcessClient().runCommand({type: 'append-markdown', target: memoryId, markdown: '![[Shared]]'})
      })

      const text = await replyText()
      expect(text).toMatch(/Memory changed during this run: saved \[embedded Shared\]\(\(\([\w-]+\)\)\); removed "embedded block" \(`[\w-]+`\)$/m)
    })
  })
})

describe('dispatch writes and the person\'s undo stack', () => {
  it('keeps a run\'s writes off it, so undoing an edit made mid-run keeps the run done and its reply', async () => {
    repo.undoManager.clear()
    const engine = engineFor(async options => {
      options.onEvent?.({kind: 'activity', label: 'Reading the page', stepId: 'read-page'})
      options.onEvent?.({kind: 'text', text: 'Half an answer'})
      // The person keeps typing into the mention while the run is live.
      await repo.tx(async tx => { await tx.update(MENTION, {content: '[[claude]] summarize this, briefly'}) }, opts)
      return result({resultText: 'The summary.'})
    })

    await engine.tick()
    await engine.drain()
    expect(repo.undoManager.depths(ChangeScope.BlockDefault).undo).toBe(1)

    expect(await repo.undo()).toBe(true)
    const mention = await repo.load(MENTION)
    expect(mention?.content).toBe('[[claude]] summarize this')
    expect(mention?.properties).toMatchObject({[PROPS.status]: 'done', [PROPS.activity]: ''})
    expect(await replyIds()).toHaveLength(1)
  })
})
