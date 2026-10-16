// @vitest-environment node
/**
 * The deterministic half of the agent-ergonomics eval, on the fixture
 * imported into a node test repo (no browser):
 *
 * - imported fixture: its stored state, and the size in characters of
 *   representative km MCP tool outputs, called through the real MCP server,
 *   each within a budget. `AGENT_EVAL_SIZES_OUT=<path>` writes both as JSON:
 *   the runner checks the live tab's state against it, and re-baselining
 *   reads the sizes.
 * - task checks: each task's ground truth agrees with the imported graph,
 *   a correct solution passes (write tasks solve through the MCP tools, so
 *   the task is doable on the current surface), and a wrong one fails —
 *   a write task on its check or on a change it was not asked to make.
 *
 * - isolation: the runner's snapshot restore undoes every kind of change.
 *
 * Every case starts from the imported fixture (see the afterEach below).
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import {
  buildFixture,
  DESIGN_PAGE,
  FIXTURE_FIRST_DAY,
  FIXTURE_LAST_DAY,
  isoDays,
  PRICING_FAQ_TODO,
  PROJECT_PAGE,
  READING_LOG_PAGE,
  ROLLOUT_BLOCK_TEXT,
  TARGET_UIDS,
} from './fixture'
import { userStateRootBlockIds } from '@/data/derivedIds'
import { childrenOf, dailyNoteId, descendantsOf, getBlock, type GraphProbe, pageIdByTitle, requirePageId, sqlAll } from './graphQueries'
import { diffAgainst, restoreSnapshot, snapshotWorkspace, strayChanges, waitForQuiet, type WorkspaceSnapshot } from './isolation'
import { differingUids, fixtureState } from './fixtureState'
import { OUTPUT_PROBES, type ProbeContext } from './outputBudgets'
import { createRunJournal } from './runJournal'
import {
  allowedChanges,
  type CheckInput,
  type CheckOutcome,
  type EvalTask,
  targetId,
  TASKS,
  type TaskEnv,
  vendorReviewTitle,
} from './tasks'
import { seedFixtureTestGraph, TEST_WORKSPACE_ID, type FixtureTestGraph } from './testGraph'

let db: TestDb
let graph: FixtureTestGraph
let probe: GraphProbe
const {truth, hash: fixtureHash} = buildFixture()

let fixtureSnapshot: WorkspaceSnapshot
// In-process writes settle in milliseconds; the live runner waits longer.
const QUIET = {quietMs: 50, maxMs: 2_000}

// Seeding imports ~5.8k blocks: ~5s alone, budgeted for 6x under the gate.
beforeAll(async () => {
  db = await createTestDb()
  graph = await seedFixtureTestGraph(db.db)
  probe = {workspaceId: TEST_WORKSPACE_ID, command: graph.command}
  fixtureSnapshot = await snapshotWorkspace(probe, QUIET)
}, 60_000)

// One import is shared by every case, so each case's writes are undone
// against the post-import snapshot — the runner's own restore — and no case
// depends on another's leftovers or on declaration order.
afterEach(async () => { await restoreSnapshot(probe, fixtureSnapshot, QUIET) })

afterAll(async () => {
  await graph?.close()
  await db?.cleanup()
})

describe('imported fixture', () => {
  const outputs: Record<string, number> = {}
  let state: string[] = []
  afterAll(() => {
    const out = process.env.AGENT_EVAL_SIZES_OUT
    if (out) writeFileSync(out, `${JSON.stringify({outputs, state})}\n`)
  })

  it('state', async () => {
    state = await fixtureState(probe, buildFixture().pages)
    expect(state.length).toBeGreaterThan(5_000)
  }, 20_000)

  it.each(OUTPUT_PROBES.map(outputProbe => [outputProbe.id, outputProbe] as const))('%s', async (_id, outputProbe) => {
    const context: ProbeContext = {
      callTool: graph.callTool,
      pageId: title => requirePageId(probe, title),
      dailyNoteId: iso => dailyNoteId(probe, iso),
    }
    const chars = (await outputProbe.run(context)).length
    outputs[outputProbe.id] = chars
    expect(chars, `${outputProbe.id} (${outputProbe.standsFor}) returned ${chars} characters; budget ${outputProbe.maxChars}`)
      .toBeLessThanOrEqual(outputProbe.maxChars)
  }, 20_000)
})

/** Answers derived from the imported graph, independently of the generator's truth. */
const deriveReadAnswers = async (): Promise<Record<string, unknown>> => {
  const kestrelDates: string[] = []
  const kestrelAbout: Record<string, string> = {}
  for (const iso of isoDays('2026-06-01', '2026-06-30')) {
    const mentions: string[] = []
    for (const child of await childrenOf(probe, await dailyNoteId(probe, iso))) {
      const text = [child.content, ...(await descendantsOf(probe, child.id)).map(row => row.content)].join(' ')
      if (/kestrel/i.test(text)) mentions.push(text)
    }
    if (mentions.length === 0) continue
    kestrelDates.push(iso)
    kestrelAbout[iso] = mentions.join(' / ')
  }

  const dailyByBlockId = new Map<string, string>()
  for (const iso of isoDays(FIXTURE_FIRST_DAY, FIXTURE_LAST_DAY)) dailyByBlockId.set(await dailyNoteId(probe, iso), iso)
  const blockers = await sqlAll<{daily: string}>(probe, `
    SELECT standup.parent_id AS daily FROM blocks blocker
    JOIN blocks standup ON standup.id = blocker.parent_id
    WHERE blocker.deleted = 0 AND standup.content = '[[Standup]]'
      AND blocker.content LIKE 'Blockers:%' AND blocker.content LIKE '%staging database%'`)

  const orchard = await descendantsOf(probe, await requirePageId(probe, PROJECT_PAGE))
  const openTodos = orchard
    .filter(row => {
      const properties = JSON.parse(row.properties_json) as {types?: string[], status?: string}
      return properties.types?.includes('todo') && properties.status === 'open'
    })
    .map(row => row.content)

  const needle = (await childrenOf(probe, await requirePageId(probe, READING_LOG_PAGE)))
    .find(row => row.content.startsWith('The Quiet Lattice —'))
  const needleMatch = needle && /rating (\d)\/5 — recommended by \[\[([^\]]+)\]\]/.exec(needle.content)

  const vendorPageId = await requirePageId(probe, 'Vendor')
  const renewalVendors = await sqlAll<{content: string}>(probe, `
    SELECT content FROM blocks
    WHERE workspace_id = ? AND deleted = 0
      AND json_extract(properties_json, '$."roam:Status"') = 'renewal due'
      AND EXISTS (SELECT 1 FROM json_each(properties_json, '$."roam:isa"') WHERE value = ?)`,
  [TEST_WORKSPACE_ID, vendorPageId])

  const julyMeetingsWithInes: string[] = []
  for (const iso of isoDays('2026-07-01', '2026-07-31')) {
    for (const meeting of (await childrenOf(probe, await dailyNoteId(probe, iso))).filter(row => row.content === '[[Meeting]]')) {
      if ((await childrenOf(probe, meeting.id)).some(row => row.content === 'with [[Ines Varga]]')) julyMeetingsWithInes.push(iso)
    }
  }

  const tomasFiveStar = (await childrenOf(probe, await requirePageId(probe, READING_LOG_PAGE)))
    .map(row => /^(.*) — rating 5\/5 — recommended by \[\[Tomas Reyes\]\]$/.exec(row.content)?.[1])
    .filter((title): title is string => title !== undefined)

  const design = await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE))
  const heading = (text: string) => design.find(row => row.content === `## ${text}`)!
  const childrenOfRow = (id: string) => design
    .filter(row => row.parent_id === id)
    .sort((a, b) => a.order_key.localeCompare(b.order_key))

  return {
    'kestrel-june': {dates: kestrelDates, about: kestrelAbout},
    'standup-blockers': {dates: blockers.map(row => dailyByBlockId.get(row.daily))},
    'orchard-open-todos': {todos: openTodos},
    'reading-log-needle': {rating: Number(needleMatch?.[1]), recommendedBy: needleMatch?.[2]},
    'renewal-vendors': {vendors: renewalVendors.map(row => row.content)},
    'meetings-with-person': {count: julyMeetingsWithInes.length, dates: [...new Set(julyMeetingsWithInes)]},
    'reading-log-filter': {titles: tomasFiveStar},
    'summarize-design': {
      author: /\[\[([^\]]+)\]\]/.exec(design.find(row => row.content.startsWith('Author::'))!.content)?.[1],
      adopted: childrenOfRow(heading('Decision').id)[0].content,
      rejected: childrenOfRow(heading('Decision').id).find(row => row.content.startsWith('Rejected:'))!.content,
      openQuestions: childrenOfRow(heading('Open questions').id).length,
    },
  }
}

