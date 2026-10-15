// @vitest-environment node
/**
 * Interleaving fuzz for undo/redo (#227): random plans of user edits (some
 * sharing an undo group), undo / redo gestures (some double-pressed, some
 * whose replay fails), with ordinary edits committing at points around each
 * replay's transaction:
 *
 *  - `ahead`  — queued on the write lock while the gesture waits for it, so
 *               they commit BEFORE the replay;
 *  - `after`  — run to completion the moment the replay's transaction settles
 *               (committed or rolled back) and before the gesture's own
 *               continuation resumes — injected at the database's
 *               `writeTransaction`, the one boundary every transaction crosses;
 *  - `behind` — launched right after the gesture, queuing behind its replay.
 *
 * and, the other way round, a gesture run to completion the moment an EDIT's
 * transaction settles, before the edit's caller resumes (`gestureBeforeResume`)
 * — the window between a commit releasing the lock and the code after it.
 *
 * The oracle is a SEQUENTIAL MODEL driven by the database's own commit order.
 * Every `repo.tx` writes one `command_events` row inside its transaction
 * (`runTx` step 4, `commitPipeline.ts`), and a replay's row is described
 * `undo: <entry description>` / `redo: …` (`Repo._replay`). Rolled-back
 * transactions leave none. So reading those rows in rowid order is the exact
 * serialization the database chose, and the model replays it:
 *
 *  - an edit commit records onto undo (merging into a top entry that shares
 *    its group, as `UndoManager.record` does) and clears redo;
 *  - a replay commit must name the entry on top of the matching stack AT THAT
 *    POINT in commit order, and every row it restores must hold the entry's
 *    far side right then — i.e. no replay ever applies a snapshot the row has
 *    since moved past; the entry then moves to the other stack.
 *
 * After every step, the database's content and the manager's depths and tops
 * must equal the model's. At the end, redo-all, undo-all and redo-all again
 * must reach the newest state, the seed content exactly, and the newest state
 * once more — the round trip an inverted or resurrected entry breaks.
 *
 * Content values are unique per edit, so no edit is a no-op and every entry's
 * rows are distinguishable. No order keys are minted after the seed, so there
 * is no `Math.random` to pin (`guard.run(null, …)`).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { fuzzParams, fuzzTestTimeout, statefulFuzzGuard } from '@/test/fuzz'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope } from '@/data/api'
import { TxImpl } from '@/data/internals/txEngine'
import type { Repo } from '@/data/repo'

const WS = 'ws-1'
const BLOCKS = ['a', 'b', 'c'] as const
const seedContent = (block: string): string => `seed-${block}`

// ──── plan ────

/** `fresh` mints a new undo-group token; `last` reuses the most recently
 *  minted one, so an edit can merge into whatever entry that group left on
 *  top — including one a gesture is about to take. */
type EditSpec = {block: number; group: 'none' | 'fresh' | 'last'}

type Interleave =
  | {at: 'none'}
  | {at: 'ahead'; edits: EditSpec[]}
  | {at: 'after'; edit: EditSpec}
  | {at: 'behind'; edit: EditSpec}

type Step =
  | {kind: 'edit'; edit: EditSpec; gestureBeforeResume: 'undo' | 'redo' | null}
  | {
    kind: 'gesture'
    action: 'undo' | 'redo'
    /** The replay's first row write throws, so it rolls back. */
    fail: boolean
    /** A second identical gesture launched before the first settles. */
    doublePress: boolean
    interleave: Interleave
  }

const editArb: fc.Arbitrary<EditSpec> = fc.record({
  block: fc.nat({max: BLOCKS.length - 1}),
  group: fc.constantFrom<EditSpec['group']>('none', 'none', 'fresh', 'last'),
})

const interleaveArb: fc.Arbitrary<Interleave> = fc.oneof(
  {weight: 2, arbitrary: fc.constant({at: 'none'} as const)},
  {weight: 3, arbitrary: fc.record({
    at: fc.constant('ahead' as const),
    edits: fc.array(editArb, {minLength: 1, maxLength: 2}),
  })},
  {weight: 3, arbitrary: fc.record({at: fc.constant('after' as const), edit: editArb})},
  {weight: 1, arbitrary: fc.record({at: fc.constant('behind' as const), edit: editArb})},
)

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  {weight: 2, arbitrary: fc.record({
    kind: fc.constant('edit' as const),
    edit: editArb,
    gestureBeforeResume: fc.constantFrom<'undo' | 'redo' | null>(null, null, null, 'undo', 'redo'),
  })},
  {weight: 3, arbitrary: fc.record({
    kind: fc.constant('gesture' as const),
    action: fc.constantFrom<'undo' | 'redo'>('undo', 'redo'),
    fail: fc.nat({max: 3}).map(n => n === 0),
    doublePress: fc.nat({max: 5}).map(n => n === 0),
    interleave: interleaveArb,
  })},
)

