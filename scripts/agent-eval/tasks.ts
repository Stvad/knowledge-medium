/**
 * The eval's tasks: the common jobs an agent does on a notes graph, each
 * with an automatic check. Read tasks are scored on the reply's final
 * `ANSWER: {json}` line against the fixture's ground truth; write tasks on
 * the graph state afterwards, read through raw wire commands and SQL.
 *
 * A task's wording is part of the measurement: changing it invalidates
 * comparisons with earlier reports, so add a task rather than rewording one.
 */
import { roamBlockId } from '@/plugins/roam-import/blockIds'
import {
  DESIGN_PAGE,
  type FixtureTruth,
  KESTREL_SIGNALS,
  PRICING_FAQ_TODO,
  PROJECT_PAGE,
  READING_LOG_PAGE,
  ROLLOUT_BLOCK_TEXT,
  TARGET_UIDS,
} from './fixture'
import {
  childrenOf,
  dailyNoteId,
  getBlock,
  type GraphProbe,
  pageIdByTitle,
  purgeBlocks,
  sqlAll,
} from './graphQueries'
import type { AllowedChanges, AllowedEdit } from './isolation'
import { definitionHash } from './report'

export interface TaskEnv {
  probe: GraphProbe
  truth: FixtureTruth
  /** Short tag unique to this execution, for names a re-run must not collide with. */
  runTag: string
}

export interface CheckInput extends TaskEnv {
  /** Parsed `ANSWER:` JSON from the reply, undefined when absent or malformed. */
  answer: unknown
  /** Wall-clock ms just before the agent started. */
  startedAt: number
}