const designAnswer = {
  author: truth.design.author,
  adopted: 'per-field LWW with hybrid logical clocks',
  rejected: 'a CRDT for content',
  openQuestions: truth.design.openQuestions,
}

/** Wrong answers per read task — near misses, not garbage. */
const wrongAnswers: Record<string, unknown[]> = {
  // Every date found, but the summaries only restate that Kestrel came up.
  'kestrel-june': [{
    dates: truth.kestrelJuneDates,
    about: Object.fromEntries(truth.kestrelJuneDates.map(date => [date, 'Kestrel was mentioned in the notes'])),
  }],
  'standup-blockers': [{dates: [...truth.stagingBlockerDates, '2026-06-03']}],
  'orchard-open-todos': [{todos: [...truth.openOrchardTodos, 'Book launch venue']}],
  'reading-log-needle': [{rating: 5, recommendedBy: truth.needleBook.recommendedBy}],
  'renewal-vendors': [{vendors: [...truth.renewalDueVendors, 'Office Lease']}],
  // Distinct dates, but counting days instead of meetings.
  'meetings-with-person': [{count: new Set(truth.julyMeetingsWithInes).size, dates: [...new Set(truth.julyMeetingsWithInes)]}],
  'reading-log-filter': [{titles: truth.tomasFiveStarBooks.slice(1)}],
  'summarize-design': [
    // The decision read backwards.
    {...designAnswer, adopted: 'a CRDT for content', rejected: 'per-field last-writer-wins'},
    {...designAnswer, adopted: 'a server-side merge queue'},
    {...designAnswer, rejected: 'a server-side merge queue'},
  ],
}