/** ≤ 24 steps of ≤ 2 edits each stays far inside the undo stack's depth (100),
 *  so nothing falls off the bottom and undo-all provably reaches the seed. */
const planArb = fc.array(stepArb, {minLength: 1, maxLength: 24})

// ──── the model ────

interface ModelEntry {
  desc: string
  groupId?: string
  rows: Map<string, {before: string; after: string}>
}

interface EditRecord {block: string; value: string; groupId?: string}

class SequentialModel {
  readonly content = new Map<string, string>(BLOCKS.map(b => [b, seedContent(b)]))
  readonly undo: ModelEntry[] = []
  readonly redo: ModelEntry[] = []

  edit(desc: string, {block, value, groupId}: EditRecord): void {
    const before = this.content.get(block)!
    this.content.set(block, value)
    this.redo.length = 0
    const top = this.undo.at(-1)
    if (groupId !== undefined && top?.groupId === groupId) {
      const row = top.rows.get(block)
      top.rows.set(block, {before: row?.before ?? before, after: value})
      top.desc = desc
      return
    }
    this.undo.push({desc, groupId, rows: new Map([[block, {before, after: value}]])})
  }

  replay(action: 'undo' | 'redo', desc: string, context: string): void {
    const from = action === 'undo' ? this.undo : this.redo
    const onto = action === 'undo' ? this.redo : this.undo
    const top = from.pop()
    expect(top?.desc, `${context}: ${action} replayed ${desc}, but in commit order the top of ${action} was ${top?.desc ?? 'nothing'}`)
      .toBe(desc)
    for (const [block, {before, after}] of top!.rows) {
      const [far, near] = action === 'undo' ? [after, before] : [before, after]
      expect(this.content.get(block), `${context}: ${action} of ${desc} restored ${block} from a state it no longer held`)
        .toBe(far)
      this.content.set(block, near)
    }
    onto.push(top!)
  }
}

// ──── harness ────

let sharedDb: TestDb
let activeHarness: CaseHarness | null = null
beforeAll(async () => {
  sharedDb = await createTestDb()
  // A replay's row writes are its only `applyRaw` calls, so failing the first
  // one fails the replay and rolls it back.
  const realApplyRaw = TxImpl.prototype.applyRaw
  vi.spyOn(TxImpl.prototype, 'applyRaw').mockImplementation(
    async function (this: TxImpl, ...args: Parameters<typeof realApplyRaw>) {
      if (activeHarness?.failNextReplay) {
        activeHarness.failNextReplay = false
        throw REPLAY_FAILURE
      }
      return realApplyRaw.apply(this, args)
    })
})
afterAll(async () => {
  await guard.barrier()
  vi.restoreAllMocks()
  await sharedDb.cleanup()
})

/** Interrupt barrier for the shared DB — see `statefulFuzzGuard`
 *  (`@/test/fuzz`, docs/fuzzing.md §6). */
const guard = statefulFuzzGuard()

const REPLAY_FAILURE = new Error('[fuzz] injected replay failure')

class CaseHarness {
  readonly model = new SequentialModel()
  private readonly edits = new Map<string, EditRecord>()
  private editCount = 0
  private groupCount = 0
  private lastRowid = 0
  /** Replay commits read from the log, and gestures that answered true. Every
   *  successful gesture is exactly one committed replay. */
  replaysCommitted = 0
  gesturesReplayed = 0
  failNextReplay = false

  constructor(readonly repo: Repo) {}

  /** Mint the edit's identity NOW, at launch, so the plan resolves the same
   *  way however the transactions interleave. */
  private prepare(spec: EditSpec): {desc: string; record: EditRecord} {
    const desc = `e${++this.editCount}`
    let groupId: string | undefined
    if (spec.group === 'fresh' || (spec.group === 'last' && this.groupCount === 0)) {
      groupId = `g${++this.groupCount}`
    } else if (spec.group === 'last') {
      groupId = `g${this.groupCount}`
    }
    const record = {block: BLOCKS[spec.block], value: `v${this.editCount}`, groupId}
    this.edits.set(desc, record)
    return {desc, record}
  }

