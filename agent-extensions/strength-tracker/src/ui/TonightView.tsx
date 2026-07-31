/** Tonight's prescription + fast logging.
 *
 *  The workout is *materialized* into blocks on the first settled edit, and
 *  every set is then a block edited in place — so a reload, tab switch, or
 *  second device just re-reads the same synced blocks, and switching A/B is
 *  non-destructive (each session is its own live block). Numeric edits
 *  persist on blur, done-taps persist immediately, and "Finish" reconciles
 *  the whole draft to blocks, prunes un-accepted sets, and flips the workout
 *  to done.
 */

import {useEffect, useRef, useState} from 'react'

import type {Repo} from '@/data/repo.js'
import {openDialog} from '@/utils/dialogs.js'
import {useBlockOpener} from '@/utils/navigation.js'

import {detectPendingLayoff, layoffAlreadyRecorded, layoffFromPending} from '../engine/reentry'
import {detectLeftRightAsymmetry} from '../engine/shoulder'
import type {ExerciseVideo, SessionType} from '../engine/types'
import {altOptionKey} from '../engine/types'
import {SHOULDER_POLICY_BLOCK_ID} from '../km/fields'
import {preferredLive} from '../km/history'
import type {LiveWorkout} from '../km/history'
import {
  discardWorkout,
  finishWorkout,
  materializeExercise,
  startWorkout,
  writeSet,
  writeShoulderTodo,
} from '../km/store'
import {ShoulderChecklistDialog} from './ShoulderChecklistDialog'
import type {ProgramState} from './useProgram'
import {
  applyIdPatch,
  createWriteCoordinator,
  type IdPatch,
  type WriteCoordinator,
  type WriteEffects,
} from './writeCoordinator'
import {
  buildDraft,
  hasAcceptedSets,
  overlayLive,
  prescriptionShape,
  rowKey,
  setKey,
  toExerciseDraft,
  toMaterializeDraft,
  type DraftExercise,
  type DraftSet,
} from './draft'

const SESSION_LABELS: Record<SessionType, string> = {A: 'A · upper', B: 'B · lower', mini: 'mini'}
/** Named so a successful retry can take it back down — leaving it up after
 *  the tap worked would invite a second, reversing tap. */
const WRITE_FAILED = 'Could not save that — check the connection and tap it again.'
/** Finish gave up because the session moved under it. Sets already written
 *  DID land — say so, rather than implying nothing was logged. */
const SESSION_MOVED =
  'Session changed while saving — what you logged is kept, but this session was not finished.'

/** Which session and workout an operation was started against, captured at
 *  the tap and carried — reconstructing it when the promise settles is how a
 *  write ends up reported on the wrong evening. */
interface OpContext {
  /** Monotonic per view — lets two writes to the SAME field of the SAME set
   *  be told apart, since keying on the change alone would let an older
   *  success take down a newer failure. */
  id: number
  slot: string
  workout: string | null
  setKey: string
  fields: string
}
const SHOULDER_CHECK_EVERY = 4

interface Props {
  repo: Repo
  workspaceId: string
  pageId: string
  program: ProgramState
}