const resultIdOf = (text: string) => (JSON.parse(text) as {id: string}).id

/** The id a fixture block with a known Roam uid imported to. */
const fixtureId = (uid: keyof typeof TARGET_UIDS) => targetId(TEST_WORKSPACE_ID, TARGET_UIDS[uid])

/** A correct solution for each write task, done through the km MCP tools. */
const solveWithMcp: Record<string, (env: TaskEnv) => Promise<void>> = {
  'daily-checkin': async () => {
    const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
    const parentId = resultIdOf(await graph.callTool('create_block', {parentId: today, content: 'Eval check-in'}))
    for (const content of ['Done: drafted the sync rollout plan', 'Next: review the Kestrel renewal', 'Blockers: none']) {
      await graph.callTool('create_block', {parentId, content})
    }
  },
  'edit-rollout-phrase': async () => {
    await graph.callTool('update_block', {id: fixtureId('rollout'), content: ROLLOUT_BLOCK_TEXT.replace('Q3 2026', 'Q4 2026')})
  },
  'create-linked-page': async ({runTag}) => {
    const title = vendorReviewTitle(runTag)
    await graph.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: `[[${title}]]`})
    // The linked page is created by the references processor after commit.
    const pageId = await vi.waitFor(async () => {
      const id = await pageIdByTitle(probe, title)
      if (!id) throw new Error('linked page not created yet')
      return id
    }, {timeout: 5_000})
    await graph.callTool('create_block', {parentId: pageId, content: 'Status: under review'})
  },
  'complete-todo': async () => {
    await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), properties: {status: 'done'}})
  },
}

