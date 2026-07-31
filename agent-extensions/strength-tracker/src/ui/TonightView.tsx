/** Tonight's prescription + fast logging.
 *
 *  Mobile-first, dark-mode-friendly, usable half-tired at 1am. Every set is
 *  pre-filled from the prescription; the workout is *materialized* into blocks
 *  on the first settled edit and every set is a block edited in place — so a
 *  reload, tab switch, or second device just re-reads the same synced blocks,
 *  and switching A/B is non-destructive (each session is its own live block).
 *  Numeric edits persist on blur; done-taps persist immediately; "Finish"
 *  reconciles the whole draft to blocks, prunes the un-accepted sets, and
 *  flips the workout to done (still the layoff-record + shoulder-check point).
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
/** Named, because a successful retry has to be able to take it back down —
 *  it tells the user to tap again, and leaving it up after the tap worked
 *  invites the second, reversing tap. */
const WRITE_FAILED = 'Could not save that — check the connection and tap it again.'
/** Finish gave up because the session moved under it. Sets written before that
 *  point DID land in the workout they belonged to — say so, rather than
 *  implying nothing was logged and sending the user looking for data that
 *  exists. */
const SESSION_MOVED =
  'Session changed while saving — what you logged is kept, but this session was not finished.'

/** Which session and which workout an operation was started against. Captured
 *  once, at the tap, and carried — reconstructing it from whatever the view
 *  happens to be showing when a promise settles is how a write for one
 *  evening's log ended up reported on another's. */
interface OpContext {
  /** Monotonic per view. What makes two writes of the SAME field to the SAME
   *  set tell each other apart — edit a number twice before the first lands
   *  and, keyed on the change alone, the older one's success took down the
   *  newer one's failure. */
  id: number
  slot: string
  workout: string | null
  /** Which set, and which of its fields, this write is changing. */
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
  /** More than one unfinished session for tonight. This view can only log into
   *  one of them, so the others sit there with their sets — possibly open
   *  todos — reachable from nowhere else on this screen.
   *
   *  A repeat session is MINTED rather than derived (see `startWorkout`),
   *  which is what makes this representable: two devices that both start the
   *  evening's second session, or an undone delete putting the first one back
   *  beside its replacement. That trade was taken deliberately — a duplicate
   *  you can see beats a silent write into someone else's finished record —
   *  and this is the part that makes "you can see it" true. */
  const duplicates = tonights.length - 1
  /** The duplicates themselves — everything in `tonights` except whichever one
   *  `preferredLive` picked for this screen to drive. Not necessarily filed
   *  under this page: `liveWorkouts` is a workspace-wide query and a repeat
   *  session can be started (and filed) anywhere, e.g. under a year heading —
   *  so "open" rather than "see below" is the only claim that is always true. */
  const duplicateWorkouts = tonights.filter(w => w.id !== live?.id)

  const [draft, setDraft] = useState<DraftExercise[]>(() => overlayLive(buildDraft(prescription, unit), live))
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  /** Bumped to ask the overlay to run again when no query emission is coming
   *  — i.e. after a write FAILED. Nothing changed on the block, so the draft
   *  would otherwise keep showing a value that never landed. */
  const [resync, setResync] = useState(0)

  // Mirror the latest draft into a ref so edit handlers can persist the
  // freshly-computed next state without awaiting a re-render.
  const draftRef = useRef(draft)
  draftRef.current = draft

  /** Sets with a write in flight — the block is momentarily behind what the
   *  user just did, and the live overlay must not "correct" it back.
   *
   *  This is the one job the removed per-set `dirty` flag was doing that
   *  moving keystrokes into the input did NOT replace. It lives here rather
   *  than in the draft because it is not a property of the set — it is a
   *  property of this client's outstanding I/O — and because a pure overlay
   *  cannot tell an in-flight write from a failed one.
   *
   *  Keyed on `setKey`, not the block id: the first write of the night is
   *  made by the very tap that CREATES the block, so there is no id to key on
   *  at the moment the exemption has to start.
   *
   *  COUNTED, not a plain set: one set routinely has two writes in flight at
   *  once — typing reps and then tapping the checkbox blurs the input first,
   *  so the reps write and the done write overlap. With a set, the first to
   *  finish un-exempts it while the second is still going. */
  /** The live workout this view has actually SEEN in an emission — as opposed
   *  to one it has created and is waiting on. That difference is what makes
   *  an absent workout readable: never seen means the query is behind, seen
   *  and now gone means it is gone. */
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