export interface CheckOutcome {
  pass: boolean
  detail: string
  /** The blocks the check accepted as the ones the task was asked to create,
   *  each with exactly the properties it must carry. Any other block the run
   *  created, or other properties on one of these, is a change it was not
   *  asked to make. */
  created?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export interface EvalTask {
  id: string
  kind: 'read' | 'write'
  /** The everyday job this task stands for. */
  covers: string
  prompt: (env: TaskEnv) => string
  /** The fixture blocks this task is asked to change, by Roam uid, and which
   *  of their fields. Any other change fails the task (see
   *  `CheckOutcome.created`); the runner undoes all of them either way. */
  edits?: Readonly<Record<string, AllowedEdit>>
  /** Clears what an interrupted earlier run of this task may have left and
   *  sets up its preconditions; the runner calls it before snapshotting.
   *  Must be idempotent. */
  reset?: (env: TaskEnv) => Promise<void>
  check: (input: CheckInput) => Promise<CheckOutcome>
}

/** Bump when a helper the checks share changes (normalizeText, compareSets,
 *  …): a task's hash covers only its own definition. */
const SHARED_SCORING_VERSION = 3

/** The values checks close over, which their source text only names. Shared
 *  by every task's hash: changing any of them may change any task's verdict. */
const scoringData = (truth: FixtureTruth) => JSON.parse(JSON.stringify(
  {truth, KESTREL_SIGNALS, TARGET_UIDS, ROLLOUT_BLOCK_TEXT, PRICING_FAQ_TODO},
  (_key, value: unknown) => (value instanceof RegExp ? {regex: value.source, flags: value.flags} : value),
)) as unknown

/** Identifies the setup every run performs: all tasks' resets run before a
 *  run's one snapshot, whichever tasks it selects. */
export const setupHash = (): string => definitionHash(TASKS.map(task => task.reset?.toString() ?? null))

/** Identifies what a task measures, so a report only compares a task with an
 *  earlier run of the same definition. */
export const taskDefinitionHash = (task: EvalTask, truth: FixtureTruth): string => definitionHash({
  shared: SHARED_SCORING_VERSION,
  scoring: scoringData(truth),
  kind: task.kind,
  prompt: task.prompt({probe: {workspaceId: '', command: async () => null}, truth, runTag: '<tag>'}),
  check: task.check.toString(),
  reset: task.reset?.toString() ?? null,
  edits: task.edits ?? {},
})

const PREAMBLE =
  'You have access to a Knowledge Medium notes graph (an outliner of pages and nested blocks, '
  + 'with [[wikilinks]] and one daily note per day) through the km tools.'

const readPrompt = (question: string, answerShape: string) =>
  `${PREAMBLE}\n\n${question}\n\nWhen you are done, end your reply with exactly one line of the form\n`
  + `ANSWER: ${answerShape}`

const writePrompt = (instruction: string) =>
  `${PREAMBLE}\n\n${instruction}\n\nWhen you are done, end your reply with the line\nANSWER: {"done": true}`

/** Lower-cased, link/tag/todo-marker syntax stripped, whitespace collapsed. */
export const normalizeText = (text: string): string => text
  .toLowerCase()
  .replace(/\{\{\s*\[\[(todo|done)\]\]\s*\}\}/g, ' ')
  .replace(/\[\[|\]\]|#/g, '')
  .replace(/\s+/g, ' ')
  .replace(/[\s.;:]+$/, '')
  .trim()

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every(item => typeof item === 'string') ? value : null

/** Exact-set comparison after `normalize`, with a detail naming the gap. */
export const compareSets = (
  got: readonly string[],
  want: readonly string[],
  normalize: (text: string) => string = normalizeText,
): CheckOutcome => {
  const gotSet = new Set(got.map(normalize))
  const wantSet = new Set(want.map(normalize))
  const missing = [...wantSet].filter(item => !gotSet.has(item))
  const extra = [...gotSet].filter(item => !wantSet.has(item))
  const pass = missing.length === 0 && extra.length === 0
  return {
    pass,
    detail: pass
      ? `all ${wantSet.size} matched`
      : `${wantSet.size - missing.length}/${wantSet.size} found; missing [${missing.join(', ')}]; extra [${extra.join(', ')}]`,
  }
}

const noAnswer: CheckOutcome = {pass: false, detail: 'no parseable ANSWER line'}

const answerField = <T>(answer: unknown, field: string, read: (value: unknown) => T | null): T | null =>
  isRecord(answer) ? read(answer[field]) : null

const isoDates = (value: unknown) => stringList(value)?.map(date => date.trim()) ?? null

/** The block id a fixture block's Roam uid imports to in this workspace. */
export const targetId = (workspaceId: string, uid: string) => roamBlockId(workspaceId, uid)

/** What a run of `task` was allowed to change, given its check's outcome. */
export const allowedChanges = (task: EvalTask, workspaceId: string, outcome: CheckOutcome): AllowedChanges => ({
  edits: new Map(Object.entries(task.edits ?? {}).map(([uid, edit]) => [targetId(workspaceId, uid), edit])),
  creates: new Map(Object.entries(outcome.created ?? {})),
})

const requireTarget = async (probe: GraphProbe, uid: string) => {
  const block = await getBlock(probe, targetId(probe.workspaceId, uid))
  if (!block) throw new Error(`fixture block ${uid} not found — is the fixture seeded? (pnpm agent-eval seed)`)
  return block
}

const VENDOR_REVIEW_PREFIX = 'Vendor Review: Kestrel'
export const vendorReviewTitle = (runTag: string) => `${VENDOR_REVIEW_PREFIX} ${runTag}`

/** Purges blocks anywhere in the workspace whose content matches a LIKE
 *  pattern, deleted ones included. */
const purgeLike = async (probe: GraphProbe, pattern: string) => {
  const rows = await sqlAll<{id: string}>(probe,
    'SELECT id FROM blocks WHERE workspace_id = ? AND content LIKE ?', [probe.workspaceId, pattern])
  await purgeBlocks(probe, rows.map(row => row.id))
}

export const TASKS: readonly EvalTask[] = [
  {
    id: 'kestrel-june',
    kind: 'read',
    covers: 'find what was noted about a topic in a date window',
    prompt: () => readPrompt(
      'Which daily notes from June 2026 (2026-06-01 through 2026-06-30) mention the vendor Kestrel, '
      + 'and what was noted about Kestrel on each of those days? Include every such date.',
      '{"dates": ["YYYY-MM-DD", ...], "about": {"YYYY-MM-DD": "<what was noted>", ...}}',
    ),
    check: async ({answer, truth}) => {
      const dates = answerField(answer, 'dates', isoDates)
      if (!dates || !isRecord(answer) || !isRecord(answer.about)) return noAnswer
      const datesOutcome = compareSets(dates, truth.kestrelJuneDates)
      const about = answer.about
      const misread = truth.kestrelJuneDates.filter(date => {
        const note = about[date]
        return typeof note !== 'string'
          || !truth.kestrelJuneSignals[date].some(signal => KESTREL_SIGNALS[signal].test(note))
      })
      return {
        pass: datesOutcome.pass && misread.length === 0,
        detail: `dates: ${datesOutcome.detail}; ${misread.length === 0 ? 'every mention summarized' : `wrong or missing summary for [${misread.join(', ')}]`}`,
      }
    },
  },
  {
    id: 'summarize-design',
    kind: 'read',
    covers: 'summarize a page',
    prompt: () => readPrompt(
      `Summarize the page "${DESIGN_PAGE}": which approach it adopted and which it rejected, who wrote it, `
      + 'and how many open questions it lists.',
      '{"author": "<name>", "adopted": "<approach adopted>", "rejected": "<approach rejected>", "openQuestions": <number>}',
    ),
    check: async ({answer, truth}) => {
      if (!isRecord(answer)) return noAnswer
      const field = (value: unknown) => (typeof value === 'string' ? value : '')
      const {author, adopted, rejected} = truth.design
      const results = {
        author: normalizeText(field(answer.author)).includes(normalizeText(author)),
        // Both directions are required: a reversed answer names the right
        // words in the wrong fields. A field may also name the other approach
        // (the page itself says LWW "instead of a CRDT"), so a deliberately
        // mixed reversal passes: accepted as the limit of keyword scoring.
        adopted: adopted.test(field(answer.adopted)),
        rejected: rejected.test(field(answer.rejected)),
        openQuestions: answer.openQuestions === truth.design.openQuestions,
      }
      const failed = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name)
      return {pass: failed.length === 0, detail: failed.length === 0 ? 'author, both approaches, count right' : `wrong: ${failed.join(', ')}`}
    },
  },
  {
    id: 'standup-blockers',
    kind: 'read',
    covers: '"where is X referenced, and in what context" over bare [[page]] backlinks',
    prompt: () => readPrompt(
      'Standups are recorded as [[Standup]] blocks on the daily notes. '
      + 'On which dates did a standup report a blocker involving the staging database?',
      '{"dates": ["YYYY-MM-DD", ...]}',
    ),
    check: async ({answer, truth}) => {
      const dates = answerField(answer, 'dates', isoDates)
      return dates ? compareSets(dates, truth.stagingBlockerDates) : noAnswer
    },
  },
  {
    id: 'orchard-open-todos',
    kind: 'read',
    covers: 'list open todos under a page',
    prompt: () => readPrompt(
      `List the open (not done) todos on the page "${PROJECT_PAGE}", including nested ones. `
      + 'Leave out todos on other pages that only link to it.',
      '{"todos": ["<todo text>", ...]}',
    ),
    check: async ({answer, truth}) => {
      const todos = answerField(answer, 'todos', stringList)
      return todos ? compareSets(todos, truth.openOrchardTodos) : noAnswer
    },
  },
  {
    id: 'reading-log-needle',
    kind: 'read',
    covers: 'find one entry on a page with thousands of children',
    prompt: () => readPrompt(
      `The page "${READING_LOG_PAGE}" has an entry for the book "The Quiet Lattice". `
      + 'What rating did it get, and who recommended it?',
      '{"rating": <number>, "recommendedBy": "<name>"}',
    ),
    check: async ({answer, truth}) => {
      if (!isRecord(answer)) return noAnswer
      const rating = answer.rating === truth.needleBook.rating
      const recommender = typeof answer.recommendedBy === 'string'
        && normalizeText(answer.recommendedBy).includes(normalizeText(truth.needleBook.recommendedBy))
      return {
        pass: rating && recommender,
        detail: rating && recommender ? 'rating and recommender right' : `rating ${rating ? 'ok' : 'wrong'}, recommender ${recommender ? 'ok' : 'wrong'}`,
      }
    },
  },
  {
    id: 'renewal-vendors',
    kind: 'read',
    covers: 'query by property values',
    prompt: () => readPrompt(
      'Which vendors (pages that are a [[Vendor]]) currently have the Status "renewal due"?',
      '{"vendors": ["<vendor page title>", ...]}',
    ),
    check: async ({answer, truth}) => {
      const vendors = answerField(answer, 'vendors', stringList)
      return vendors ? compareSets(vendors, truth.renewalDueVendors) : noAnswer
    },
  },
  {
    id: 'meetings-with-person',
    kind: 'read',
    covers: 'count references to a person in a date window, when each reference is a bare child line',
    prompt: () => readPrompt(
      'Meetings are recorded as [[Meeting]] blocks on the daily notes, each with a "with [[Person]]" child. '
      + 'How many meetings did I have with Ines Varga in July 2026, and on which dates?',
      '{"count": <number>, "dates": ["YYYY-MM-DD", ...]}',
    ),
    check: async ({answer, truth}) => {
      if (!isRecord(answer)) return noAnswer
      const dates = isoDates(answer.dates)
      if (!dates) return noAnswer
      const datesOutcome = compareSets(dates, [...new Set(truth.julyMeetingsWithInes)])
      const countOk = answer.count === truth.julyMeetingsWithInes.length
      return {
        pass: countOk && datesOutcome.pass,
        detail: `count ${countOk ? 'right' : `${JSON.stringify(answer.count)} (want ${truth.julyMeetingsWithInes.length})`}; dates: ${datesOutcome.detail}`,
      }
    },
  },
  {
    id: 'reading-log-filter',
    kind: 'read',
    covers: 'filter the entries of a page with thousands of children',
    prompt: () => readPrompt(
      `On the page "${READING_LOG_PAGE}", which books were rated 5/5 and recommended by Tomas Reyes?`,
      '{"titles": ["<book title>", ...]}',
    ),
    check: async ({answer, truth}) => {
      const titles = answerField(answer, 'titles', stringList)
      return titles ? compareSets(titles, truth.tomasFiveStarBooks) : noAnswer
    },
  },
  {
    id: 'daily-checkin',
    kind: 'write',
    covers: "append a structured note to today's daily note",
    prompt: () => writePrompt(
      "Add a check-in to today's daily note: a new top-level block on today's daily note that reads "
      + '"Eval check-in", with exactly three child blocks in this order: '
      + '"Done: drafted the sync rollout plan", "Next: review the Kestrel renewal", "Blockers: none".',
    ),
    // A run that crosses local midnight leaves later executions without
    // that day's note: accepted, as a run takes minutes.
    reset: async ({probe}) => {
      await purgeLike(probe, 'Eval check-in%')
      // `daily-note` resolves the id without creating the note, and without
      // the note the task cannot be done at all (`create_block` refuses a
      // missing parent) — a failure of the setup, not of the agent.
      if (!(await probe.command({type: 'daily-note', date: 'today'}) as {exists: boolean}).exists) {
        await probe.command({type: 'run-action', id: 'open_today'})
      }
    },
    check: async ({probe, startedAt}) => {
      const today = await dailyNoteId(probe, 'today')
      const added = (await childrenOf(probe, today))
        .filter(row => row.created_at >= startedAt && normalizeText(row.content) === 'eval check-in')
      if (added.length !== 1) return {pass: false, detail: `found ${added.length} new "Eval check-in" blocks on today's note`}
      const children = await childrenOf(probe, added[0].id)
      return {
        ...compareOrdered(children.map(row => row.content), [
          'Done: drafted the sync rollout plan',
          'Next: review the Kestrel renewal',
          'Blockers: none',
        ]),
        created: Object.fromEntries([added[0], ...children].map(row => [row.id, {}])),
      }
    },
  },
  {
    id: 'edit-rollout-phrase',
    kind: 'write',
    covers: 'edit one phrase inside an existing block',
    prompt: () => writePrompt(
      `On the page "${DESIGN_PAGE}", the rollout block says the target is Q3 2026. `
      + 'Change it to Q4 2026, leaving the rest of that block exactly as it is.',
    ),
    edits: {[TARGET_UIDS.rollout]: {content: true}},
    reset: async ({probe}) => {
      const block = await requireTarget(probe, TARGET_UIDS.rollout)
      if (block.content !== ROLLOUT_BLOCK_TEXT) {
        await probe.command({type: 'update-block', id: block.id, content: ROLLOUT_BLOCK_TEXT})
      }
    },
    check: async ({probe}) => {
      const block = await requireTarget(probe, TARGET_UIDS.rollout)
      const expected = ROLLOUT_BLOCK_TEXT.replace('Q3 2026', 'Q4 2026')
      return block.content === expected
        ? {pass: true, detail: 'phrase replaced'}
        : {pass: false, detail: `content is ${JSON.stringify(block.content)}`}
    },
  },
  {
    id: 'create-linked-page',
    kind: 'write',
    covers: 'create a page and link to it',
    prompt: ({runTag}) => writePrompt(
      `Create a new page titled "${vendorReviewTitle(runTag)}" whose first block says "Status: under review". `
      + `Then link to it from the "${PROJECT_PAGE}" page: under that page's "Vendors" section block, `
      + `add a child block containing [[${vendorReviewTitle(runTag)}]].`,
    ),
    reset: async ({probe}) => {
      await purgeLike(probe, `%[[${VENDOR_REVIEW_PREFIX}%`)
      await purgeLike(probe, `${VENDOR_REVIEW_PREFIX}%`)
    },
    check: async ({probe, runTag, startedAt}) => {
      const title = vendorReviewTitle(runTag)
      const pageId = await pageIdByTitle(probe, title)
      if (!pageId) return {pass: false, detail: 'page does not exist'}
      const [{parent_id: pageParent}] = await sqlAll<{parent_id: string | null}>(probe, 'SELECT parent_id FROM blocks WHERE id = ?', [pageId])
      if (pageParent !== null) return {pass: false, detail: 'the page was filed under a block, not left a page'}
      const first = (await childrenOf(probe, pageId))[0]
      const statusOk = first !== undefined && normalizeText(first.content) === 'status: under review'
      const links = (await childrenOf(probe, targetId(probe.workspaceId, TARGET_UIDS.vendorsSection)))
        .filter(row => row.created_at >= startedAt && row.content.includes(`[[${title}]]`))
      const linkOk = links.length === 1
      return {
        pass: statusOk && linkOk,
        detail: `first block ${statusOk ? 'ok' : `is ${JSON.stringify(first?.content ?? null)}`}; ${links.length} link(s) under Vendors`,
        // A page carries the type and alias the app gives every page, nothing more.
        created: Object.fromEntries([[pageId, {types: ['page'], alias: [title]}], ...[...(first ? [first] : []), ...links].map(row => [row.id, {}])]),
      }
    },
  },
  {
    id: 'complete-todo',
    kind: 'write',
    covers: 'change a todo’s state',
    prompt: () => writePrompt(`On the page "${PROJECT_PAGE}", mark the todo "${PRICING_FAQ_TODO}" as done.`),
    // The importer's own todo marker may follow the status.
    edits: {[TARGET_UIDS.pricingFaqTodo]: {properties: ['status', 'roam:todo-state']}},
    reset: async ({probe}) => {
      const todo = await requireTarget(probe, TARGET_UIDS.pricingFaqTodo)
      await probe.command({
        type: 'update-block',
        id: todo.id,
        content: PRICING_FAQ_TODO,
        properties: {status: 'open', 'roam:todo-state': 'TODO'},
      })
    },
    check: async ({probe}) => {
      const todo = await requireTarget(probe, TARGET_UIDS.pricingFaqTodo)
      const status = todo.properties.status
      const textKept = todo.content === PRICING_FAQ_TODO
      const marker = todo.properties['roam:todo-state']
      const markerValid = marker === undefined || marker === 'TODO' || marker === 'DONE'
      return {
        pass: status === 'done' && textKept && markerValid,
        detail: `status is ${JSON.stringify(status ?? null)}; text ${textKept ? 'unchanged' : `is ${JSON.stringify(todo.content)}`}`
          + (markerValid ? '' : `; roam:todo-state is ${JSON.stringify(marker)}`),
      }
    },
  },
]

const compareOrdered = (got: readonly string[], want: readonly string[]): CheckOutcome => {
  const pass = got.length === want.length && got.every((item, i) => normalizeText(item) === normalizeText(want[i]))
  return {pass, detail: pass ? 'structure matches' : `children are ${JSON.stringify(got)}`}
}