/** Plausible wrong solutions per write task: the edits an agent gets wrong. */
const solveWrongly: Record<string, Array<(env: TaskEnv) => Promise<void>>> = {
  'daily-checkin': [
    async () => {
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      await graph.callTool('create_block', {
        parentId: today,
        content: 'Eval check-in\nDone: drafted the sync rollout plan\nNext: review the Kestrel renewal\nBlockers: none',
      })
    },
    // The check-in right, but carrying a property nobody asked for.
    async () => {
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      const parentId = resultIdOf(await graph.callTool('create_block', {parentId: today, content: 'Eval check-in', properties: {'eval:mood': 'good'}}))
      for (const content of ['Done: drafted the sync rollout plan', 'Next: review the Kestrel renewal', 'Blockers: none']) {
        await graph.callTool('create_block', {parentId, content})
      }
    },
    // The check-in right, plus a block nobody asked for beside it.
    async env => {
      await solveWithMcp['daily-checkin'](env)
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      await graph.callTool('create_block', {parentId: today, content: 'Also: water the plants'})
    },
  ],
  'edit-rollout-phrase': [
    async () => {
      await graph.callTool('update_block', {id: fixtureId('rollout'), content: 'Target: Q4 2026.'})
    },
    // The phrase right, but the block's properties touched too.
    async () => {
      await graph.callTool('update_block', {
        id: fixtureId('rollout'),
        content: ROLLOUT_BLOCK_TEXT.replace('Q3 2026', 'Q4 2026'),
        properties: {'eval:note': 'edited'},
      })
    },
  ],
  'create-linked-page': [
    async ({runTag}) => {
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      await graph.callTool('create_block', {parentId: today, content: `[[${vendorReviewTitle(runTag)}]]`})
    },
    // The page and link right, plus another block under Vendors.
    async env => {
      await solveWithMcp['create-linked-page'](env)
      await graph.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: '[[Kestrel]] — renewal notes'})
    },
    // The link added twice.
    async env => {
      await solveWithMcp['create-linked-page'](env)
      await graph.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: `[[${vendorReviewTitle(env.runTag)}]]`})
    },
  ],
  'complete-todo': [
    // Marked done in the text, not the status.
    async () => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), content: `{{[[DONE]]}} ${PRICING_FAQ_TODO}`})
    },
    // Status right, but the todo's text rewritten.
    async () => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), content: 'Draft FAQ', properties: {status: 'done'}})
    },
    // Status right, plus a property nobody asked for.
    async () => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), properties: {status: 'done', 'eval:note': 'done'}})
    },
    // Status right, but the todo moved off its section.
    async () => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), properties: {status: 'done'}})
      await graph.callTool('move_block', {id: fixtureId('pricingFaqTodo'), parentId: await requirePageId(probe, PROJECT_PAGE), position: {kind: 'last'}})
    },
  ],
}

const expectOutcome = (outcome: CheckOutcome, pass: boolean) => expect(outcome.pass, outcome.detail).toBe(pass)

/** One attempt at a write task, scored as the runner scores it: reset, then
 *  the state every attempt starts from, then the check and the changes the
 *  task was not asked to make. */
const attempt = async (task: EvalTask, env: TaskEnv, solve: (env: TaskEnv) => Promise<void>): Promise<CheckOutcome> => {
  await task.reset?.(env)
  const before = await snapshotWorkspace(probe, QUIET)
  const startedAt = Date.now()
  await solve(env)
  const outcome = await task.check({...env, answer: undefined, startedAt})
  const stray = strayChanges(await diffAgainst(probe, before, QUIET), allowedChanges(task, TEST_WORKSPACE_ID, outcome))
  return {pass: outcome.pass && stray === 0, detail: `${outcome.detail}; ${stray} stray change(s)`}
}