  /** `groupId` is what `repo.undoGroup`'s facade injects; set here directly
   *  so a group can span steps with gestures between them. */
  edit(spec: EditSpec, hold?: Promise<void>): Promise<void> {
    const {desc, record} = this.prepare(spec)
    return this.repo.tx(async (tx) => {
      if (hold) await hold
      await tx.update(record.block, {content: record.value})
    }, {scope: ChangeScope.BlockDefault, description: desc, groupId: record.groupId})
  }

  /** An edit that holds the write lock until released — anything launched
   *  meanwhile queues behind it. */
  async editHoldingLock(spec: EditSpec): Promise<{settled: Promise<void>; release: () => void}> {
    let release: (() => void) | null = null
    let holding = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const settled = this.edit(spec, (async () => { holding = true; await gate })())
    await vi.waitFor(() => { expect(holding).toBe(true) }, {timeout: 3000})
    return {settled, release: () => { release!() }}
  }

  /** Answer of one gesture: true / false, or the injected failure. Anything
   *  else is a real error and fails the case. */
  async gesture(action: 'undo' | 'redo'): Promise<void> {
    try {
      if (await (action === 'undo' ? this.repo.undo() : this.repo.redo())) this.gesturesReplayed++
    } catch (err) {
      if (err !== REPLAY_FAILURE) throw err
    }
  }

  /** Everything committed so far predates the plan. */
  async skipCommittedSoFar(): Promise<void> {
    const row = await sharedDb.db.get<{n: number | null}>('SELECT MAX(rowid) AS n FROM command_events')
    this.lastRowid = row.n ?? 0
  }

  /** Feed the model every commit since the last call, in commit order. */
  async syncModel(context: string): Promise<void> {
    const rows = await sharedDb.db.getAll<{rowid: number; description: string | null}>(
      `SELECT rowid, description FROM command_events
        WHERE rowid > ? AND scope = ? ORDER BY rowid`,
      [this.lastRowid, ChangeScope.BlockDefault],
    )
    for (const {rowid, description} of rows) {
      this.lastRowid = rowid
      const replay = /^(undo|redo): (e\d+)$/.exec(description ?? '')
      if (replay) {
        this.replaysCommitted++
        this.model.replay(replay[1] as 'undo' | 'redo', replay[2], context)
        continue
      }
      const edit = this.edits.get(description ?? '')
      if (!edit) throw new Error(`${context}: unexpected BlockDefault commit ${JSON.stringify(description)}`)
      this.model.edit(description!, edit)
    }
  }

  async expectMatchesModel(context: string): Promise<void> {
    await this.syncModel(context)
    expect(await this.content(), `${context}: content`).toEqual(this.model.content)
    const manager = this.repo.undoManager
    expect(manager.depths(ChangeScope.BlockDefault), `${context}: depths`).toEqual({
      undo: this.model.undo.length,
      redo: this.model.redo.length,
    })
    expect(manager.peekUndo(ChangeScope.BlockDefault)?.description, `${context}: undo top`)
      .toBe(this.model.undo.at(-1)?.desc)
    expect(manager.peekRedo(ChangeScope.BlockDefault)?.description, `${context}: redo top`)
      .toBe(this.model.redo.at(-1)?.desc)
    expect(this.gesturesReplayed, `${context}: successful gestures vs committed replays`)
      .toBe(this.replaysCommitted)
  }

  async content(): Promise<Map<string, string>> {
    const rows = await sharedDb.db.getAll<{id: string; content: string}>(
      `SELECT id, content FROM blocks WHERE id IN (${BLOCKS.map(() => '?').join(', ')})`,
      [...BLOCKS],
    )
    return new Map(rows.map(r => [r.id, r.content]))
  }
}

/** Run `between` once the NEXT write transaction settles — committed or rolled
 *  back, its lock released — and before that transaction's caller resumes.
 *  Patched on the raw database, which the Repo's metrics proxy calls through on
 *  every transaction. `disarm` removes it if no transaction came. */
