// @vitest-environment node
/**
 * The deterministic half of the agent-ergonomics eval, on the graph every
 * eval task runs on: the fixture imported into a node repo once, as the
 * runner's template, and each case on a fresh copy of it, as each task gets
 * one (no browser):
 *
 * - imported fixture: its stored state, and the size in characters of
 *   representative km MCP tool outputs, called through the real MCP server,
 *   each within a budget; and a copy differs from its template in nothing,
 *   which is what scoring a task by its diff relies on.
 * - task checks: each task's ground truth agrees with the imported graph,
 *   a correct solution passes (write tasks solve through the MCP tools, so
 *   the task is doable on the current surface), and a wrong one fails —
 *   a write task on its check or on a change it was not asked to make.
 * - task changes: the diff sees every kind of change a task can make.
 * - fixture state: the stored-fixture digest moves with what an importer or
 *   data-layer change would move, and not with what differs per import.
 */
import { rmSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '@/data/test/createTestDb'
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
  TEST_WORKSPACE_ID,
} from './fixture'
import { childrenOf, dailyNoteId, descendantsOf, type GraphProbe, pageIdByTitle, requirePageId, sqlAll } from './graphQueries'
import { fixtureState } from './fixtureState'
import { OUTPUT_PROBES, type ProbeContext } from './outputBudgets'
import { diffAgainst, type Snapshot, snapshotWorkspace, strayChanges } from './taskChanges'
import {
  type CheckInput,
  type CheckOutcome,
  type EvalTask,
  targetId,
  scoreTask,
  TASKS,
  VENDOR_REVIEW_TITLE,
} from './tasks'
import { type FixtureTestGraph, openFixtureTestGraph } from './testGraph'

const {truth} = buildFixture()

interface Graph extends FixtureTestGraph {
  probe: GraphProbe
}

/** The closed database of the seeded fixture, and its rows. */
let template: string
let templateRows: Snapshot

/** A fresh copy of the template, as the runner gives each task. One per
 *  writing case rather than one shared database: the copy is the reset, and
 *  re-importing the fixture costs about 5 s a case. */
const openGraph = async (): Promise<Graph> => {
  const db = await createTestDb({from: template})
  const graph = await openFixtureTestGraph(db.db, {seed: false})
  return {
    ...graph,
    probe: {workspaceId: TEST_WORKSPACE_ID, command: graph.command},
    close: async () => {
      await graph.close()
      await db.cleanup()
    },
  }
}

/** Shared by the cases that only read. */
let graph: Graph
let probe: GraphProbe

// Seeding imports ~5.8k blocks: ~5s alone, budgeted for 6x under the gate.
beforeAll(async () => {
  const seeded = await createTestDb()
  const seeding = await openFixtureTestGraph(seeded.db, {seed: true})
  templateRows = await snapshotWorkspace({workspaceId: TEST_WORKSPACE_ID, command: seeding.command})
  await seeding.close()
  await seeded.db.close()
  template = seeded.dir
  graph = await openGraph()
  probe = graph.probe
}, 60_000)

afterAll(async () => {
  await graph?.close()
  if (template) rmSync(template, {recursive: true, force: true})
})

/** Runs `body` on a fresh copy, so its writes reach no other case. */
const onFreshGraph = async <T>(body: (graph: Graph) => Promise<T>): Promise<T> => {
  const fresh = await openGraph()
  try {
    return await body(fresh)
  } finally {
    await fresh.close()
  }
}