describe('task checks', () => {
  let derived: Record<string, unknown>
  beforeAll(async () => { derived = await deriveReadAnswers() }, 30_000)

  const readTasks = TASKS.filter(task => task.kind === 'read')
  const writeTasks = TASKS.filter(task => task.kind === 'write')
  const input = (answer: unknown, startedAt = Date.now(), runTag = 't0'): CheckInput =>
    ({probe, truth, runTag, answer, startedAt})

  it('covers every task with a reference solution and a wrong one', () => {
    expect(Object.keys(wrongAnswers).sort()).toEqual(readTasks.map(task => task.id).sort())
    expect(Object.keys(solveWithMcp).sort()).toEqual(writeTasks.map(task => task.id).sort())
    expect(Object.keys(solveWrongly).sort()).toEqual(writeTasks.map(task => task.id).sort())
  })

  it.each(readTasks.map(task => [task.id, task] as const))('%s: truth matches the graph; a near miss fails', async (_id, task) => {
    expectOutcome(await task.check(input(derived[task.id])), true)
    for (const wrong of wrongAnswers[task.id]) expectOutcome(await task.check(input(wrong)), false)
    expectOutcome(await task.check(input(undefined)), false)
  })

  // Wrong attempts first, each reset on top of the last, then the right
  // solution — which also proves reset undoes what a botched attempt broke.
  it.each(writeTasks.map(task => [task.id, task] as const))('%s: wrong edits fail; reset then an MCP solution passes', async (_id, task) => {
    for (const [index, solveWrong] of solveWrongly[task.id].entries()) {
      expectOutcome(await attempt(task, {probe, truth, runTag: `w${index}`}, solveWrong), false)
    }
    expectOutcome(await attempt(task, {probe, truth, runTag: `r${task.id.length}`}, solveWithMcp[task.id]), true)
  }, 30_000)
})

/** Snapshot rows whose recency stamps differ from the snapshot's; search and
 *  recents order by them. */
const stampsMovedSince = async (snapshot: WorkspaceSnapshot) =>
  (await sqlAll<{id: string, updated_at: number, user_updated_at: number | null}>(probe,
    'SELECT id, updated_at, user_updated_at FROM blocks WHERE workspace_id = ?', [TEST_WORKSPACE_ID]))
    .filter(row => {
      const before = snapshot.rows.get(row.id)
      return before !== undefined && (row.updated_at !== before.updated_at || row.user_updated_at !== before.user_updated_at)
    })
    .map(row => row.id)

