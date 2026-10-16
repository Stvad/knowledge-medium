// @vitest-environment node
/**
 * The deterministic half of the agent-ergonomics eval, on the fixture
 * imported into a node test repo (no browser):
 *
 * - output budgets: byte size of representative km MCP tool outputs, called
 *   through the real MCP server. `AGENT_EVAL_SIZES_OUT=<path>` writes the
 *   measured sizes as JSON for the eval report and for re-baselining.
 * - task checks: each task's ground truth agrees with the imported graph,
 *   a correct solution passes its check (write tasks solve through the MCP
 *   tools, so the task is doable on the current surface), and a wrong one
 *   fails it.
 *
 * - isolation: the runner's snapshot restore undoes every kind of change.
 *
 * Budgets run first: the later sections write to the graph.
 */
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { buildFixture, DESIGN_PAGE, PEOPLE, PRICING_FAQ_TODO, PROJECT_PAGE, READING_LOG_PAGE, ROLLOUT_BLOCK_TEXT, TARGET_UIDS } from './fixture'
import { childrenOf, dailyNoteId, descendantsOf, type GraphProbe, pageIdByTitle, requirePageId, sqlAll } from './graphQueries'
import { changesSince, restoreSnapshot, snapshotWorkspace, strayChanges } from './isolation'
import { OUTPUT_PROBES, type ProbeContext } from './outputBudgets'
import { type CheckInput, type CheckOutcome, targetId, TASKS, type TaskEnv } from './tasks'
import { seedFixtureTestGraph, TEST_WORKSPACE_ID, type FixtureTestGraph } from './testGraph'

let db: TestDb
let graph: FixtureTestGraph
let probe: GraphProbe
const {truth} = buildFixture()

// Seeding imports ~5.8k blocks: ~5s alone, budgeted for 6x under the gate.
beforeAll(async () => {
  db = await createTestDb()
  graph = await seedFixtureTestGraph(db.db)
  probe = {workspaceId: TEST_WORKSPACE_ID, command: graph.command}
}, 60_000)

afterAll(async () => {
  await graph?.close()
  await db?.cleanup()
})

describe('output budgets', () => {
  const measured: Record<string, number> = {}
  afterAll(() => {
    const out = process.env.AGENT_EVAL_SIZES_OUT
    if (out) writeFileSync(out, `${JSON.stringify(measured, null, 2)}\n`)
  })

  it.each(OUTPUT_PROBES.map(outputProbe => [outputProbe.id, outputProbe] as const))('%s', async (_id, outputProbe) => {
    const context: ProbeContext = {
      callTool: graph.callTool,
      pageId: title => requirePageId(probe, title),
      dailyNoteId: iso => dailyNoteId(probe, iso),
    }
    const bytes = Buffer.byteLength(await outputProbe.run(context), 'utf8')
    measured[outputProbe.id] = bytes
    expect(bytes, `${outputProbe.id} (${outputProbe.standsFor}) returned ${bytes} bytes; budget ${outputProbe.maxBytes}`)
      .toBeLessThanOrEqual(outputProbe.maxBytes)
  }, 20_000)
})

const fixtureDays = (from: string, to: string) => {
  const days: string[] = []
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  return days
}

/** Answers derived from the imported graph, independently of the generator's truth. */
const deriveReadAnswers = async (): Promise<Record<string, unknown>> => {
  const kestrelDates: string[] = []
  const kestrelAbout: Record<string, string> = {}
  for (const iso of fixtureDays('2026-06-01', '2026-06-30')) {
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
  for (const iso of fixtureDays('2026-01-01', '2026-08-31')) dailyByBlockId.set(await dailyNoteId(probe, iso), iso)
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
  for (const iso of fixtureDays('2026-07-01', '2026-07-31')) {
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
      decision: childrenOfRow(heading('Decision').id)[0].content,
      openQuestions: childrenOfRow(heading('Open questions').id).length,
    },
  }
}

/** One wrong answer per read task — a near miss, not garbage. */
const wrongAnswers: Record<string, unknown> = {
  // Every date found, but the summaries only restate that Kestrel came up.
  'kestrel-june': {
    dates: truth.kestrelJuneDates,
    about: Object.fromEntries(truth.kestrelJuneDates.map(date => [date, 'Kestrel was mentioned in the notes'])),
  },
  'standup-blockers': {dates: [...truth.stagingBlockerDates, '2026-06-03']},
  'orchard-open-todos': {todos: [...truth.openOrchardTodos, 'Book launch venue']},
  'reading-log-needle': {rating: 5, recommendedBy: truth.needleBook.recommendedBy},
  'renewal-vendors': {vendors: [...truth.renewalDueVendors, 'Office Lease']},
  // Distinct dates, but counting days instead of meetings.
  'meetings-with-person': {count: new Set(truth.julyMeetingsWithInes).size, dates: [...new Set(truth.julyMeetingsWithInes)]},
  'reading-log-filter': {titles: truth.tomasFiveStarBooks.slice(1)},
  'summarize-design': {author: PEOPLE[0], decision: 'Adopt a CRDT', openQuestions: truth.design.openQuestions},
}