describe('imported fixture', () => {
  it('state', async () => {
    expect((await fixtureState(probe, buildFixture().pages)).length).toBeGreaterThan(5_000)
  }, 20_000)

  it.each(OUTPUT_PROBES.map(outputProbe => [outputProbe.id, outputProbe] as const))('%s', async (_id, outputProbe) => {
    const context: ProbeContext = {
      callTool: graph.callTool,
      pageId: title => requirePageId(probe, title),
      dailyNoteId: iso => dailyNoteId(probe, iso),
    }
    const chars = (await outputProbe.run(context)).length
    expect(chars, `${outputProbe.id} (${outputProbe.standsFor}) returned ${chars} characters; budget ${outputProbe.maxChars}`)
      .toBeLessThanOrEqual(outputProbe.maxChars)
  }, 20_000)

  it('a copy differs from its template in nothing, opened and read from', async () => {
    await onFreshGraph(async fresh => {
      expect(await diffAgainst(fresh.probe, templateRows)).toEqual({created: [], modified: [], removed: []})
      await fresh.callTool('page', {name: PROJECT_PAGE})
      await fresh.callTool('search', {query: 'Kestrel'})
      expect(await diffAgainst(fresh.probe, templateRows)).toEqual({created: [], modified: [], removed: []})
    })
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
const solveWithMcp: Record<string, (graph: Graph) => Promise<void>> = {
  'daily-checkin': async graph => {
    const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
    const parentId = resultIdOf(await graph.callTool('create_block', {parentId: today, content: 'Eval check-in'}))
    for (const content of ['Done: drafted the sync rollout plan', 'Next: review the Kestrel renewal', 'Blockers: none']) {
      await graph.callTool('create_block', {parentId, content})
    }
  },
  'edit-rollout-phrase': async graph => {
    await graph.callTool('update_block', {id: fixtureId('rollout'), content: ROLLOUT_BLOCK_TEXT.replace('Q3 2026', 'Q4 2026')})
  },
  'create-linked-page': async graph => {
    const title = VENDOR_REVIEW_TITLE
    await graph.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: `[[${title}]]`})
    // The linked page is created by the references processor after commit.
    const pageId = await vi.waitFor(async () => {
      const id = await pageIdByTitle(graph.probe, title)
      if (!id) throw new Error('linked page not created yet')
      return id
    }, {timeout: 5_000})
    await graph.callTool('create_block', {parentId: pageId, content: 'Status: under review'})
  },
  'complete-todo': async graph => {
    await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), properties: {status: 'done'}})
  },
}

/** Plausible wrong solutions per write task: the edits an agent gets wrong. */
const solveWrongly: Record<string, Array<(graph: Graph) => Promise<void>>> = {
  'daily-checkin': [
    async graph => {
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      await graph.callTool('create_block', {
        parentId: today,
        content: 'Eval check-in\nDone: drafted the sync rollout plan\nNext: review the Kestrel renewal\nBlockers: none',
      })
    },
    // The check-in right, but carrying a property nobody asked for.
    async graph => {
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      const parentId = resultIdOf(await graph.callTool('create_block', {parentId: today, content: 'Eval check-in', properties: {'eval:mood': 'good'}}))
      for (const content of ['Done: drafted the sync rollout plan', 'Next: review the Kestrel renewal', 'Blockers: none']) {
        await graph.callTool('create_block', {parentId, content})
      }
    },
    // The check-in right, plus a block nobody asked for beside it.
    async graph => {
      await solveWithMcp['daily-checkin'](graph)
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      await graph.callTool('create_block', {parentId: today, content: 'Also: water the plants'})
    },
  ],
  'edit-rollout-phrase': [
    async graph => {
      await graph.callTool('update_block', {id: fixtureId('rollout'), content: 'Target: Q4 2026.'})
    },
    // The phrase right, but the block's properties touched too.
    async graph => {
      await graph.callTool('update_block', {
        id: fixtureId('rollout'),
        content: ROLLOUT_BLOCK_TEXT.replace('Q3 2026', 'Q4 2026'),
        properties: {'eval:note': 'edited'},
      })
    },
  ],
  'create-linked-page': [
    async graph => {
      const today = (JSON.parse(await graph.callTool('daily_note', {date: 'today'})) as {blockId: string}).blockId
      await graph.callTool('create_block', {parentId: today, content: `[[${VENDOR_REVIEW_TITLE}]]`})
    },
    // The page and link right, plus another block under Vendors.
    async graph => {
      await solveWithMcp['create-linked-page'](graph)
      await graph.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: '[[Kestrel]] — renewal notes'})
    },
    // The page created right, then retitled while asking to keep the old name:
    // the app moves the name with the title, so the page is no longer found.
    async graph => {
      await solveWithMcp['create-linked-page'](graph)
      const title = VENDOR_REVIEW_TITLE
      await graph.callTool('update_block', {id: await requirePageId(graph.probe, title), content: 'Kestrel review notes', properties: {alias: [title]}})
    },
    // The page created right, then given another type as well.
    async graph => {
      await solveWithMcp['create-linked-page'](graph)
      const pageId = await requirePageId(graph.probe, VENDOR_REVIEW_TITLE)
      await graph.callTool('update_block', {id: pageId, properties: {types: ['page', 'todo']}})
    },
    // The page created right, then filed under a block instead of left a page.
    async graph => {
      await solveWithMcp['create-linked-page'](graph)
      const pageId = await requirePageId(graph.probe, VENDOR_REVIEW_TITLE)
      await graph.callTool('move_block', {id: pageId, parentId: fixtureId('vendorsSection'), position: {kind: 'last'}})
    },
    // The link added twice.
    async graph => {
      await solveWithMcp['create-linked-page'](graph)
      await graph.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: `[[${VENDOR_REVIEW_TITLE}]]`})
    },
  ],
  'complete-todo': [
    // Marked done in the text, not the status.
    async graph => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), content: `{{[[DONE]]}} ${PRICING_FAQ_TODO}`})
    },
    // Status right, but the todo's text rewritten.
    async graph => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), content: 'Draft FAQ', properties: {status: 'done'}})
    },
    // Status right, plus a property nobody asked for.
    async graph => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), properties: {status: 'done', 'eval:note': 'done'}})
    },
    // Status right, but the importer's marker set to a value its enum does not have.
    async graph => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), properties: {status: 'done', 'roam:todo-state': 'done'}})
    },
    // Status right, but the todo moved off its section.
    async graph => {
      await graph.callTool('update_block', {id: fixtureId('pricingFaqTodo'), properties: {status: 'done'}})
      await graph.callTool('move_block', {id: fixtureId('pricingFaqTodo'), parentId: await requirePageId(graph.probe, PROJECT_PAGE), position: {kind: 'last'}})
    },
  ],
}