describe('isolation', () => {
  it('undoes every kind of change a task can make, and names the ones it was not asked for', async () => {
    const snapshot = await snapshotWorkspace(probe, QUIET)
    const design = await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE))
    const byText = (prefix: string) => design.find(row => row.content.startsWith(prefix))!
    const edited = byText('Devices stay offline')
    const tagged = byText('Support sees roughly')
    const removed = byText('The current protocol ships')
    const moved = byText('Migration runs per workspace')
    const movedToo = byText('Success metric')
    const rollout = fixtureId('rollout')

    await graph.callTool('update_block', {id: edited.id, content: 'rewritten'})
    await graph.callTool('update_block', {id: tagged.id, properties: {'eval:tag': 'x'}})
    await graph.callTool('delete_block', {id: removed.id})
    // Two adjacent siblings: undoing the first must not anchor on the second
    // while it is still elsewhere.
    await graph.callTool('move_block', {id: moved.id, parentId: edited.parent_id, position: {kind: 'first'}})
    await graph.callTool('move_block', {id: movedToo.id, parentId: edited.parent_id, position: {kind: 'first'}})
    await graph.callTool('update_block', {id: rollout, content: 'Target: Q4 2026.'})
    await graph.callTool('create_block', {parentId: edited.id, content: 'a new child'})

    const changes = await restoreSnapshot(probe, snapshot, QUIET)
    expect(changes.created).toHaveLength(1)
    expect(changes.modified.map(change => change.id).sort())
      .toEqual([edited.id, tagged.id, removed.id, moved.id, movedToo.id, rollout].sort())
    // The rollout edit is what edit-rollout-phrase is asked to make; the rest are stray.
    const rolloutContent = new Map([[rollout, {content: true} as const]])
    expect(strayChanges(changes, {edits: rolloutContent, creates: new Map()})).toBe(6)
    expect(strayChanges(changes, {edits: rolloutContent, creates: new Map([[changes.created[0].id, []]])})).toBe(5)
    expect(strayChanges(changes, {edits: new Map(), creates: new Map()})).toBe(7)

    expect(await diffAgainst(probe, snapshot, QUIET)).toEqual({created: [], modified: []})
    const restored = new Map((await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE))).map(row => [row.id, row]))
    for (const block of [edited, tagged, removed, moved, movedToo]) {
      expect({content: restored.get(block.id)?.content, properties: JSON.parse(restored.get(block.id)?.properties_json ?? 'null'), parent: restored.get(block.id)?.parent_id})
        .toEqual({content: block.content, properties: JSON.parse(block.properties_json), parent: block.parent_id})
    }
    expect((await childrenOf(probe, moved.parent_id!)).map(row => row.id))
      .toEqual(design.filter(row => row.parent_id === moved.parent_id)
        .sort((a, b) => a.order_key.localeCompare(b.order_key)).map(row => row.id))
    expect(await stampsMovedSince(snapshot)).toEqual([])
  }, 30_000)

  // A post-commit processor the undo's own write starts: it lands a moment
  // after the undo of the rollout block, on a block the task never touched.
  const rollout = fixtureId('rollout')
  const bystander = fixtureId('vendorsSection')
  const withLateProcessor = (sql: string, params: unknown[]): GraphProbe => ({
    ...probe,
    command: async command => {
      const result = await probe.command(command)
      if (command.type === 'update-block' && command.id === rollout) {
        setTimeout(() => { void probe.command({type: 'sql', mode: 'execute', sql, params, allowSyncedWrite: true}) }, 20)
      }
      return result
    },
  })

  it('waits out the writes its own undo starts, and puts back the stamps they move', async () => {
    const snapshot = await snapshotWorkspace(probe, QUIET)
    await graph.callTool('update_block', {id: rollout, content: 'Target: Q4 2026.'})
    // A re-derive that finds nothing to change still moves the recency stamp.
    await restoreSnapshot(withLateProcessor('UPDATE blocks SET updated_at = ? WHERE id = ?', [Date.now() + 1, bystander]), snapshot, QUIET)
    await waitForQuiet(probe, QUIET)
    expect(await stampsMovedSince(snapshot)).toEqual([])
  }, 20_000)

  it('proves derived columns too: one a late processor leaves different fails the restore', async () => {
    const snapshot = await snapshotWorkspace(probe, QUIET)
    const stored = snapshot.rows.get(bystander)!.references_json
    await graph.callTool('update_block', {id: rollout, content: 'Target: Q4 2026.'})
    await expect(restoreSnapshot(withLateProcessor('UPDATE blocks SET references_json = ? WHERE id = ?', ['[{"stale":true}]', bystander]), snapshot, QUIET))
      .rejects.toThrow(`could not restore 1 block(s) to the fixture state (${bystander})`)
    await probe.command({type: 'sql', mode: 'execute', sql: 'UPDATE blocks SET references_json = ? WHERE id = ?', params: [stored, bystander], allowSyncedWrite: true})
  }, 20_000)
})