export function TonightView({repo, workspaceId, pageId, program}: Props) {
  const {prescription, session, setSession, config, history, layoffs, liveWorkouts, liveLoaded, configLoaded, day} = program
  const readOnly = repo.isReadOnly
  const unit = config.unit
  // One subscription for the whole view — the duplicate-session warning below
  // opens each duplicate from an onClick, not from a hook per list item.
  const openBlock = useBlockOpener()

  const tonights = liveWorkouts.filter(w => w.day === day && w.session === session)
  const live = preferredLive(tonights)
  /** More than one unfinished session for tonight — this view can only log
   *  into one of them. A repeat session is MINTED rather than derived (see
   *  `startWorkout`), so duplicates are visible rather than silently merged. */
  const duplicates = tonights.length - 1
  /** The duplicates themselves, minus whichever `preferredLive` picked to
   *  drive this screen. Not necessarily filed under this page — `liveWorkouts`
   *  is workspace-wide — so "Open" rather than "see below" is always true. */
  const duplicateWorkouts = tonights.filter(w => w.id !== live?.id)

  const [draft, setDraft] = useState<DraftExercise[]>(() => overlayLive(buildDraft(prescription, unit), live))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  /** Bumped to force the overlay to re-run when no query emission is coming —
   *  after a write fails, nothing changed on the block, so none would arrive. */
  const [resync, setResync] = useState(0)

  // Mirrored into a ref so edit handlers can persist the freshly-computed
  // next state without waiting for a re-render.
  const draftRef = useRef(draft)
  draftRef.current = draft

  /** Sets with a write in flight — the block is momentarily behind what the
   *  user just did, and the live overlay must not "correct" it back. Keyed on
   *  `setKey`, not the block id, since the first write of the night is made
   *  by the tap that CREATES the block. COUNTED, not a plain set: typing reps
   *  then tapping done overlaps two writes on one set. */
  /** The live workout this view has actually SEEN in an emission, as opposed
   *  to one it created and is waiting on — never seen means the query is
   *  behind, seen and now gone means it is gone. */
  const seenLiveRef = useRef<string | null>(null)

  const inFlightRef = useRef(new Map<string, number>())
  const beginWrite = (key: string) =>
    inFlightRef.current.set(key, (inFlightRef.current.get(key) ?? 0) + 1)
  const endWrite = (key: string) => {
    const left = (inFlightRef.current.get(key) ?? 1) - 1
    if (left > 0) inFlightRef.current.set(key, left)
    else inFlightRef.current.delete(key)
  }
  /** The sets currently exempt — `Map` keys read as the `ReadonlySet` the
   *  overlay wants (`has` is all it uses). */
  const writingNow = (): ReadonlySet<string> => new Set(inFlightRef.current.keys())

  /** Writes that failed, keyed on the set AND the fields it was changing —
   *  not the set alone, since two overlapping writes (reps, then the done
   *  checkbox) would otherwise let one's success clear the other's failure. */
  const failedRef = useRef(new Map<number, OpContext>())
  const opSeq = useRef(0)
  const nextOp = (over: Partial<OpContext> = {}): OpContext => ({
    id: (opSeq.current += 1), slot, workout: coordinator.workoutId(), setKey: '', fields: '', ...over,
  })
  /** Is a write the user made still unaccounted for on this screen? */
  const anyFailureHere = (): boolean => [...failedRef.current.values()].some(belongsHere)

  /** The latest write that SUCCEEDED for each change, so a later failure can
   *  be recognised as already answered. Keyed by the CHANGE, not the
   *  operation, so it holds one entry per set-and-fields, not one per tap. */
  const succeededRef = useRef(new Map<string, Map<string, OpContext>>())
  const changeKey = (op: OpContext): string => [op.slot, op.setKey, op.fields].join('\u0000')
  /** Has a LATER write already saved what this one was trying to save? Two
   *  writes to one field can overlap and the newer one can finish first, so
   *  the older failure arrives after it and would otherwise be recorded as
   *  unsaved even though the value is already saved. */
  const alreadySaved = (forOp: OpContext): boolean =>
    [...(succeededRef.current.get(changeKey(forOp))?.values() ?? [])].some(won => supersedes(won, forOp))

  /** Writes still running, so Finish can wait for them (it reasserts only
   *  ACCEPTANCE, not a weight/reps write Finish's own blur just started). */
  /** Waits that must end early if the session moves under them: Finish
   *  selects the writes it waits for ONCE, so a workout a peer has since
   *  replaced would otherwise leave the live session stuck on "Saving…". */
  const waitersRef = useRef(new Set<{at: number; release: () => void}>())
  const releaseStaleWaiters = () => {
    for (const waiter of waitersRef.current) {
      if (waiter.at === coordinator.generation()) continue
      waitersRef.current.delete(waiter)
      waiter.release()
    }
  }
  /** Resolves when this wait is no longer about the session on screen. */
  const untilSessionMoves = (at: number): Promise<void> =>
    new Promise<void>(release => waitersRef.current.add({at, release}))

  const pendingRef = useRef(new Map<Promise<unknown>, OpContext>())
  const track = <T,>(work: Promise<T>, forOp: OpContext): Promise<T> => {
    pendingRef.current.set(work, forOp)
    const done = () => { pendingRef.current.delete(work) }
    work.then(done, done)
    return work
  }

  /** Does this operation belong to what is on screen right now? Slot AND
   *  workout, because either can move independently: switching sessions
   *  changes the slot, a peer replacing the workout changes that while the
   *  slot stays put. `null` matches whatever attempt is current on its slot. */
  const belongsHere = (forOp: OpContext): boolean =>
    forOp.slot === slotRef.current
    && (forOp.workout === null || forOp.workout === coordinator.workoutId())

  /** Does this successful write settle that earlier failure — same change AND
   *  same place? `setKey` names a lift and set index, which two sessions can
   *  share outright, so on the change alone a success on B could take down a
   *  failure on A. A failure predating any workout is the retry settling it. */
  const supersedes = (success: OpContext, failed: OpContext): boolean =>
    failed.id <= success.id
    && failed.setKey === success.setKey
    && failed.fields === success.fields
    && failed.slot === success.slot
    && (failed.workout === null || failed.workout === success.workout)

  // "Which block does this set write to, and what has to be created first" —
  // the whole answer, unit-tested in writeCoordinator.ts. The view keeps only
  // the React half: applying the ids it hands back.
  const slot = `${day}|${session}`
  const shape = prescriptionShape(prescription.exercises)
  const coordinatorRef = useRef<WriteCoordinator | null>(null)
  coordinatorRef.current ??= createWriteCoordinator(live?.id ?? null, slot, shape)
  const coordinator = coordinatorRef.current

  /** The writes the coordinator orchestrates. Rebuilt per render so a create
   *  always uses the current day/session. */
  const effects: WriteEffects = {
    // `startWorkout`, not a bare create: on first paint `live` is empty
    // because the query hasn't resolved, indistinguishable from "nothing
    // logged" — this adopts an in-progress workout instead of duplicating it.
    createWorkout: rows => startWorkout(repo, workspaceId, pageId, toMaterializeDraft(day, session, rows)),
    // `ex.blockId`: an entry logged before the plan outline was readable is
    // keyed on the lift's NAME; re-deriving from the name here would create a
    // second entry beside the one already on screen.
    createExercise: (workoutId, ex) =>
      materializeExercise(repo, workoutId, toExerciseDraft(ex), ex.blockId),
  }

  /** The draft, re-derived from its inputs on every emission. `overlayLive`
   *  merges rather than replaces, so running it unconditionally is both
   *  correct and cheap — it hands back the same array when nothing moved. */
  useEffect(() => {
    const {slotChanged} = coordinator.reset(live?.id ?? null, slot, shape, liveLoaded)
    if (slotChanged) seenLiveRef.current = null
    // A workout this view was looking at, now authoritatively absent (someone
    // else finished or deleted it): holding on would leave Discard live and
    // risk tombstoning a session a peer just logged.
    const seen = seenLiveRef.current
    const vanished = live === undefined && liveLoaded && seen !== null
    if (vanished) {
      seenLiveRef.current = null
      // By id: what's being let go of is the workout that VANISHED, not
      // whatever happens to be attached now.
      coordinator.completed(seen)
    }
    releaseStaleWaiters()
    if (live !== undefined) seenLiveRef.current = live.id
    const writing = writingNow()
    // On a session switch, the old draft belongs to the OTHER session and
    // must not be passed through: two sessions can prescribe the same lift,
    // and the overlay matches rows BY the lift, so it would hand session B
    // session A's block ids.
    setDraft(cur => overlayLive(
      buildDraft(prescription, unit), live, slotChanged || vanished ? [] : cur, writing, liveLoaded,
    ))
    // Keep a confirmation the user hasn't seen: finishing makes the workout
    // leave `liveWorkouts`, which lands here, and clearing "Logged Session A"
    // the instant it appears invites a second workout for tonight.
    if (slotChanged) setStatus(null)
  }, [slot, unit, live, liveLoaded, prescription, shape, coordinator, resync])

  const applyPatch = (
    prev: DraftExercise[],
    exIdx: number,
    setIdx: number,
    patch: Partial<DraftSet>,
  ): DraftExercise[] =>
    prev.map((ex, i) =>
      i !== exIdx ? ex : {...ex, sets: ex.sets.map((s, j) => (j !== setIdx ? s : {...s, ...patch}))},
    )

  /** Resolve the block for one set (creating whatever is missing) and write
   *  it. Reads from `next` so it never races React state; ids that come back
   *  are stamped into the draft. */
  const persist = async (
    next: readonly DraftExercise[],
    exIdx: number,
    setIdx: number,
    change: Partial<DraftSet>,
    forOp: OpContext,
  ): Promise<IdPatch | undefined> => {
    // Before the plan outline is read, ids derive from exercise NAMES instead
    // of the plan block existing records are keyed on.
    if (readOnly || !configLoaded) return undefined
    // Exempt from the overlay for the WHOLE round trip, resolve included: an
    // emission arriving mid-create would otherwise re-derive this set from
    // the prescription and drop the tick that started it all.
    const writingKey = setKey(next[exIdx], setIdx)
    // The exemption is per SET. The failure marker is per WRITE (two can be
    // outstanding for one set) and per WORKOUT (two can share an evening).
    forOp.setKey = writingKey
    forOp.fields = Object.keys(change).sort().join(',')
    beginWrite(writingKey)
    try {
      const {blockId, workoutId, entryId, patch} = await coordinator.resolveSet(next, exIdx, setIdx, effects)
      // The operation now knows which workout it's FOR. A `null` here matches
      // whatever workout is current, right only while genuinely unknown — left
      // null afterwards, a replaced workout's operation would keep matching.
      if (workoutId !== undefined) forOp.workout = workoutId
      if (patch) setDraft(cur => applyIdPatch(cur, patch))
      // The CHANGE, not the whole set: the rest of this row may be older than
      // the block. `entryId`/`workoutId` come from the RESOLVER — rebuilding
      // them from the caller's snapshot gets them wrong for the create cache.
      const outcome = blockId
        ? await writeSet(repo, blockId, change, next[exIdx].unit, entryId, workoutId)
        : 'written'
      if (outcome === 'gone') {
        // Its cached copy of this id outlives the block; left in place, every
        // retry would name the same tombstone.
        if (blockId) coordinator.forget(blockId)
        throw new Error(`writeSet: set block ${blockId} is gone`)
      }
      // Settles every EARLIER attempt this write supersedes (a retry or first
      // attempt), never a later one — that failure is about a value typed
      // after this write and is still true.
      for (const [id, failed] of failedRef.current) {
        if (supersedes(forOp, failed)) failedRef.current.delete(id)
      }
      // Remember the success too, per WORKOUT not just per change: two
      // workouts can share a slot, and one map slot per change would let W2's
      // success evict W1's, stranding a W1 failure that arrives later.
      const key = changeKey(forOp)
      const byWorkout = succeededRef.current.get(key) ?? new Map<string, OpContext>()
      const seat = forOp.workout ?? ''
      const won = byWorkout.get(seat)
      if (!won || won.id < forOp.id) byWorkout.set(seat, forOp)
      succeededRef.current.set(key, byWorkout)
      // Clear the message once nothing is unaccounted for, whether or not
      // THIS write settled it — a failure on a now-gone workout can never be
      // superseded, so requiring "this write settled it" would strand it.
      if (!anyFailureHere()) setStatus(current => (current === WRITE_FAILED ? null : current))
      // No overlay on success, deliberately: the write's own query emission
      // re-runs the overlay a moment later with the news. Forcing one here
      // instead would run it against the stale `live` from before this write.
      return patch
    } catch (error) {
      // Resync only if a later write hasn't already saved this very change —
      // otherwise the block holds the newer value and a resync here would
      // show the older one until its own emission catches up.
      if (!alreadySaved(forOp)) {
        failedRef.current.set(forOp.id, forOp)
        setResync(n => n + 1)
      }
      throw error
    } finally {
      endWrite(writingKey)
    }
  }

  /** A write failing must not be silent — the checkbox stays ticked with no
   *  sign the session isn't actually saving. */
  /** The slot as of the latest render, so a callback firing long after its
   *  tap can tell if the user is still on that session. */
  const slotRef = useRef(slot)
  slotRef.current = slot

  const reportWriteFailure = (error: unknown) => {
    console.error('[strength] write failed', error)
    setStatus(WRITE_FAILED)
  }

  /** Report a failure only if the user is still on the session it happened on.
   *  A write for a session you've since left is allowed to finish; its
   *  warning belongs there, not on the screen you switched to, where the
   *  marker (keyed to the other slot) could never be cleared. */
  const reportFor = (forOp: OpContext) => (error: unknown) => {
    if (!belongsHere(forOp)) {
      console.error('[strength] write failed on a session no longer shown', error)
      return
    }
    if (alreadySaved(forOp)) {
      console.error('[strength] write failed, but a later one saved the same change', error)
      return
    }
    reportWriteFailure(error)
  }

  const commitSet = (exIdx: number, setIdx: number, patch: Partial<DraftSet>) => {
    const next = applyPatch(draftRef.current, exIdx, setIdx, patch)
    setDraft(next)
    const forOp = nextOp()
    void track(persist(next, exIdx, setIdx, patch, forOp), forOp).catch(reportFor(forOp))
  }

  const toggleDone = (exIdx: number, setIdx: number, done: boolean) =>
    commitSet(exIdx, setIdx, {done, completedAt: done ? Date.now() : undefined})

  const acceptAll = (exIdx: number) => {
    const now = Date.now()
    // Only sets not already accepted — "accept the rest" isn't a claim about
    // when an already-logged set happened, and writing `now` to it would
    // re-date real history.
    const pending = draftRef.current[exIdx].sets
      .map((s, j) => (s.done ? -1 : j))
      .filter(j => j >= 0)
    if (pending.length === 0) return
    const next = draftRef.current.map((ex, i) =>
      i !== exIdx ? ex : {...ex, sets: ex.sets.map(s => (s.done ? s : {...s, done: true, completedAt: now}))},
    )
    setDraft(next)
    // The WHOLE batch is exempt up front, not one set at a time: an emission
    // mid-loop would otherwise see sets the loop hasn't reached yet as
    // un-exempt and revert their freshly-ticked boxes.
    const batch = pending.map(j => setKey(next[exIdx], j))
    for (const key of batch) beginWrite(key)
    // `rows` is REASSIGNED as ids come back, so later iterations don't look
    // like they still need creating. Discard stays enabled through this
    // batch, so the generation check below stops a fresh workout being
    // created after the session was thrown away.
    const at = coordinator.generation()
    const forOp = nextOp()
    void track((async () => {
      let aborted = false
      try {
        let rows: readonly DraftExercise[] = next
        for (const j of pending) {
          if (coordinator.generation() !== at) {
            aborted = true
            break
          }
          // One context per SET, not one for the batch: a shared context
          // would end up describing whichever set `persist` wrote last, so
          // the success recorded for the first set would claim to be about
          // the last.
          const opFor = nextOp()
          try {
            const patch = await persist(rows, exIdx, j, {done: true, completedAt: now}, opFor)
            if (patch) rows = applyIdPatch(rows, patch)
          } finally {
            // The batch's OWN context is made before there's a workout to
            // name it after, so bind it to the first set's workout instead —
            // in `finally`, since a failed WRITE still resolves one.
            if (forOp.workout === null) forOp.workout = opFor.workout
          }
        }
      } finally {
        for (const key of batch) endWrite(key)
        // Sets this batch never reached are still ticked from the optimistic
        // update; dropping their exemption isn't enough since no emission is
        // coming for a write that never happened — resync to clear them.
        if (aborted) setResync(n => n + 1)
      }
    })(), forOp).catch(reportFor(forOp))
  }

  const finish = async () => {
    if (readOnly || busy || !canFinish) return
    // Finishing PRUNES. Doing that against a draft that hasn't met the blocks
    // yet (live query still resolving, every set reads un-done) would delete
    // the whole session — wait until the view is looking at it.
    const pending = coordinator.workoutId()
    if (!configLoaded || (pending !== null && live?.id !== pending)) {
      setStatus('Still catching up with tonight’s log — give it a moment and tap Finish again.')
      return
    }
    setBusy(true)
    // Finish is a dozen-plus transactions; if the draft is reseeded under it
    // (a session switch, a plan reload), later steps would target a workout
    // this view is no longer editing.
    const at = coordinator.generation()
    try {
      // Let writes already in the air land first: tapping Finish blurs the
      // focused field, which STARTS one, and Finish reasserts only
      // acceptance, so that number isn't something it writes itself.
      const mine = [...pendingRef.current].filter(([, forOp]) => belongsHere(forOp)).map(([work]) => work)
      // …but not past the point where they stop being ours: the list is fixed
      // once, so a workout replaced while a write hangs would otherwise hold
      // this open forever — the generation check below reports that case.
      if (mine.length > 0) await Promise.race([Promise.allSettled(mine), untilSessionMoves(at)])
      // Interrupting the wait only helps if it also STOPS: the flush below
      // awaits its own writes, so walking into it after the session moved
      // would just hang there instead.
      if (coordinator.generation() !== at) {
        setStatus(SESSION_MOVED)
        return
      }
      const failedHere = [...failedRef.current.values()].filter(belongsHere)
      if (failedHere.length > 0) {
        // Something genuinely didn't save — say so, but don't refuse forever:
        // a gone set will never write no matter how often retried, and the
        // rest of the session still deserves to be logged.
        for (const failed of failedHere) failedRef.current.delete(failed.id)
        setStatus('A change did not save — check the numbers, then tap Finish again to log anyway.')
        return
      }
      // Flush every set through the same resolver the edit path uses, so a
      // Finish pressed mid-create joins that create instead of racing a
      // second workout. Ids land in a LOCAL copy too: `setDraft` doesn't
      // apply synchronously, so pruning off `draftRef` would see every
      // exercise as block-less and keep NOTHING.
      let flushed = draftRef.current
      // Indexed, not destructured: `flushed` is REPLACED whenever a create
      // hands back ids, so a captured `ex` would go stale mid-loop.
      for (let i = 0; i < flushed.length; i += 1) {
        // Nothing accepted and nothing on disk: creating blocks here only to
        // prune them two lines later is pure churn.
        if (!flushed[i].blockId && !flushed[i].sets.some(s => s.done)) continue
        for (let j = 0; j < flushed[i].sets.length; j += 1) {
          // Only the acceptance, only for sets this view believes are done —
          // weight/reps were written by their own blur. A set done on the
          // block but open here is left alone: `finishPlan` unions both.
          if (!flushed[i].sets[j].done) continue
          // Before EACH resolution, not once before the loop: a peer can
          // replace the workout part-way through, and a row with no block ids
          // yet would otherwise materialize into the replacement — writing
          // this session's sets into one someone else just started.
          if (coordinator.generation() !== at) {
            setStatus(SESSION_MOVED)
            return
          }
          const {blockId, workoutId: forWorkout, entryId, patch} =
            await coordinator.resolveSet(flushed, i, j, effects)
          if (patch) {
            flushed = applyIdPatch(flushed, patch)
            setDraft(cur => applyIdPatch(cur, patch))
          }
          if (blockId) {
            const {done, completedAt} = flushed[i].sets[j]
            // The resolver's own answer for both, not the coordinator's
            // current one: a peer replacing the workout mid-flush makes every
            // remaining set validate against its successor.
            const outcome = await writeSet(
              repo, blockId, {done, completedAt}, flushed[i].unit,
              entryId ?? flushed[i].blockId, forWorkout,
            )
            if (outcome === 'gone') {
              // A set shown as accepted is gone — deleted or undone since the
              // last emission. Finishing anyway would report it logged off a
              // draft that's now fiction; stop and re-read instead. Ticks
              // already flushed have landed, and the workout stays live.
              setResync(n => n + 1)
              setStatus('Something changed while saving — the log has been re-read. Check it and tap Finish again.')
              return
            }
          }
        }
      }

      const wid = coordinator.workoutId()
      if (!wid || coordinator.generation() !== at) {
        setStatus(SESSION_MOVED)
        return
      }

      // Decided from history as it stands BEFORE this session joins it, and
      // written by `finishWorkout` in the SAME transaction: written first, a
      // finish that then fails leaves a break recorded against an attempt
      // that never completed; written after, a failure loses the record for
      // good — the gap it describes becomes undetectable once this session is
      // the latest full one. The gap picks the load-cut tier.
      const layoff = (() => {
        const pending = detectPendingLayoff(history, day, config)
        return pending && !layoffAlreadyRecorded(pending, layoffs)
          ? {pageId, record: layoffFromPending(pending)}
          : undefined
      })()
      // No plan argument: `finishWorkout` re-reads the tree inside its own
      // transaction, so nothing this view believes can prune a set the blocks
      // say was performed.
      const outcome = await finishWorkout(repo, wid, layoff)
      if (outcome === 'nothing-accepted') {
        // Every accepted set went away between this view's flush and the
        // store's transaction. Finishing would prune the tree to nothing and
        // still report the session logged — re-read instead, same as the
        // per-set `gone` case above.
        setResync(n => n + 1)
        setStatus('Something changed while saving — the log has been re-read. Check it and tap Finish again.')
        return
      }
      if (outcome === 'gone') {
        // Someone else finished it between this check and the store's
        // transaction — the session IS logged, just not by us.
        coordinator.completed(wid)
        setStatus('That session was already finished elsewhere — nothing more to log.')
        return
      }
      // Tonight's log is now a RECORD, so this view must stop being attached:
      // a finished workout simply leaves `liveWorkouts`, indistinguishable
      // from a query that hasn't caught up, so nothing else releases it.
      // `completed`, not `abandon` — this evening now holds a finished
      // workout, not an empty slot, so the next session of the same type
      // gets a new one rather than adopting this. By id, since a peer can
      // replace the workout while `finishWorkout` is in the air.
      const wasOnScreen = coordinator.workoutId() === wid
      coordinator.completed(wid)
      // Clearing the draft is right only when what we finished is what's
      // displayed — a peer's replacement mid-finish is still ours to log
      // into, and wiping it would hide its logged values for good. The
      // resync otherwise is belt-and-braces: the overlay already re-ran, so
      // the only input it can still pick up is the in-flight exemption.
      if (wasOnScreen) setDraft(buildDraft(prescription, unit))
      else setResync(n => n + 1)
      const lifts = flushed.filter(ex => ex.sets.some(s => s.done)).length
      setStatus(`Logged ${SESSION_LABELS[session]} — ${lifts} lifts`)

      // The workout is SAVED from here on, so nothing after this point may
      // report it as unsaved — the shoulder check is a follow-up prompt, and
      // its own catch block below must not let a failure there read as the
      // save itself failing.
      const fullBefore = history.filter(w => w.session !== 'mini').length
      const isFull = session !== 'mini'
      const due = isFull && ((fullBefore + 1) % SHOULDER_CHECK_EVERY === 0 || detectLeftRightAsymmetry(history))
      if (due) {
        try {
          const result = await openDialog(ShoulderChecklistDialog, {history})
          if (result && result.checkedPrompts.length > 0) {
            await writeShoulderTodo(repo, workspaceId, pageId, result.checkedPrompts, SHOULDER_POLICY_BLOCK_ID)
            setStatus('Shoulder trigger logged → consult todo created')
          }
        } catch (error) {
          console.error('[strength] shoulder follow-up failed', error)
          setStatus(`Logged ${SESSION_LABELS[session]} — the shoulder check could not be saved.`)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    const wid = coordinator.workoutId()
    if (!wid || busy) return
    setBusy(true)
    // Not `reset`: a create still in flight must not write into the blocks
    // about to be tombstoned. `abandon` makes those results yield nothing.
    coordinator.abandon()
    try {
      const outcome = await discardWorkout(repo, wid)
      // Failures belonging to blocks that no longer exist must be cleared, or
      // the NEXT session of the same type inherits them. Scoped to THIS
      // workout, not the whole slot: two workouts can share a slot, and a
      // null-workout failure goes too — it's the one being discarded.
      for (const [id, failed] of failedRef.current) {
        if (failed.slot !== slot) continue
        if (failed.workout === wid || failed.workout === null) failedRef.current.delete(id)
      }
      // Back to the bare prescription only if the evening is actually empty:
      // a peer's session can be adopted onto the slot while the delete is in
      // flight, and wiping the draft would hide its logged values with
      // nothing left to bring them back. Same rule Finish follows.
      if (coordinator.workoutId() === null) setDraft(buildDraft(prescription, unit))
      else setResync(n => n + 1)
      // The store refuses to discard an already-finished session — someone
      // else finished it first. Letting go is still right, but saying
      // "Discarded" over a safely-logged session would send the user looking
      // for data that's right where they left it.
      setStatus(outcome === 'discarded'
        ? 'Discarded'
        : 'That session was already finished elsewhere — nothing was discarded.')
    } catch (error) {
      // The workout is still there. `abandon` already let go of it, and
      // nothing hands it back on its own — the release retires only on
      // authoritative ABSENCE, and this workout is present.
      coordinator.restore(wid)
      // A create that resolved between `abandon` and this rejection yielded
      // no block, so a value typed just before discarding may be on screen
      // and in no block on a workout that survived. Rebuild from the blocks —
      // deliberately not re-issued, since the tap the user made was Discard.
      setResync(n => n + 1)
      reportWriteFailure(error)
    } finally {
      setBusy(false)
    }
  }

  // Done-ness is the built-in todo checkbox, so sets can be accepted from the
  // outline or another device without this draft hearing about it. Finish has
  // to be reachable in that case too.
  const canFinish = !readOnly && !busy && configLoaded
    && (hasAcceptedSets(draft) || (live?.exercises.some(ex => ex.sets.some(s => s.done)) ?? false))
  // Derived from the draft, not the coordinator: the coordinator lives in a
  // ref, so reading it wouldn't re-render when the workout appears. A
  // materialized row's block id is normally the same signal, EXCEPT right
  // after an `or`-group switch, when the workout's entries are all outside
  // the current prescription and no row carries an id yet — `live` alone
  // still catches that case.
  const started = live !== undefined || draft.some(ex => ex.blockId !== undefined)

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <div className="text-lg font-semibold">Tonight · {day}</div>
          {prescription.offSchedule && (
            <div className="text-xs text-muted-foreground">off template — inferred session</div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-1" role="group" aria-label="Session">
          {(['A', 'B', 'mini'] as const).map(s => (
            <button
              key={s}
              type="button"
              onClick={() => setSession(s)}
              // Switching mid-save would reseed the draft under an operation
              // still in flight, splitting one session's sets across two
              // workouts.
              disabled={busy}
              aria-pressed={session === s}
              className={
                'rounded-md px-3 py-2 text-sm font-medium ' +
                (session === s
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border text-muted-foreground hover:bg-muted')
              }
            >
              {SESSION_LABELS[s]}
            </button>
          ))}
        </div>
      </header>

      {prescription.reentry && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <div className="font-medium text-amber-700 dark:text-amber-300">{prescription.reentry.banner}</div>
          {prescription.reentry.tier.guidance && (
            <div className="mt-0.5 text-xs text-muted-foreground">{prescription.reentry.tier.guidance}</div>
          )}
        </div>
      )}

      <ol className="flex flex-col gap-3">
        {draft.map((ex, exIdx) => (
          <ExerciseCard
            // The row's own identity — so switching an `or`-group remounts
            // the card (it is a different lift) while a plan edit that merely
            // reorders the session does not.
            key={rowKey(ex)}
            ex={ex}
            unit={unit}
            locked={readOnly || busy || !configLoaded}
            onCommit={(setIdx, patch) => commitSet(exIdx, setIdx, patch)}
            onToggleDone={(setIdx, done) => toggleDone(exIdx, setIdx, done)}
            onAcceptAll={() => acceptAll(exIdx)}
            // `locked`, not just `readOnly`: switching an option changes the
            // shape and bumps the coordinator's generation, aborting a
            // running Finish with "Session changed while saving" — the one
            // control that could move the ground under a save in progress.
            onSwitch={
              ex.altGroupKey && !readOnly && !busy && configLoaded
                ? (optionKey, label) => program.setAltChoice(ex.altGroupKey as string, optionKey, label)
                : undefined
            }
          />
        ))}
      </ol>

      {prescription.notes.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">Session notes</summary>
          <ul className="mt-1 list-disc pl-5">
            {prescription.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      {duplicates > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
          <span>
            {duplicates === 1
              ? 'Another unfinished session for tonight exists — this screen is logging into one of them.'
              : `${duplicates} other unfinished sessions for tonight exist — this screen is logging into one of them.`}
          </span>
          {/* Numbered once there is more than one: three buttons all reading
              "Open" are indistinguishable to someone deciding which to press,
              and to a screen reader announcing them in a row. */}
          {duplicateWorkouts.map((w, i) => (
            <button
              key={w.id}
              type="button"
              className="underline underline-offset-2"
              onClick={e => openBlock(e, {blockId: w.id, workspaceId})}
            >
              {duplicateWorkouts.length > 1 ? `Open #${i + 1}` : 'Open'}
            </button>
          ))}
        </div>
      )}

      {program.warnings.length > 0 && (
        <details className="text-xs text-amber-600 dark:text-amber-400">
          <summary className="cursor-pointer select-none">{program.warnings.length} plan warning(s)</summary>
          <ul className="mt-1 list-disc pl-5">
            {program.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border bg-background/90 py-3 backdrop-blur">
        <span className="text-sm text-muted-foreground">
          {status ?? (!configLoaded ? 'Reading your plan…' : started ? 'Saved as you go' : '')}
        </span>
        <div className="flex items-center gap-2">
          {started && !readOnly && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void discard()}
              className="rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              Discard
            </button>
          )}
          <button
            type="button"
            disabled={!canFinish}
            onClick={() => void finish().catch(reportWriteFailure)}
            className={
              'rounded-md px-4 py-2 text-sm font-medium ' +
              (canFinish
                ? 'bg-primary text-primary-foreground hover:opacity-90'
                : 'cursor-not-allowed bg-muted text-muted-foreground')
            }
          >
            {busy ? 'Saving…' : 'Finish & log'}
          </button>
        </div>
      </div>
    </div>
  )
}
TonightView.displayName = 'TonightView'


function ExerciseCard({
  ex,
  unit,
  locked,
  onCommit,
  onToggleDone,
  onAcceptAll,
  onSwitch,
}: {
  ex: DraftExercise
  unit: string
  /** No edits right now: read-only workspace, or a save in flight (a tick
   *  made during Finish would be written and then pruned by the plan that
   *  was snapshotted before it). */
  locked: boolean
  onCommit: (setIdx: number, patch: Partial<DraftSet>) => void
  onToggleDone: (setIdx: number, done: boolean) => void
  onAcceptAll: () => void
  onSwitch?: (optionKey: string, label: string) => void
}) {
  const range =
    ex.repMin !== undefined && ex.repMax !== undefined
      ? `${ex.repMin}–${ex.repMax}`
      : ex.repMax !== undefined
        ? `${ex.repMax}`
        : ''
  // Per-side lifts double the draft rows (L+R); show the per-leg set count the
  // plan states, not the doubled row count.
  const setCount = ex.prescribedSets ?? (ex.perSide ? ex.sets.length / 2 : ex.sets.length)
  const target =
    `${setCount} × ${range || '—'}${ex.perSide ? ' / side' : ''}` +
    (ex.prescribedWeight ? ` @ ${ex.prescribedWeight}${unit}` : '')

  return (
    <li className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium">{ex.exercise}</div>
          <div className="text-xs text-muted-foreground">{target}</div>
          <div className="text-xs text-muted-foreground/80">{ex.rationale}</div>
        </div>
        {!locked && (
          <button
            type="button"
            onClick={onAcceptAll}
            className="shrink-0 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            all ✓
          </button>
        )}
      </div>
      {onSwitch && ex.altOptions && ex.altOptions.length > 1 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {ex.altOptions.map(option => {
            // Which chip is lit: by block when both sides know one (so a
            // renamed option still reads as the tracked one), else by name.
            const current =
              option.defId !== undefined && ex.defId !== undefined
                ? option.defId === ex.defId
                : option.name === ex.exercise
            return (
              <button
                key={altOptionKey(option)}
                type="button"
                onClick={() => !current && onSwitch(altOptionKey(option), option.name)}
                aria-pressed={current}
                className={
                  'rounded-full px-2.5 py-1 text-xs ' +
                  (current
                    ? 'bg-primary/15 font-medium text-primary'
                    : 'border border-border text-muted-foreground hover:bg-muted')
                }
              >
                {option.name}
              </button>
            )
          })}
        </div>
      )}
      {ex.note && <div className="mt-1 whitespace-pre-line text-xs text-muted-foreground/70">{ex.note}</div>}
      {ex.videos && ex.videos.length > 0 && <VideoLinks videos={ex.videos} />}
      <div className="mt-2 flex flex-col gap-1.5">
        {ex.sets.map((s, i) => (
          <SetRow
            key={i}
            set={s}
            unit={unit}
            locked={locked}
            onCommit={patch => onCommit(i, patch)}
            onToggleDone={done => onToggleDone(i, done)}
          />
        ))}
      </div>
    </li>
  )
}

function VideoLinks({videos}: {videos: readonly ExerciseVideo[]}) {
  return (
    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
      {videos.map((v, i) => (
        <a
          key={i}
          href={v.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs font-medium text-primary underline underline-offset-2 hover:opacity-80"
        >
          ▶ {v.label}
        </a>
      ))}
    </div>
  )
}

const fieldText = (value: number): string => (Number.isFinite(value) ? String(value) : '')

/** The one place uncommitted state lives. Keystrokes stay inside this input
 *  until blur, so the draft — and every block under it — only ever holds
 *  settled values, which is what lets the live overlay apply unconditionally.
 *  The alternative (keystrokes in the shared draft) needs a per-set dirty
 *  flag on every set to stay safe. It also stops a full re-render of every
 *  card on each digit. */
function NumberField({
  value,
  label,
  disabled,
  backingId,
  onCommit,
}: {
  value: number
  label: string
  disabled: boolean
  /** The block this field is currently editing. Not for reading — only for
   *  noticing that it became a DIFFERENT block. */
  backingId?: string
  onCommit: (value: number) => void
}) {
  const [text, setText] = useState(() => fieldText(value))
  const [shown, setShown] = useState(value)
  const [editing, setEditing] = useState(false)
  // What the field read when focus arrived. Blur commits only if the USER
  // moved it — comparing against `value` instead would commit whenever the
  // block changed underneath a focused field.
  const enteredRef = useRef('')
  const backingRef = useRef(backingId)

  // The row is still the same row but is now editing a different BLOCK — a
  // peer finishing our session and starting the next one does that. Left
  // alone, "never overwrite text under the cursor" below would commit
  // half-typed digits into the new session's set. `undefined -> id` is the
  // one benign case: our own create naming the set already being typed into.
  if (backingId !== backingRef.current) {
    const swapped = backingRef.current !== undefined
    backingRef.current = backingId
    if (swapped) {
      setText(fieldText(value))
      setShown(value)
      // …and make an untouched blur a no-op, so leaving the field cannot
      // commit the new block's own value back over itself.
      enteredRef.current = fieldText(value)
    }
  }

  // Follow the block when the change came from anywhere but this input — but
  // never while it's focused, or a set someone ticks elsewhere would rewrite
  // the number under the cursor.
  if (value !== shown) {
    setShown(value)
    if (!editing) setText(fieldText(value))
  }

  return (
    <input
      type="number"
      inputMode="numeric"
      aria-label={label}
      disabled={disabled}
      value={text}
      // Select on focus so a tap-and-type replaces the pre-filled number.
      onFocus={e => {
        setEditing(true)
        enteredRef.current = e.currentTarget.value
        e.currentTarget.select()
      }}
      onChange={e => setText(e.currentTarget.value)}
      // Enter is how you say "done with this field" on a phone keyboard —
      // without it, a typed value lives only in the DOM until locking the
      // phone loses it.
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      // Persist the settled value on blur (cheap, and the block is the record).
      onBlur={e => {
        setEditing(false)
        const raw = e.currentTarget.value
        if (raw === enteredRef.current) {
          // Untouched. Resync to the PROP, not to what's on screen: the block
          // may have moved while focused, and the catch-up above (keyed on
          // `value !== shown`) is by now false — this is the last chance to
          // stop showing a stale number.
          setText(fieldText(value))
          return
        }
        const next = raw === '' ? 0 : Number(raw)
        setText(fieldText(next))
        onCommit(next)
      }}
      className="h-9 w-16 rounded border border-border bg-background px-2 text-right text-sm tabular-nums"
    />
  )
}

function SetRow({
  set,
  unit,
  locked,
  onCommit,
  onToggleDone,
}: {
  set: DraftSet
  unit: string
  locked: boolean
  onCommit: (patch: Partial<DraftSet>) => void
  onToggleDone: (done: boolean) => void
}) {
  return (
    <div className={'flex items-center gap-2 rounded px-1 py-1 ' + (set.done ? 'bg-primary/10' : '')}>
      {set.side && (
        <span className="w-4 shrink-0 text-center text-xs font-medium text-muted-foreground">{set.side}</span>
      )}
      <NumberField
        value={set.weight}
        label="weight"
        disabled={locked}
        backingId={set.blockId}
        onCommit={weight => onCommit({weight})}
      />
      <span className="shrink-0 text-xs text-muted-foreground">{unit} ×</span>
      <NumberField
        value={set.reps}
        label="reps"
        disabled={locked}
        backingId={set.blockId}
        onCommit={reps => onCommit({reps})}
      />
      <label className="ml-auto flex cursor-pointer items-center gap-1.5 py-1 pl-2 text-xs text-muted-foreground">
        <span>done</span>
        <input
          type="checkbox"
          disabled={locked}
          checked={set.done}
          onChange={e => onToggleDone(e.currentTarget.checked)}
          className="h-6 w-6 rounded border-border accent-primary"
        />
      </label>
    </div>
  )
}