const resultIdOf = (text: string) => (JSON.parse(text) as {id: string}).id

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
    const [block] = (await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE)))
      .filter(row => row.content === ROLLOUT_BLOCK_TEXT)
    await graph.callTool('update_block', {id: block.id, content: ROLLOUT_BLOCK_TEXT.replace('Q3 2026', 'Q4 2026')})
  },
  'create-linked-page': async ({runTag}) => {
    const title = `Vendor Review: Kestrel ${runTag}`
    const vendors = (await descendantsOf(probe, await requirePageId(probe, PROJECT_PAGE)))
      .find(row => row.content === '## Vendors')!
    await graph.callTool('create_block', {parentId: vendors.id, content: `[[${title}]]`})
    // The linked page is created by the references processor after commit.
    const pageId = await vi.waitFor(async () => {
      const id = await pageIdByTitle(probe, title)
      if (!id) throw new Error('linked page not created yet')
      return id
    }, {timeout: 5_000})
    await graph.callTool('create_block', {parentId: pageId, content: 'Status: under review'})
  },
  'complete-todo': async () => {
    const [todo] = (await descendantsOf(probe, await requirePageId(probe, PROJECT_PAGE)))
      .filter(row => row.content === PRICING_FAQ_TODO)
    await graph.callTool('update_block', {id: todo.id, properties: {status: 'done'}})
  },
}

/** A plausible wrong solution per write task: the edit an agent gets wrong. */
const solveWrongly: Record<string, (env: TaskEnv) => Promise<void>> = {
  'daily-checkin': async () => {
    const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
    await graph.callTool('create_block', {
      parentId: today,
      content: 'Eval check-in\nDone: drafted the sync rollout plan\nNext: review the Kestrel renewal\nBlockers: none',
    })
  },
  'edit-rollout-phrase': async () => {
    const [block] = (await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE)))
      .filter(row => row.content === ROLLOUT_BLOCK_TEXT)
    await graph.callTool('update_block', {id: block.id, content: 'Target: Q4 2026.'})
  },
  'create-linked-page': async ({runTag}) => {
    const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
    await graph.callTool('create_block', {parentId: today, content: `[[Vendor Review: Kestrel ${runTag}]]`})
  },
  'complete-todo': async () => {
    const [todo] = (await descendantsOf(probe, await requirePageId(probe, PROJECT_PAGE)))
      .filter(row => row.content === PRICING_FAQ_TODO)
    await graph.callTool('update_block', {id: todo.id, content: `{{[[DONE]]}} ${PRICING_FAQ_TODO}`})
  },
}

const expectOutcome = (outcome: CheckOutcome, pass: boolean) => expect(outcome.pass, outcome.detail).toBe(pass)

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
    expectOutcome(await task.check(input(wrongAnswers[task.id])), false)
    expectOutcome(await task.check(input(undefined)), false)
  })

  // Wrong first, then reset restores the starting state, then the right
  // solution — which also proves reset undoes a botched attempt.
  it.each(writeTasks.map(task => [task.id, task] as const))('%s: a wrong edit fails; reset then an MCP solution passes', async (_id, task) => {
    const wrongEnv: TaskEnv = {probe, truth, runTag: `w${task.id.length}`}
    await task.reset?.(wrongEnv)
    const wrongStart = Date.now()
    await solveWrongly[task.id](wrongEnv)
    expectOutcome(await task.check({...wrongEnv, answer: undefined, startedAt: wrongStart}), false)

    const env: TaskEnv = {probe, truth, runTag: `r${task.id.length}`}
    await task.reset?.(env)
    const startedAt = Date.now()
    await solveWithMcp[task.id](env)
    expectOutcome(await task.check({...env, answer: undefined, startedAt}), true)
  }, 20_000)
})

describe('isolation', () => {
  it('undoes every kind of change a task can make, and names the ones it was not asked for', async () => {
    const snapshot = await snapshotWorkspace(probe)
    const design = await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE))
    const byText = (prefix: string) => design.find(row => row.content.startsWith(prefix))!
    const edited = byText('Devices stay offline')
    const tagged = byText('Support sees roughly')
    const removed = byText('The current protocol ships')
    const moved = byText('Migration runs per workspace')
    const rollout = targetId(TEST_WORKSPACE_ID, TARGET_UIDS.rollout)
    const startedAt = Date.now()

    await graph.callTool('update_block', {id: edited.id, content: 'rewritten'})
    await graph.callTool('update_block', {id: tagged.id, properties: {'eval:tag': 'x'}})
    await graph.callTool('delete_block', {id: removed.id})
    await graph.callTool('move_block', {id: moved.id, parentId: edited.parent_id, position: {kind: 'first'}})
    await graph.callTool('update_block', {id: rollout, content: 'Target: Q4 2026.'})
    await graph.callTool('create_block', {parentId: edited.id, content: 'a new child'})

    const changes = await restoreSnapshot(probe, snapshot, startedAt)
    expect(changes.created).toHaveLength(1)
    expect(changes.modified.map(change => change.id).sort())
      .toEqual([edited.id, tagged.id, removed.id, moved.id, rollout].sort())
    // The rollout edit is what edit-rollout-phrase is asked to make; the rest are stray.
    expect(strayChanges(changes, new Set([rollout]), 'write')).toBe(4)
    expect(strayChanges(changes, new Set(), 'read')).toBe(6)

    const after = await changesSince(probe, snapshot, startedAt)
    expect(after.created).toEqual([])
    expect(after.modified.filter(change => change.before.order_key === change.after.order_key)).toEqual([])
    const restored = new Map((await descendantsOf(probe, await requirePageId(probe, DESIGN_PAGE))).map(row => [row.id, row]))
    for (const block of [edited, tagged, removed, moved]) {
      expect({content: restored.get(block.id)?.content, properties: JSON.parse(restored.get(block.id)?.properties_json ?? 'null'), parent: restored.get(block.id)?.parent_id})
        .toEqual({content: block.content, properties: JSON.parse(block.properties_json), parent: block.parent_id})
    }
  }, 30_000)
})