describe('fixture state', () => {
  const pages = buildFixture().pages

  it('names every block by uid, so a property change shows up on that block alone', async () => {
    const before = await fixtureState(probe, pages)
    const halyard = await requirePageId(probe, 'Halyard Security')
    await graph.callTool('update_block', {id: halyard, properties: {'roam:Status': 'active'}})
    expect(differingUids(before, await fixtureState(probe, pages))).toEqual(['vendor-halyard-security'])
  }, 20_000)

  it('ignores where a page sits at the top level, which differs from one import to the next', async () => {
    const before = await fixtureState(probe, pages)
    const halyard = await requirePageId(probe, 'Halyard Security')
    const orderKey = fixtureSnapshot.rows.get(halyard)!.order_key
    const setOrderKey = (key: string) => probe.command({
      type: 'sql', mode: 'execute', sql: 'UPDATE blocks SET order_key = ? WHERE id = ?', params: [key, halyard], allowSyncedWrite: true,
    })
    await setOrderKey('zzzz')
    expect(await fixtureState(probe, pages)).toEqual(before)
    await setOrderKey(orderKey)
  }, 20_000)

  it('is unchanged by a move the runner undoes, which leaves the block a new order key', async () => {
    const snapshot = await snapshotWorkspace(probe, QUIET)
    const before = await fixtureState(probe, pages)
    const rollout = fixtureId('rollout')
    await graph.callTool('move_block', {id: rollout, parentId: snapshot.rows.get(rollout)!.parent_id, position: {kind: 'last'}})
    await restoreSnapshot(probe, snapshot, QUIET)
    expect(snapshot.rows.get(rollout)!.order_key).not.toBe(fixtureSnapshot.rows.get(rollout)!.order_key)
    expect(await fixtureState(probe, pages)).toEqual(before)
  }, 20_000)
})

describe('isolation edge cases', () => {
  it('purges a page a link minted, which is born with updated_at = 0', async () => {
    const snapshot = await snapshotWorkspace(probe, QUIET)
    const host = fixtureId('vendorsSection')
    await graph.callTool('create_block', {parentId: host, content: '[[Minted Seat Probe]]'})
    await vi.waitFor(async () => { expect(await pageIdByTitle(probe, 'Minted Seat Probe')).not.toBeNull() }, {timeout: 5_000})

    await restoreSnapshot(probe, snapshot, QUIET)
    expect(await pageIdByTitle(probe, 'Minted Seat Probe')).toBeNull()
    // Purged, not soft-deleted: raw SQL must not find a leftover either.
    expect(await sqlAll(probe, "SELECT id FROM blocks WHERE content LIKE '%Minted Seat Probe%'")).toEqual([])
  }, 20_000)

  it('re-deletes a tombstone an agent revived and edited', async () => {
    const tombstone = (await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE)))
      .find(row => row.content.startsWith('Older clients will keep'))!
    await graph.callTool('delete_block', {id: tombstone.id})
    const snapshot = await snapshotWorkspace(probe, QUIET)
    await graph.callTool('restore_block', {id: tombstone.id})
    await graph.callTool('update_block', {id: tombstone.id, content: 'revived and edited'})

    await restoreSnapshot(probe, snapshot, QUIET)
    expect(await diffAgainst(probe, snapshot, QUIET)).toEqual({created: [], modified: []})
    await graph.callTool('restore_block', {id: tombstone.id})
    expect((await getBlock(probe, tombstone.id))?.content).toBe(tombstone.content)
  }, 20_000)

  it('brings back a fixture block an agent moved under a block it created', async () => {
    const snapshot = await snapshotWorkspace(probe, QUIET)
    const rollout = fixtureId('rollout')
    const before = snapshot.rows.get(rollout)!
    const parentId = resultIdOf(await graph.callTool('create_block', {parentId: before.parent_id, content: 'new container'}))
    await graph.callTool('move_block', {id: rollout, parentId, position: {kind: 'first'}})

    await restoreSnapshot(probe, snapshot, QUIET)
    expect(await diffAgainst(probe, snapshot, QUIET)).toEqual({created: [], modified: []})
    expect((await getBlock(probe, rollout))?.content).toBe(before.content)
  }, 20_000)
})