  /** WRITES that failed — the set AND the fields it was changing, not the set
   *  alone. The "tap it again" message belongs to these, not to the view at
   *  large. Two writes for one set overlap routinely (typing reps then
   *  tapping the checkbox blurs the field first), so keyed on the set, the
   *  checkbox succeeding took down a warning that the reps write had put up
   *  and that was still true — and the field reverted with nothing on screen
   *  to explain it. A retry writes the same fields, so it clears its own. */
  const failedRef = useRef(new Map<number, OpContext>())
  const opSeq = useRef(0)
  const nextOp = (over: Partial<OpContext> = {}): OpContext => ({
    id: (opSeq.current += 1), slot, workout: coordinator.workoutId(), setKey: '', fields: '', ...over,
  })
  /** Is a write the user made still unaccounted for on this screen? */
  const anyFailureHere = (): boolean => [...failedRef.current.values()].some(belongsHere)

  /** The latest write that SUCCEEDED for each change, so a failure arriving
   *  after it can be recognised as already answered. Keyed by the CHANGE
   *  rather than the operation, so it holds one entry per set-and-fields
   *  instead of growing with every tap. */
  const succeededRef = useRef(new Map<string, Map<string, OpContext>>())
  const changeKey = (op: OpContext): string => [op.slot, op.setKey, op.fields].join('\u0000')
  /** Has a LATER write already saved what this one was trying to save?
   *
   *  Two writes to one field overlap routinely — type a weight, then type
   *  another before the first lands — and the newer one can finish first. Its
   *  success has nothing to retire yet, so the older failure arrived after it
   *  and was recorded anyway: "tap it again" over a set that is saved, and
   *  Finish pausing once for a value the user had already replaced. */
  const alreadySaved = (forOp: OpContext): boolean =>
    [...(succeededRef.current.get(changeKey(forOp))?.values() ?? [])].some(won => supersedes(won, forOp))

  /** Writes still running. Finish reasserts only ACCEPTANCE, so a weight or
   *  reps write started by the blur that a Finish tap causes is not part of
   *  what Finish flushes — it races it. Left unwaited, Finish could finalize
   *  and release the session while that edit was still in the air, and a
   *  failure had nowhere left to be retried. */
  /** Waits that must end early if the session moves under them.
   *
   *  Finish selects the writes it will wait for ONCE, and a promise cannot be
   *  taken back out of that list — so a write for a workout a peer has since
   *  replaced went on being waited for, leaving the LIVE session stuck on
   *  "Saving…" and unable to finish or discard. The query effect releases
   *  these when the generation it recorded is no longer current. */
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

  /** Does this operation belong to what is on screen right now?
   *
   *  Slot AND workout, because both can move under an operation in flight:
   *  switching sessions changes the slot, and a peer finishing ours and
   *  starting the next one changes the workout while the slot stays put. An
   *  operation that began before any workout existed (`null`) can only belong
   *  to the current attempt on its slot, so it matches whatever is there. */
  const belongsHere = (forOp: OpContext): boolean =>
    forOp.slot === slotRef.current
    && (forOp.workout === null || forOp.workout === coordinator.workoutId())