const expectOutcome = (outcome: CheckOutcome, pass: boolean) => expect(outcome.pass, outcome.detail).toBe(pass)

/** One attempt at a write task, scored as the runner scores it: on a fresh
 *  copy, the check and then the changes the task was not asked to make. */
const attempt = (task: EvalTask, solve: (graph: Graph) => Promise<void>): Promise<CheckOutcome> => onFreshGraph(async fresh => {
  const startedAt = Date.now()
  await solve(fresh)
  const {outcome, stray} = await scoreTask(task, {probe: fresh.probe, truth, answer: undefined, startedAt}, templateRows)
  return {pass: outcome.pass && stray === 0, detail: `${outcome.detail}; ${stray} stray change(s)`}
})

describe('task checks', () => {
  let derived: Record<string, unknown>
  beforeAll(async () => { derived = await deriveReadAnswers() }, 30_000)

  const readTasks = TASKS.filter(task => task.kind === 'read')
  const writeTasks = TASKS.filter(task => task.kind === 'write')
  const input = (answer: unknown, startedAt = Date.now()): CheckInput => ({probe, truth, answer, startedAt})

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

  it.each(writeTasks.map(task => [task.id, task] as const))('%s: wrong edits fail; an MCP solution passes', async (_id, task) => {
    for (const solveWrong of solveWrongly[task.id]) expectOutcome(await attempt(task, solveWrong), false)
    expectOutcome(await attempt(task, solveWithMcp[task.id]), true)
  }, 30_000)
})