describe('app state', () => {
  it('leaves the app\'s own state alone, and compares everything else wherever it ends up', async () => {
    // A user page as the app keeps one, with a state root at the id the app derives.
    const userPage = (await probe.command({type: 'create-block', content: 'Eval User', properties: {types: ['user']}}) as {id: string}).id
    const [stateRoot] = userStateRootBlockIds(userPage)
    await probe.command({type: 'create-block', parentId: userPage, content: 'ui-state', data: {id: stateRoot}})
    const snapshot = await snapshotWorkspace(probe, QUIET)
    expect([snapshot.appState.has(stateRoot), snapshot.rows.has(userPage)]).toEqual([true, true])
    const rollout = fixtureId('rollout')

    await graph.callTool('move_block', {id: rollout, parentId: stateRoot, position: {kind: 'first'}})
    const note = resultIdOf(await graph.callTool('create_block', {parentId: userPage, content: 'a note on my page'}))
    const panelState = resultIdOf(await graph.callTool('create_block', {parentId: stateRoot, content: 'panel state'}))

    const changes = await restoreSnapshot(probe, snapshot, QUIET)
    expect(changes.modified.map(change => change.id)).toEqual([rollout])
    expect(changes.created.map(row => row.id)).toEqual([note])
    const [restored] = await sqlAll<{parent_id: string}>(probe, 'SELECT parent_id FROM blocks WHERE id = ?', [rollout])
    expect(restored.parent_id).toBe(snapshot.rows.get(rollout)!.parent_id)
    expect([await getBlock(probe, note), await getBlock(probe, panelState)].map(block => block !== null)).toEqual([false, true])
  }, 20_000)
})

describe('run journal', () => {
  it('undoes what a task left when its run was interrupted, on the next run', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'agent-eval-journal-')), 'journal')
    const interrupted = createRunJournal(dir)
    const userPage = (await probe.command({type: 'create-block', content: 'Eval User', properties: {types: ['user']}}) as {id: string}).id
    const [stateRoot] = userStateRootBlockIds(userPage)
    await probe.command({type: 'create-block', parentId: userPage, content: 'ui-state', data: {id: stateRoot}})
    interrupted.begin(await snapshotWorkspace(probe, QUIET), fixtureHash, [])
    interrupted.taskStarted()
    const rollout = fixtureId('rollout')
    await graph.callTool('update_block', {id: rollout, content: 'left behind'})

    const panelState = resultIdOf(await graph.callTool('create_block', {parentId: stateRoot, content: 'panel state'}))

    expect(await createRunJournal(dir).recover(probe, fixtureHash, QUIET)).toBe(1)
    expect((await getBlock(probe, rollout))?.content).toBe(ROLLOUT_BLOCK_TEXT)
    // The app's own state, as the interrupted run saw it, is left alone.
    expect(await getBlock(probe, panelState)).not.toBeNull()
    expect(existsSync(dir)).toBe(false)
  }, 20_000)

  it('recovers nothing after a task whose undo finished', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'agent-eval-journal-')), 'journal')
    const clean = createRunJournal(dir)
    clean.begin(await snapshotWorkspace(probe, QUIET), fixtureHash, [])
    clean.taskStarted()
    clean.taskRestored()
    expect(await createRunJournal(dir).recover(probe, fixtureHash, QUIET)).toBe(0)
  }, 20_000)

  // A block standing in for the daily note a reset creates when it is missing.
  const setUp = async () => resultIdOf(await graph.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: 'set up by the run'}))

  it('removes what the run\'s setup added when the run ends', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'agent-eval-journal-')), 'journal')
    const journal = createRunJournal(dir)
    const added = await setUp()
    journal.begin(await snapshotWorkspace(probe, QUIET), fixtureHash, [added])
    await journal.end(probe, [added])
    expect(await getBlock(probe, added)).toBeNull()
  }, 20_000)

  it('removes what setup added on the next run, when a run stopped between tasks', async () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'agent-eval-journal-')), 'journal')
    const stopped = createRunJournal(dir)
    const added = await setUp()
    stopped.begin(await snapshotWorkspace(probe, QUIET), fixtureHash, [added])
    stopped.taskStarted()
    stopped.taskRestored()
    expect(await createRunJournal(dir).recover(probe, fixtureHash, QUIET)).toBe(1)
    expect(await getBlock(probe, added)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  }, 20_000)
})