const onNextWriteSettled = (between: () => Promise<void>): {fired: () => boolean; disarm: () => void} => {
  const db = sharedDb.db as unknown as {writeTransaction: (...args: unknown[]) => Promise<unknown>}
  const real = db.writeTransaction.bind(db)
  let fired = false
  const disarm = () => { delete (db as Record<string, unknown>).writeTransaction }
  db.writeTransaction = async (...args: unknown[]) => {
    disarm()
    try {
      return await real(...args)
    } finally {
      fired = true
      await between()
    }
  }
  return {fired: () => fired, disarm}
}

const runStep = async (h: CaseHarness, step: Step): Promise<void> => {
  // A processor's own transaction must not be the one a settle hook takes.
  await h.repo.awaitProcessors()
  if (step.kind === 'edit') {
    const action = step.gestureBeforeResume
    if (action === null) {
      await h.edit(step.edit)
      return
    }
    // Only the edit's own transaction comes next: nothing else is in flight.
    const hook = onNextWriteSettled(() => h.gesture(action))
    await h.edit(step.edit)
    expect(hook.fired(), 'the edit transaction settles the hook').toBe(true)
    return
  }
  h.failNextReplay = step.fail
  const inFlight: Promise<void>[] = []
  const {interleave} = step
  try {
    if (interleave.at === 'ahead') {
      const [first, ...rest] = interleave.edits
      const holder = await h.editHoldingLock(first)
      inFlight.push(holder.settled, ...rest.map(e => h.edit(e)))
      inFlight.push(h.gesture(step.action))
      if (step.doublePress) inFlight.push(h.gesture(step.action))
      holder.release()
    } else if (interleave.at === 'after') {
      const hook = onNextWriteSettled(() => h.edit(interleave.edit))
      inFlight.push(h.gesture(step.action))
      if (step.doublePress) inFlight.push(h.gesture(step.action))
      try {
        await Promise.all(inFlight)
      } finally {
        // The gesture answered without a transaction: nothing on the stack.
        if (!hook.fired()) hook.disarm()
      }
    } else {
      inFlight.push(h.gesture(step.action))
      if (step.doublePress) inFlight.push(h.gesture(step.action))
      if (interleave.at === 'behind') inFlight.push(h.edit(interleave.edit))
    }
    await Promise.all(inFlight)
  } finally {
    h.failNextReplay = false
  }
}

const drain = async (h: CaseHarness, action: 'undo' | 'redo'): Promise<void> => {
  for (let i = 0; i < 200; i++) {
    const replayed = await (action === 'undo' ? h.repo.undo() : h.repo.redo())
    if (replayed) h.gesturesReplayed++
    await h.expectMatchesModel(`${action}-all #${i}`)
    if (!replayed) return
  }
  throw new Error(`${action}-all did not terminate`)
}

const runCase = async (plan: Step[]): Promise<void> => {
  await resetTestDb(sharedDb.db)
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(WS)
  await repo.tx(async (tx) => {
    for (const [i, id] of BLOCKS.entries()) {
      await tx.create({id, workspaceId: WS, parentId: null, orderKey: `a${i}`, content: seedContent(id)})
    }
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
  repo.undoManager.clear()
  const h = new CaseHarness(repo)
  await h.skipCommittedSoFar()
  activeHarness = h
  try {
    for (const [i, step] of plan.entries()) {
      await runStep(h, step)
      await h.expectMatchesModel(`step ${i} ${JSON.stringify(step)}`)
    }
    // The plan can leave entries on redo, so the far end of history is where
    // redo-all goes from here — and must be where it goes back to from the seed.
    await drain(h, 'redo')
    const newest = await h.content()
    await drain(h, 'undo')
    expect(await h.content(), 'undo-all reaches the seed').toEqual(
      new Map(BLOCKS.map(b => [b, seedContent(b)])))
    await drain(h, 'redo')
    expect(await h.content(), 'redo-all from the seed returns to the newest state').toEqual(newest)
  } finally {
    activeHarness = null
    await repo.awaitProcessors()
  }
}

describe('undo/redo interleaved with commits landing around the replay (#227)', () => {
  it('keep the stacks in commit order and round-trip to the seed', async () => {
    await fc.assert(
      fc.asyncProperty(planArb, plan => guard.run(null, () => runCase(plan))),
      fuzzParams(12),
    )
  }, fuzzTestTimeout())
})