  /** Does this successful write settle that earlier failure — is it the same
   *  change, in the same place?
   *
   *  The same CHANGE is the set and the fields; the same PLACE is the slot and
   *  the workout, and both halves are needed. `setKey` names a lift and a set
   *  index, which two sessions of the same week can share outright — so on the
   *  change alone, a success on B took down a failure on A, and A's Finish
   *  then finalized a value that had never reached a block. A failure that
   *  predates any workout is the exception: it is the first attempt that the
   *  retry now creating the workout is settling. */
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
    // `startWorkout`, not a bare create: this fires from a checkbox tap whose
    // timing we don't control, and on first paint `live` is empty because the
    // query hasn't resolved — indistinguishable from "nothing logged". It
    // adopts an in-progress workout for this day+session when there is one.
    createWorkout: rows => startWorkout(repo, workspaceId, pageId, toMaterializeDraft(day, session, rows)),
    // `ex.blockId` — the entry this row is attached to, when it has one. An
    // entry logged before the plan outline was readable is keyed on the lift's
    // NAME, while the row now keys on its plan block; re-deriving there builds
    // a second entry beside the one on screen and the record shows the lift
    // twice.
    createExercise: (workoutId, ex) =>
      materializeExercise(repo, workoutId, toExerciseDraft(ex), ex.blockId),
  }

  /** The draft, re-derived from its inputs on every emission.
   *
   *  There is no longer a question of whether this emission is worth reacting
   *  to. `overlayLive` takes what is on screen as an input and merges rather
   *  than replaces, so running it always is both correct and cheap (it hands
   *  back the same array when nothing moved). The guard this replaced had to
   *  decide, from five clauses, whether an arriving `live` was "our own
   *  create, one query behind" — and every version of that guard was wrong
   *  about some third case: it skipped an `or`-group switch, or it discarded
   *  a tick whose write was still in flight. */
  useEffect(() => {
    const {slotChanged} = coordinator.reset(live?.id ?? null, slot, shape, liveLoaded)
    if (slotChanged) seenLiveRef.current = null
    // A workout this view was looking at, now authoritatively absent: someone
    // else finished it, or it was deleted. Holding on meant `started` stayed
    // true and Discard stayed live — one tap and the session a peer had just
    // logged was tombstoned.
    //
    // "Was looking at" is the whole trick. An absent workout we have never
    // seen is a query that hasn't caught up with our own create, and letting
    // go there is the bug this carry-forward exists to prevent. Seen and then
    // gone is the opposite, and only the seeing tells them apart.
    const seen = seenLiveRef.current
    const vanished = live === undefined && liveLoaded && seen !== null
    if (vanished) {
      seenLiveRef.current = null
      // By id, like the finish path: what is being let go of is the workout
      // that VANISHED, not whatever happens to be attached by the time this
      // runs.
      coordinator.completed(seen)
    }
    releaseStaleWaiters()
    if (live !== undefined) seenLiveRef.current = live.id
    const writing = writingNow()
    // On a session switch, what is on screen is about the OTHER session, so it
    // is not an input. Two sessions can prescribe the same lift and the
    // overlay matches rows BY the lift — so passing the old draft through
    // handed session B session A's block ids, and the first tap in B wrote
    // into A's workout, at A's weights, without ever materializing B.
    setDraft(cur => overlayLive(
      buildDraft(prescription, unit), live, slotChanged || vanished ? [] : cur, writing, liveLoaded,
    ))
    // Keep a confirmation the user hasn't seen. Finishing makes the workout
    // leave `liveWorkouts`, which lands here — clearing "Logged Session A"
    // the instant it appeared and leaving a screen that looks like nothing
    // happened, which invites a second workout for tonight.
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
    // Writing before the plan outline has been read derives ids from exercise
    // NAMES, while the records that exist are keyed on their plan block — a
    // whole parallel tree of blocks for a session already in progress.
    if (readOnly || !configLoaded) return undefined
    // Exempt from the overlay for the WHOLE round trip, resolve included: the
    // first tap of the night creates the blocks, and an emission arriving
    // mid-create would otherwise re-derive this set from the prescription and
    // drop the tick that started it all.
    const writingKey = setKey(next[exIdx], setIdx)
    // The exemption is per SET — the block is what a query emission can be
    // behind on. The failure marker is per WRITE, because two of them can be
    // outstanding for one set with different outcomes — and per WORKOUT,
    // because two of them can share an evening: a peer finishing ours and
    // starting the next one keeps the slot but changes everything else, and a
    // late rejection from the first was landing on the second's tab.
    forOp.setKey = writingKey
    forOp.fields = Object.keys(change).sort().join(',')
    beginWrite(writingKey)
    try {
      const {blockId, workoutId, entryId, patch} = await coordinator.resolveSet(next, exIdx, setIdx, effects)
      // The operation now knows which workout it is FOR. Until this point it
      // may have had none — the first tap of the night creates one — and a
      // `null` there matches whatever is current, which is right only while
      // the answer is genuinely unknown. Leaving it null afterwards let an
      // operation belonging to a replaced workout keep matching its successor.
      if (workoutId !== undefined) forOp.workout = workoutId
      if (patch) setDraft(cur => applyIdPatch(cur, patch))
      // The CHANGE, not the whole set: the rest of this row may be older than
      // the block (the live query hadn't resolved when the draft was built),
      // and writing it back is how logged reps got replaced by the
      // prescription's.
      // A block that is GONE is a failure, not a no-op: the draft is holding
      // an id for a set that was undone, deleted from the outline, or pruned
      // by a Finish this view hasn't seen. Treating it as success left the
      // checkbox ticked over nothing.
      // `entryId` and `workoutId` both come from the RESOLVER, which is the
      // only thing that knows what it resolved against. Rebuilding them here —
      // from the caller's snapshot, or from whatever workout is current by now
      // — got them wrong on exactly the paths that matter: a set out of the
      // create cache carries no id patch, so the row still has no entry id,
      // and `writeSet` skips its parent AND workout-status checks when handed
      // no parent.
      const outcome = blockId
        ? await writeSet(repo, blockId, change, next[exIdx].unit, entryId, workoutId)
        : 'written'
      if (outcome === 'gone') {
        // Its cached copy of this id outlives the block. Left in place, every
        // retry named the same tombstone and the row could never be remade.
        if (blockId) coordinator.forget(blockId)
        throw new Error(`writeSet: set block ${blockId} is gone`)
      }
      // This tap worked, so take down a "tap it again" left over from the last
      // one that didn't — but only once every set that failed has been
      // retried, and only that message: a "Logged …" confirmation is about
      // something else and must survive.
      //
      // It settles every EARLIER attempt this one supersedes — a retry, or a
      // first attempt — and never a later one: that write is about a value the
      // user typed after this one, and its failure is still true.
      for (const [id, failed] of failedRef.current) {
        if (supersedes(forOp, failed)) failedRef.current.delete(id)
      }
      // …and remember it, for the failure that has not arrived yet. Retiring
      // alone only settles what already failed.
      //
      // Per WORKOUT, not just per change: two workouts can occupy one slot (a
      // peer finishes ours and starts the next, a discard is undone), and one
      // map slot per change let W2's success evict W1's. A W1 failure arriving
      // afterwards then read as unanswered — invisible until W1 came back, at
      // which point Finish paused over a set W1 had itself saved.
      const key = changeKey(forOp)
      const byWorkout = succeededRef.current.get(key) ?? new Map<string, OpContext>()
      const seat = forOp.workout ?? ''
      const won = byWorkout.get(seat)
      if (!won || won.id < forOp.id) byWorkout.set(seat, forOp)
      succeededRef.current.set(key, byWorkout)
      // Then take the message down if nothing on this screen is unaccounted
      // for — whether or not THIS write is what settled it. Requiring that it
      // was stranded the warning whenever the failure belonged to a workout a
      // peer had since replaced: no later write can supersede a failure scoped
      // to a workout that is gone, so the warning outlived the only thing that
      // could clear it, over a session where everything was saving.
      if (!anyFailureHere()) setStatus(current => (current === WRITE_FAILED ? null : current))
      // No overlay on success, deliberately. The block now agrees with what is
      // on screen, and the write's OWN query emission re-runs the overlay a
      // moment later with the news. Asking for one here instead reverted every
      // tap, because the `live` it would run against is the one from before
      // this write — the version that still says `open`.
      return patch
    } catch (error) {
      // A failure is the case that genuinely needs it: nothing changed on the
      // block, so no emission is coming, and the draft would keep showing a
      // value that never reached it. Unless a later write already saved this
      // very change — then the block holds the newer value, and a resync here
      // would show the older one until its emission caught up.
      if (!alreadySaved(forOp)) {
        failedRef.current.set(forOp.id, forOp)
        setResync(n => n + 1)
      }
      throw error
    } finally {
      // Exactly once per `beginWrite`, whichever way this went. The `gone`
      // path used to decrement here AND fall into the catch, which released
      // the exemption while ANOTHER write for the same set was still in
      // flight — a stale emission then reverted that one's optimistic value.
      endWrite(writingKey)
    }
  }

  /** A write failing must not be silent: the checkbox stays ticked on screen
   *  and the user would have no idea their session is going nowhere. */
  /** The slot as of the latest render — so a callback that fires long after
   *  its tap can tell whether the user is still looking at that session. */
  const slotRef = useRef(slot)
  slotRef.current = slot

  const reportWriteFailure = (error: unknown) => {
    console.error('[strength] write failed', error)
    setStatus(WRITE_FAILED)
  }

  /** Report a failure only if the user is still on the session it happened
   *  on. A write for the session you just left is deliberately allowed to
   *  finish; when it fails, its warning belongs to that evening's log — put
   *  on the screen you switched TO, it could never be cleared from there
   *  (the marker is keyed to the other slot) and just sat there inviting a
   *  second, reversing tap. */
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
    // Only the sets that weren't already accepted. A set logged an hour ago
    // has a completion time, and "accept the rest" is not a claim about when
    // that one happened — writing `now` to it re-dated real history.
    const pending = draftRef.current[exIdx].sets
      .map((s, j) => (s.done ? -1 : j))
      .filter(j => j >= 0)
    if (pending.length === 0) return
    const next = draftRef.current.map((ex, i) =>
      i !== exIdx ? ex : {...ex, sets: ex.sets.map(s => (s.done ? s : {...s, done: true, completedAt: now}))},
    )
    setDraft(next)
    // The WHOLE batch is exempt from the overlay up front, not one set at a
    // time. Each write's own commit emits, and an emission mid-loop sees every
    // set the loop hasn't reached yet as un-exempt — so it reverted their
    // freshly-ticked boxes and the bulk action visibly undid itself.
    const batch = pending.map(j => setKey(next[exIdx], j))
    for (const key of batch) beginWrite(key)
    // Persist every pending set of this exercise; materialize on the first if
    // needed.
    //
    // `rows` is REASSIGNED as ids come back, exactly like the Finish loop:
    // handing the same block-less snapshot to every iteration made the later
    // sets look like an exercise that needed creating, so a reseed landing
    // mid-loop (the create's own query update does that) grew a duplicate
    // entry and scattered the sets across the two.
    // Discard stays enabled through this batch (it is meant to be quick), so
    // the session can be thrown away between iterations. A later one then
    // found no workout and CREATED one — the screen said "Discarded" while a
    // fresh, fully-accepted workout survived at the next slot.
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
          // One context per SET, not one for the batch. `persist` writes the
          // set and fields it is about into the context it is given, so a
          // shared one ends the loop describing whichever set went last — and
          // the success recorded for the first then claimed to be about the
          // last. An earlier failure on a set this batch had just re-saved was
          // reported as unsaved, and Finish paused over it.
          const opFor = nextOp()
          try {
            const patch = await persist(rows, exIdx, j, {done: true, completedAt: now}, opFor)
            if (patch) rows = applyIdPatch(rows, patch)
          } finally {
            // The batch's OWN context is what Finish waits on and what a
            // rejection is reported against, and it was made before there was
            // a workout to name it after — a batch that starts the evening
            // resolves one only here. A null workout matches whatever is
            // current, so a peer replacing this one mid-batch inherited the
            // wait and the warning. Bind it to the workout the first set
            // resolved against — in `finally`, because a set whose WRITE
            // failed still resolved a workout, and that is exactly the batch
            // whose warning must not land on a successor.
            if (forOp.workout === null) forOp.workout = opFor.workout
          }
        }
      } finally {
        for (const key of batch) endWrite(key)
        // The sets this batch never reached are still ticked from the
        // optimistic update, and dropping their exemption is not enough to
        // take that back — no emission is coming for a write that never
        // happened, so the replacement session would show unsaved ticks under
        // "Saved as you go", and Finish would persist them into it.
        if (aborted) setResync(n => n + 1)
      }
    })(), forOp).catch(reportFor(forOp))
  }

  const finish = async () => {
    if (readOnly || busy || !canFinish) return
    // Finishing PRUNES. Doing that against a draft that hasn't met the blocks
    // yet — the live query still resolving, so every set reads un-done — marks
    // the workout done and deletes the whole session. Wait for the view to be
    // looking at the workout it is about to finish.
    const pending = coordinator.workoutId()
    if (!configLoaded || (pending !== null && live?.id !== pending)) {
      setStatus('Still catching up with tonight’s log — give it a moment and tap Finish again.')
      return
    }
    setBusy(true)
    // Finish is a dozen-plus transactions. If the draft is reseeded under it
    // (a session switch, a plan reload), everything after that point would be
    // aimed at a workout this view is no longer editing.
    const at = coordinator.generation()
    try {
      // Let the writes already in the air land first. Tapping Finish blurs
      // whatever field was focused, which STARTS one — and Finish reasserts
      // only acceptance, so that number is not something it would write
      // itself. Finalizing around it meant the session could be logged and
      // released with the edit still in flight.
      const mine = [...pendingRef.current].filter(([, forOp]) => belongsHere(forOp)).map(([work]) => work)
      // …but not past the point where they stop being ours. The list is fixed
      // once; a workout replaced while a write hangs would otherwise hold this
      // open forever. The generation check below is what then reports it.
      if (mine.length > 0) await Promise.race([Promise.allSettled(mine), untilSessionMoves(at)])
      // Interrupting the wait is only worth anything if it also STOPS: the
      // flush below awaits its own writes, so walking into it after the
      // session moved just hangs there instead, and the live session is still
      // stuck behind `busy`.
      if (coordinator.generation() !== at) {
        setStatus(SESSION_MOVED)
        return
      }
      const failedHere = [...failedRef.current.values()].filter(belongsHere)
      if (failedHere.length > 0) {
        // Something genuinely didn't save. Say so before finalizing, but
        // don't refuse forever: a set that is gone will never write no matter
        // how often it is retried, and the rest of the session still deserves
        // to be logged. Cleared here, so tapping again goes through.
        for (const failed of failedHere) failedRef.current.delete(failed.id)
        setStatus('A change did not save — check the numbers, then tap Finish again to log anyway.')
        return
      }
      // Flush every set through the same resolver the edit path uses, so a
      // Finish pressed mid-create (or right after an or-group switch) joins
      // that create instead of racing a second workout.
      //
      // Ids land in a LOCAL copy as well as in the draft: `setDraft` doesn't
      // apply synchronously, so pruning off `draftRef` would see every
      // exercise as block-less and keep NOTHING — the workout would be marked
      // done with all its pre-filled sets still open.
      let flushed = draftRef.current
      // Indexed, not destructured: `flushed` is REPLACED whenever a create
      // hands back ids, so a captured `ex` would go stale mid-loop.
      for (let i = 0; i < flushed.length; i += 1) {
        // Nothing accepted and nothing on disk: creating blocks here only to
        // prune them two lines later is pure churn (and, after an or-group
        // switch, a create→delete round trip on every Finish).
        if (!flushed[i].blockId && !flushed[i].sets.some(s => s.done)) continue
        for (let j = 0; j < flushed[i].sets.length; j += 1) {
          // Only the acceptance, and only for sets this view believes are
          // done. Weight and reps were written by their own blur, and
          // re-asserting them here would push this draft's copy back over
          // whatever the block has learned since — including from the outline
          // right below, or another device. A set that is done on the block
          // but open here is left alone: `finishPlan` unions both.
          if (!flushed[i].sets[j].done) continue
          // Before EACH resolution, not just once before the loop. A peer can
          // replace the workout part-way through, and `resolveSet` answers for
          // whatever is attached NOW — so a row that never got block ids would
          // be materialized into the replacement, writing this session's lift
          // and its sets into a session someone else just started. (The write
          // then succeeds, because the entry and workout it validates against
          // are both the replacement's.) Checking only after the loop noticed
          // that one workout too late.
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
            // current one: `ResolvedWrite.workoutId` exists precisely because
            // by now it can be a DIFFERENT workout — a peer replacing this one
            // mid-flush made every remaining set validate against its
            // successor. And `flushed[i].blockId` is still undefined for a set
            // that came out of the create cache, which took the parent and
            // workout-status checks out of `writeSet` altogether.
            const outcome = await writeSet(
              repo, blockId, {done, completedAt}, flushed[i].unit,
              entryId ?? flushed[i].blockId, forWorkout,
            )
            if (outcome === 'gone') {
              // A set this screen shows as accepted is not there any anymore —
              // deleted from the outline, or undone, since the last emission.
              // Finishing anyway would prune whatever that leaves empty and
              // then report the session as logged INCLUDING that set, off a
              // draft that is now fiction. Stop and re-read instead; the ticks
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
        // The session moved while this was running. Sets written before that
        // point DID land in the workout they belonged to — say that, rather
        // than the old message's claim that nothing was logged, which sent
        // the user looking for data that exists.
        setStatus(SESSION_MOVED)
        return
      }

      // Decided from the history as it stands BEFORE this session joins it,
      // and handed to `finishWorkout` to write in the SAME transaction.
      //
      // Neither side of it survives alone. Written FIRST, a finish that
      // refuses the tree (a set buried under a note, an untyped child holding
      // sets) leaves a break recorded as ending on an attempt that never
      // completed — and `layoffAlreadyRecorded` matches on `from` alone, so
      // finishing days later keeps that stale `to`. Written AFTER, a failure
      // loses the record for good: this session is the latest full one by
      // then, so the gap it describes is no longer detectable on any later
      // day, and the ramp silently ends after the first session back. The gap
      // is the whole point of the record — it picks the load-cut tier.
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
        // store's transaction — unchecked from the outline, or deleted on
        // another device. Finishing would have pruned the tree to nothing and
        // still reported the session logged, leaving a training day in the
        // record with no work in it. The workout is untouched and still ours,
        // so this is the same answer the per-set `gone` above gives: re-read
        // and let the user look before they tap again.
        setResync(n => n + 1)
        setStatus('Something changed while saving — the log has been re-read. Check it and tap Finish again.')
        return
      }
      if (outcome === 'gone') {
        // Someone else finished it between this view's last check and the
        // store's transaction. The session IS logged — just not by us — so
        // letting go of it is right and claiming to have logged it is not.
        coordinator.completed(wid)
        setStatus('That session was already finished elsewhere — nothing more to log.')
        return
      }
      // Tonight's log is now a RECORD, and this view must stop being attached
      // to it. Nothing else says so: a finished workout simply leaves
      // `liveWorkouts`, which is indistinguishable from a query that hasn't
      // caught up — so the coordinator kept its id (a same-slot reset never
      // falls back to null, on purpose) and the overlay kept every block id on
      // screen. `started` stayed true, which left the DISCARD button live: one
      // tap and the session just logged was tombstoned. Taps on the still-
      // rendered sets wrote into finished blocks, moving the next session's
      // prescribed weight; Finish answered "still catching up" forever.
      //
      // `completed`, not `abandon`: both stop in-flight creates from landing,
      // but `abandon` is "this evening is empty again" and this is "this
      // evening holds a finished workout" — the next session of the same type
      // gets a new slot rather than adopting this one.
      // …and the workout it FINISHED, by id. A peer can replace the workout
      // while `finishWorkout` is in the air, and releasing whatever happened
      // to be attached by then detached a live session on a finished one's
      // behalf: its Discard and Finish stopped working, and the next tap
      // opened a third workout for the evening.
      const wasOnScreen = coordinator.workoutId() === wid
      coordinator.completed(wid)
      // Clearing the draft is right only when what we finished is what is
      // being displayed. If a peer replaced it mid-finish, the replacement is
      // still attached and still ours to log into — and wiping it back to the
      // prescription hid its logged values behind defaults with nothing left
      // to bring them back: it had already been emitted, so no dependency of
      // the overlay effect changes afterwards.
      //
      // The resync on the other branch is belt-and-braces, and deliberately
      // left in: the emission that made `wasOnScreen` false has ALREADY
      // re-run the overlay (`live` is a dependency of it), so the only input
      // a resync can pick up that the emission could not is `writing` — the
      // in-flight-set exemption, which is deliberately not a dependency, and
      // which a write landing after that emission would otherwise leave stale
      // until the next one. No test drives that, and the mutant survives; it
      // stays because re-deriving after letting go of a workout costs one
      // render and the alternative is a draft nothing will correct.
      if (wasOnScreen) setDraft(buildDraft(prescription, unit))
      else setResync(n => n + 1)
      const lifts = flushed.filter(ex => ex.sets.some(s => s.done)).length
      setStatus(`Logged ${SESSION_LABELS[session]} — ${lifts} lifts`)

      // The workout is SAVED from here on, so nothing after this point may
      // report it as unsaved. The shoulder check is a follow-up prompt, and a
      // failure in it used to reach `finish`'s caller as "Could not save that
      // — tap it again" over a session that was already logged. Tapping again
      // now starts a second session for tonight, because the coordinator has
      // released this one.
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
    // this is about to tombstone (they'd be live todo sets under a deleted
    // workout). `abandon` makes those results yield nothing.
    coordinator.abandon()
    try {
      const outcome = await discardWorkout(repo, wid)
      // The failures belonged to blocks that no longer exist. Left behind,
      // they outlived the workout and the NEXT session of the same type
      // inherited them — Finish then reported an unsaved change that belonged
      // to a workout the user had thrown away. (True of a REFUSED discard too:
      // that session is a finished record now, so a warning about a write into
      // it is no longer something to act on.)
      //
      // THIS workout's, though — not the whole evening's. Two workouts can
      // share a slot, and clearing by slot took down a failure belonging to
      // the one that came before: if that one came back, Finish no longer
      // warned about a change it had never saved. A null-workout failure goes
      // too — it is the current attempt's, which is the one being discarded.
      for (const [id, failed] of failedRef.current) {
        if (failed.slot !== slot) continue
        if (failed.workout === wid || failed.workout === null) failedRef.current.delete(id)
      }
      // Back to the bare prescription only if the evening is actually empty
      // now. `abandon` above let go of this workout, but a peer's session can
      // be adopted onto the slot while the delete is in flight — and wiping
      // the draft then hides ITS logged values behind defaults with nothing
      // left to bring them back, because its emission already ran the overlay
      // and no dependency changes afterwards. Same rule Finish follows: reset
      // what we let go of, re-derive over what took its place.
      if (coordinator.workoutId() === null) setDraft(buildDraft(prescription, unit))
      else setResync(n => n + 1)
      // The store refuses to discard a session that is already finished —
      // someone else finished it between this screen rendering and the tap.
      // Letting go of it is still right (it is not ours to write into any
      // more), but saying "Discarded" over a session that is safely logged
      // would send the user looking for data that is right where they left it.
      setStatus(outcome === 'discarded'
        ? 'Discarded'
        : 'That session was already finished elsewhere — nothing was discarded.')
    } catch (error) {
      // The workout is still there. `abandon` already let go of it — and
      // nothing will hand it back, because the release retires on an
      // authoritative ABSENCE and this workout is present. Left that way a
      // second Discard did nothing, Finish answered "session changed", and
      // the only way out was a remount. (It also went unreported: this had no
      // catch at all, so a failed delete was an unhandled rejection.)
      coordinator.restore(wid)
      // A create that resolved between `abandon` and this rejection yielded
      // no block, and `persist` reads no block as nothing to do — so a value
      // the user typed just before discarding is on screen and in no block,
      // on a workout that survived. Rebuild from the blocks: their answer is
      // the true one, and the alternative is Finish logging around a value
      // that nothing holds. Deliberately not re-issued — the tap the user
      // actually made was Discard, so putting the edit back is not ours to
      // assume.
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
  // Derived from the draft rather than the coordinator: the coordinator lives
  // in a ref, so reading it here wouldn't re-render when the workout appears.
  // Every materialized row carries a block id, which is the same signal —
  // EXCEPT when the workout's entries are all outside the current
  // prescription, which an `or`-group switch does routinely: the overlay
  // omits the option switched away from and the new one has no blocks yet, so
  // no row carries an id while a whole workout sits there. Discard vanished
  // with it, and with nothing accepted Finish was disabled too, leaving no
  // way to remove the workout or its open todo subtree.
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
              // Switching mid-save reseeds the draft under the operation in
              // flight, which used to split one session's sets across two
              // workouts (and finish the wrong one).
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
            // shape, which bumps the coordinator's generation — under a
            // running Finish that aborts it with "Session changed while
            // saving". It was the one control that could move the ground
            // under a save in progress.
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

/** The one place uncommitted state lives.
 *
 *  Keystrokes stay inside this input until blur, so the draft — and every
 *  block under it — only ever holds settled values. That is what lets the
 *  live overlay apply unconditionally: there is nothing half-typed anywhere
 *  for it to overwrite. The alternative (keystrokes in the shared draft)
 *  needs a per-set dirty flag on every set to stay safe, which is a lot of
 *  machinery to protect one text field.
 *
 *  It also stops a full re-render of every card on each digit. */
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
  // moved it: comparing against `value` instead would commit whenever the
  // block changed underneath a focused field, writing the number the user was
  // merely looking at back over the newer one.
  const enteredRef = useRef('')
  const backingRef = useRef(backingId)

  // The row is still the same row — same lift, same set index, so React keeps
  // this input mounted — but it is now editing a different BLOCK. A peer
  // finishing our session and starting the next one does that: the draft
  // reseeds onto the replacement's sets while a field is focused, and the
  // rule below (never overwrite text under the cursor) would hold half-typed
  // digits meant for the old session and commit them into the new one's set
  // on blur, over whatever the peer logged there.
  //
  // `undefined -> id` is NOT that: it is our own create handing back the id
  // for the set already being edited, and remounting or reseeding there would
  // throw away the number the user is in the middle of typing.
  if (backingId !== backingRef.current) {
    // Any move AWAY from a block we had is abandonment — to another block, or
    // to none at all. The second case is a peer finishing the session without
    // starting a replacement: the draft resets to the prescription and the
    // row loses its id, and holding the text through that meant a blur
    // afterwards committed the finished session's digits into a workout the
    // commit itself had to create.
    //
    // Only `undefined -> id` is benign: our own create naming the set already
    // being typed into, which is the first number of every session.
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
      // Enter is how you say "done with this field" on a phone keyboard.
      // Without it the typed value lives only in the DOM until something else
      // blurs it — lock the phone first and it is gone.
      onKeyDown={e => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
      // Persist the settled value on blur (cheap, and the block is the record).
      onBlur={e => {
        setEditing(false)
        const raw = e.currentTarget.value
        if (raw === enteredRef.current) {
          // Untouched. Resync to the PROP, not to what is on screen: the block
          // may have moved while this field was focused, and the catch-up
          // above is keyed on `value !== shown`, which by now is false — so
          // this is the only remaining chance to stop showing a stale number.
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