describe('task changes', () => {
  it('sees every kind of change a task can make, and names the ones it was not asked for', async () => {
    await onFreshGraph(async fresh => {
      const design = await descendantsOf(fresh.probe, await requirePageId(fresh.probe, DESIGN_PAGE))
      const byText = (prefix: string) => design.find(row => row.content.startsWith(prefix))!
      const edited = byText('Devices stay offline')
      const tagged = byText('Support sees roughly')
      const removed = byText('The current protocol ships')
      const moved = byText('Migration runs per workspace')
      const rollout = fixtureId('rollout')

      await fresh.callTool('update_block', {id: edited.id, content: 'rewritten'})
      await fresh.callTool('update_block', {id: tagged.id, properties: {'eval:tag': 'x'}})
      await fresh.callTool('delete_block', {id: removed.id})
      await fresh.callTool('move_block', {id: moved.id, parentId: edited.parent_id, position: {kind: 'first'}})
      await fresh.callTool('update_block', {id: rollout, content: 'Target: Q4 2026.'})
      await fresh.callTool('create_block', {parentId: edited.id, content: 'a new child'})
      // A raw-SQL hard delete leaves no row behind to compare.
      const purged = byText('Success metric')
      await fresh.command({type: 'sql', mode: 'execute', sql: 'DELETE FROM blocks WHERE id = ?', params: [purged.id], allowSyncedWrite: true})

      const changes = await diffAgainst(fresh.probe, templateRows)
      expect(changes.created).toHaveLength(1)
      expect(changes.modified.map(change => change.id).sort())
        .toEqual([edited.id, tagged.id, removed.id, moved.id, rollout].sort())
      expect(changes.removed.map(row => row.id)).toEqual([purged.id])
      // The rollout edit is what edit-rollout-phrase is asked to make; the rest are stray.
      const rolloutContent = new Map([[rollout, {content: true} as const]])
      expect(strayChanges(changes, {edits: rolloutContent, creates: new Map()})).toBe(6)
      expect(strayChanges(changes, {edits: rolloutContent, creates: new Map([[changes.created[0].id, {}]])})).toBe(5)
      expect(strayChanges(changes, {edits: new Map(), creates: new Map()})).toBe(7)
    })
  }, 30_000)

  it('sees a page a link minted, which is born with updated_at = 0', async () => {
    await onFreshGraph(async fresh => {
      await fresh.callTool('create_block', {parentId: fixtureId('vendorsSection'), content: '[[Minted Seat Probe]]'})
      const minted = await vi.waitFor(async () => {
        const id = await pageIdByTitle(fresh.probe, 'Minted Seat Probe')
        if (!id) throw new Error('linked page not minted yet')
        return id
      }, {timeout: 5_000})
      const changes = await diffAgainst(fresh.probe, templateRows)
      expect(changes.created.map(row => row.id)).toContain(minted)
    })
  }, 20_000)
})

/** The blocks, by the names `fixtureState` gives them, on which two states differ. */
const differingBlocks = (a: readonly string[], b: readonly string[]): string[] => {
  const inA = new Set(a)
  const inB = new Set(b)
  const name = (line: string) => (JSON.parse(line) as [string])[0]
  return [...new Set([...a.filter(line => !inB.has(line)), ...b.filter(line => !inA.has(line))].map(name))]
}

describe('fixture state', () => {
  const pages = buildFixture().pages
  let before: string[]
  beforeAll(async () => { before = await fixtureState(probe, pages) }, 20_000)

  /** What `change` moves in the fixture state of a fresh copy. */
  const differenceMadeBy = (change: (graph: Graph) => Promise<unknown>) => onFreshGraph(async fresh => {
    await change(fresh)
    return differingBlocks(before, await fixtureState(fresh.probe, pages))
  })

  it('names every block by uid, so a property change shows up on that block alone', async () => {
    expect(await differenceMadeBy(async fresh =>
      fresh.callTool('update_block', {id: await requirePageId(fresh.probe, 'Halyard Security'), properties: {'roam:Status': 'active'}})))
      .toEqual(['vendor-halyard-security'])
  }, 20_000)

  it('sees a block added under a fixture page or daily note, which no exported row records', async () => {
    expect(await differenceMadeBy(async fresh => {
      await fresh.callTool('create_block', {parentId: await requirePageId(fresh.probe, PROJECT_PAGE), content: '{{[[TODO]]}} hand-written'})
      await fresh.callTool('create_block', {parentId: await dailyNoteId(fresh.probe, '2026-06-03'), content: 'Blockers: staging database again'})
    })).toEqual(expect.arrayContaining(['+{{[[TODO]]}} hand-written', '+Blockers: staging database again']))
  }, 20_000)

  it('sees a change to a daily page, whose id the import derives from its date rather than its uid', async () => {
    expect(await differenceMadeBy(async fresh =>
      fresh.callTool('update_block', {id: await dailyNoteId(fresh.probe, '2026-06-04'), properties: {'eval:note': 'x'}})))
      .toEqual(['=June 4th, 2026'])
  }, 20_000)

  it('sees a change to a page a link minted, which the export does not define', async () => {
    expect(await differenceMadeBy(async fresh =>
      fresh.callTool('update_block', {id: await requirePageId(fresh.probe, 'Vendor'), properties: {'eval:note': 'x'}})))
      .toEqual(['=Vendor'])
  }, 20_000)

  it('ignores where a page sits at the top level, which differs from one import to the next', async () => {
    expect(await differenceMadeBy(async fresh => fresh.probe.command({
      type: 'sql', mode: 'execute', sql: 'UPDATE blocks SET order_key = ? WHERE id = ?',
      params: ['zzzz', await requirePageId(fresh.probe, 'Halyard Security')], allowSyncedWrite: true,
    }))).toEqual([])
  }, 20_000)
})
