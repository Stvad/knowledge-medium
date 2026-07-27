// @vitest-environment happy-dom

/** The logging surface, driven the way a user drives it.
 *
 *  Every review round of this extension found bugs in this file's subject —
 *  tap → resolve → write → the block coming back — and none of them could be
 *  caught by the suite, because the whole sequence lived in React state that
 *  no test could reach. So it is reached here: a real render, real taps, and
 *  a fake backend that behaves like the real one in the two ways that matter.
 *
 *    - Blocks are addressed by DERIVED id, so writing the same session twice
 *      ADOPTS what is already there and leaves its values alone.
 *    - The query is not the write. The test decides when the blocks come
 *      back, because "an emission landed in the middle of that" is the shape
 *      of nearly every bug here.
 */

import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {useState} from 'react'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

import type {Repo} from '@/data/repo.js'

import type {LiveExercise, LiveSet, LiveWorkout} from '../src/km/history'
import type {ExerciseDraft, ExerciseEntryIds, MaterializedWorkout, SetDraft} from '../src/km/store'
import type {Prescription, PrescribedExercise, SessionType, WorkoutRecord} from '../src/engine/types'
import {DEFAULT_CONFIG} from '../src/program/defaults'
import {TonightView} from '../src/ui/TonightView'
import type {ProgramState} from '../src/ui/useProgram'
import {setDialogAnswer} from './kernel/dialogs'

vi.mock('../src/km/store', () => ({
  startWorkout: vi.fn(),
  materializeExercise: vi.fn(),
  writeSet: vi.fn(),
  finishWorkout: vi.fn(),
  discardWorkout: vi.fn(),
  writeLayoff: vi.fn(),
  writeShoulderTodo: vi.fn(),
  // Pulled in by `km/config`, which the view imports for one constant.
  readAltChoices: vi.fn(async () => ({})),
}))

const store = await import('../src/km/store')

const DAY = '2026-07-25'

// ──── a backend with the properties that matter ────

/** How the WRITE side names an entry's block — `store.ts`'s `exerciseIdentity`,
 *  not the reader's `liftKey`.
 *
 *  Deliberately its own copy of the write-side spelling. Sharing one key
 *  function with the matcher under test makes the two agree by construction,
 *  and "the writer and the reader disagree about which block this row is" is
 *  precisely the class of bug this suite has to be able to see. */
const entryBlockId = (definitionId: string | undefined, exercise: string, occurrence: number): string =>
  `e:${definitionId ?? exercise}${occurrence === 0 ? '' : `|${occurrence}`}`

const createBackend = () => {
  /** Entries by block id, in creation order — the shape a workout's children
   *  actually have. */
  const entries = new Map<string, LiveExercise>()
  let started = false
  let workoutId = 'w1'
  let session: SessionType = 'A'
  let finished = false
  /** Writes park here while a test holds them, so it can decide what happens
   *  in the window between a tap and its block coming back. */
  let held: (() => void)[] | null = null

  /** The EFFECT is deferred, not just the promise. A held write must leave
   *  the blocks exactly as they were — otherwise an emission taken during the
   *  hold already carries the news, and a test of "what does the view do
   *  before its write lands" quietly tests nothing. */
  const settle = <T,>(apply: () => T): Promise<T> =>
    held
      ? new Promise<T>(resolve => held!.push(() => resolve(apply())))
      : Promise.resolve(apply())

  const upsertEntry = (ex: ExerciseDraft, entryId?: string): ExerciseEntryIds => {
    // `entryId` wins when the caller has one — the row is attached to an entry
    // whose id need not re-derive. Modelling that is the point: without it the
    // fake would silently make the two spellings the same block.
    const id = entryId ?? entryBlockId(ex.definitionId, ex.exercise, ex.occurrence)
    const existing = entries.get(id)
    // Adopting: a set that already exists keeps the values it holds. This is
    // the derived-id contract, and the bug it exists to prevent (the caller
    // writing its pre-filled draft over logged reps) is only visible against
    // a fake that honours it.
    const sets: LiveSet[] = ex.sets.map((s, i) => existing?.sets[i] ?? ({
      id: `${id}|${i}`,
      weight: s.weight,
      reps: s.reps,
      done: s.done,
      ...(s.side !== undefined ? {side: s.side} : {}),
      ...(s.completedAt !== undefined ? {completedAt: s.completedAt} : {}),
    }))
    entries.set(id, {
      id,
      exercise: existing?.exercise ?? ex.exercise,
      definitionId: existing?.definitionId ?? ex.definitionId,
      unit: ex.unit,
      sets,
    })
    return {id, setIds: sets.map(s => s.id)}
  }

  const findSet = (setId: string): LiveSet | undefined => {
    for (const entry of entries.values()) {
      const found = entry.sets.find(s => s.id === setId)
      if (found) return found
    }
    return undefined
  }

  return {
    /** What the live query would answer right now. A FINISHED workout is
     *  absent, exactly as `buildLiveWorkouts` drops anything that isn't
     *  `in-progress` — which is the emission that matters most here, because
     *  "no live workout" and "the query is behind" look identical. */
    live: (): LiveWorkout[] =>
      started && !finished ? [{id: workoutId, day: DAY, session, exercises: [...entries.values()]}] : [],

    /** A different workout on the same evening — what a peer finishing ours
     *  and starting the next one looks like from here. */
    replaceWorkout: (nextId: string) => {
      workoutId = nextId
    },

    /** Which session the in-progress workout belongs to. */
    setSession: (next: SessionType) => {
      session = next
    },

    /** Seed a session that is already in progress — a reload, or another
     *  device. Values here are deliberately NOT the prescription's. */
    seed: (exercise: string, sets: readonly Partial<LiveSet>[], definitionId?: string) => {
      started = true
      const id = entryBlockId(definitionId, exercise, 0)
      entries.set(id, {
        id,
        exercise,
        definitionId,
        unit: 'lb',
        sets: sets.map((s, i) => ({id: `${id}|${i}`, weight: 0, reps: 0, done: false, ...s})),
      })
    },

    setById: findSet,
    entryIds: (): string[] => [...entries.keys()],
    /** A set block deleted from the outline, by undo, or by another device. */
    deleteSet: (setId: string) => {
      for (const entry of entries.values()) {
        entry.sets = entry.sets.filter(s => s.id !== setId)
      }
    },

    /** Park every write until `release()`. */
    hold: () => {
      held = []
    },
    /** Let parked writes land — all of them, or just the first `count`.
     *
     *  A counted release STAYS held, so writes the caller makes next park too.
     *  Lifting the hold as soon as the queue drained let the rest of a batch
     *  run to completion inside the release, which closed the very window
     *  these tests exist to sit in — two mutants survived on that alone. */
    release: async (count?: number) => {
      const parked = held ?? []
      const landing = count === undefined ? parked.splice(0) : parked.splice(0, count)
      if (count === undefined) held = null
      await act(async () => {
        for (const resolve of landing) resolve()
      })
    },

    startWorkout: (draft: {exercises: readonly ExerciseDraft[]}): Promise<MaterializedWorkout> =>
      settle(() => {
        started = true
        return {workoutId: 'w1', exercises: draft.exercises.map(ex => upsertEntry(ex))}
      }),

    materializeExercise: (_workoutId: string, ex: ExerciseDraft, entryId?: string): Promise<ExerciseEntryIds> =>
      settle(() => upsertEntry(ex, entryId)),

    /** Prunes and flips to done, like the real one — so the emission AFTER a
     *  finish is modelled, which is where the finish path actually breaks. */
    finishWorkout: (): Promise<void> =>
      settle(() => {
        for (const [id, entry] of entries) {
          if (!entry.sets.some(s => s.done)) entries.delete(id)
          else entry.sets = entry.sets.filter(s => s.done)
        }
        finished = true
      }),

    /** Refuses a finished session, like the real one: Discard is enabled from
     *  a render, and a peer's finish can land before the click. */
    discardWorkout: (): Promise<'discarded' | 'gone'> =>
      settle(() => {
        if (!started || finished) return 'gone' as const
        entries.clear()
        started = false
        return 'discarded' as const
      }),

    writeSet: (setId: string, patch: Partial<SetDraft>): Promise<'written' | 'gone'> =>
      settle(() => {
        const set = findSet(setId)
        if (!set) return 'gone' as const
        if (patch.weight !== undefined) set.weight = patch.weight
        if (patch.reps !== undefined) set.reps = patch.reps
        if (patch.done !== undefined) set.done = patch.done
        if ('completedAt' in patch) {
          if (patch.completedAt === undefined) delete set.completedAt
          else set.completedAt = patch.completedAt
        }
        return 'written' as const
      }),
  }
}

type Backend = ReturnType<typeof createBackend>

// ──── the harness ────

const exercise = (over: Partial<PrescribedExercise> = {}): PrescribedExercise => ({
  exercise: 'Bench press',
  sets: 2,
  repMin: 6,
  repMax: 8,
  weight: 185,
  perSide: false,
  freeform: false,
  rationale: 'double progression',
  ...over,
})

const prescriptionOf = (
  exercises: PrescribedExercise[] = [exercise()],
  session: SessionType = 'A',
): Prescription => ({
  day: DAY,
  session,
  offSchedule: false,
  notes: [],
  exercises,
})

const repo = {isReadOnly: false} as unknown as Repo

/** Publishes the backend's current state into the view, i.e. one query
 *  emission. Assigned during render — the harness is the only renderer. */
let publish: () => void = () => {}

function Harness({
  backend,
  prescriptions,
  configLoaded,
  history,
}: {
  backend: Backend
  /** One prescription per session, so switching is a real switch: `slot`
   *  changes, and the two sessions can prescribe the same lift. */
  prescriptions: Partial<Record<SessionType, Prescription>>
  configLoaded: boolean
  /** Finished sessions. The shoulder check is due on every fourth one, so
   *  this is the only way to reach the post-Finish follow-up at all. */
  history: readonly WorkoutRecord[]
}) {
  const [liveWorkouts, setLiveWorkouts] = useState<readonly LiveWorkout[] | undefined>(undefined)
  const [session, setSession] = useState<SessionType>('A')
  publish = () => setLiveWorkouts(backend.live())

  const program: ProgramState = {
    config: DEFAULT_CONFIG,
    warnings: [],
    planRootId: 'plan',
    settingsBlockId: 'settings',
    history,
    layoffs: [],
    liveWorkouts: liveWorkouts ?? [],
    // Unresolved until the test publishes — the real hook says the same thing
    // with `undefined` from the query handle.
    liveLoaded: liveWorkouts !== undefined,
    configLoaded,
    day: DAY,
    session,
    setSession: next => setSession(next ?? 'A'),
    prescription: prescriptions[session] ?? prescriptionOf([], session),
    setAltChoice: () => {},
    reload: () => {},
  }
  return <TonightView repo={repo} workspaceId="ws" pageId="page" program={program} />
}

const mount = (
  backend: Backend,
  options: {
    prescription?: Prescription
    prescriptions?: Partial<Record<SessionType, Prescription>>
    configLoaded?: boolean
    history?: readonly WorkoutRecord[]
  } = {},
) =>
  render(
    <Harness
      backend={backend}
      prescriptions={options.prescriptions ?? {A: options.prescription ?? prescriptionOf()}}
      configLoaded={options.configLoaded ?? true}
      history={options.history ?? []}
    />,
  )

/** `n` finished full sessions — enough to make the shoulder check due. */
const pastSessions = (n: number): WorkoutRecord[] =>
  Array.from({length: n}, (_, i) => ({
    id: `past-${i}`,
    date: `2026-07-${String(10 + i).padStart(2, '0')}T18:00:00.000Z`,
    session: 'A' as SessionType,
    exercises: [],
  }))

/** Point the mocked store at a backend. Both suites need it, and the copy that
 *  drifts is the one that lies. */
const wire = (backend: Backend) => {
  vi.mocked(store.startWorkout).mockImplementation((_repo, _ws, _page, draft) =>
    backend.startWorkout(draft))
  vi.mocked(store.materializeExercise).mockImplementation((_repo, workoutId, ex, entryId) =>
    backend.materializeExercise(workoutId, ex, entryId))
  vi.mocked(store.writeSet).mockImplementation((_repo, setId, patch) => backend.writeSet(setId, patch))
  vi.mocked(store.finishWorkout).mockImplementation(() => backend.finishWorkout())
  vi.mocked(store.discardWorkout).mockImplementation(() => backend.discardWorkout())
}

/** One query emission. */
const emit = async () => {
  await act(async () => {
    publish()
  })
}

const checkboxes = () => screen.getAllByRole('checkbox') as HTMLInputElement[]
const weights = () => screen.getAllByLabelText('weight') as HTMLInputElement[]
const reps = () => screen.getAllByLabelText('reps') as HTMLInputElement[]

// ──── tests ────

describe('TonightView', () => {
  let backend: Backend

  beforeEach(() => {
    vi.clearAllMocks()
    backend = createBackend()
    wire(backend)
  })

  afterEach(cleanup)

  it('materializes the session on the first tap', async () => {
    mount(backend)
    fireEvent.click(checkboxes()[0])

    await waitFor(() => expect(store.startWorkout).toHaveBeenCalledTimes(1))
    await emit()
    expect(checkboxes()[0].checked).toBe(true)
    expect(backend.live()[0].exercises[0].sets[0].done).toBe(true)
  })

  it('holds a tick while the block it will live in is still being created', async () => {
    // The exemption has to start BEFORE the block is resolved, because at the
    // first tap of the night there is no block id yet to key it on. What can
    // arrive in that window is another device's copy of this session — derived
    // ids mean it is the same workout, and its sets are still open, because
    // the tap that would tick one is happening HERE.
    //
    // Deliberately unseeded at mount: with a session already on screen,
    // `resolveSet` hands back a block id immediately and this window never
    // opens, which is why a seeded version of this test passes with the
    // exemption deleted.
    backend.hold()
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await act(async () => {})

    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    await emit()
    expect(checkboxes()[0].checked).toBe(true)

    await backend.release()
    await emit()
    expect(checkboxes()[0].checked).toBe(true)
  })

  it('does not un-tick when an emission lands while the tick is still being written', async () => {
    // The block still says `open` — this tick's write has not reached it yet.
    // Letting that emission win reverted every tap for a whole query round
    // trip: a checkbox that flickers off under your thumb, and during an
    // "all ✓" it ripples through every set the loop has not got to.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    backend.hold()
    fireEvent.click(checkboxes()[0])
    await act(async () => {})
    await emit()                                   // the pre-write block state
    expect(checkboxes()[0].checked).toBe(true)

    await backend.release()
    await emit()
    expect(checkboxes()[0].checked).toBe(true)
  })

  it('un-ticks a set someone cleared elsewhere once the write settles', async () => {
    // The exemption is a window, not a licence: after the write lands, the
    // block is the record again, including when it disagrees.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    backend.setById('e:Bench press|0')!.done = false
    await emit()
    expect(checkboxes()[0].checked).toBe(false)
  })

  it('leaves the values of an adopted session alone when you tick a set', async () => {
    // Reload mid-workout: the blocks hold 205 × 5, the prescription still
    // says 185 × 8. Tapping "done" used to write the whole draft row, so the
    // reps actually performed were replaced by the prescribed ones.
    backend.seed('Bench press', [{weight: 205, reps: 5}, {weight: 205, reps: 5}])
    mount(backend)
    await emit()
    expect(weights()[0].value).toBe('205')

    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()

    expect(vi.mocked(store.writeSet).mock.calls[0][2]).toEqual({done: true, completedAt: expect.any(Number)})
    expect(backend.setById('e:Bench press|0')).toMatchObject({weight: 205, reps: 5, done: true})
    expect(weights()[0].value).toBe('205')
  })

  it('shows a tick made somewhere else — the outline, another device', async () => {
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()
    expect(checkboxes()[0].checked).toBe(false)

    backend.setById('e:Bench press|0')!.done = true
    await emit()
    expect(checkboxes()[0].checked).toBe(true)
  })

  it('waits for a field write already in the air before finalizing', async () => {
    // Tapping Finish blurs whatever field was focused, which STARTS a write —
    // and Finish reasserts only acceptance, so that number is not something
    // it writes itself. Finalizing around it logged and released the session
    // with the edit still in flight, and a failure then had nowhere to go.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    backend.hold()
    const field = weights()[0]
    act(() => field.focus())
    fireEvent.change(field, {target: {value: '195'}})
    fireEvent.blur(field)                         // the weight write parks
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await act(async () => {})
    expect(store.finishWorkout).not.toHaveBeenCalled()   // still waiting

    await backend.release()
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
    expect(backend.setById('e:Bench press|0')).toMatchObject({weight: 195})
  })

  it('validates a stale write against the session it was resolved for', async () => {
    // The coordinator lets a write for the session you just left finish. If
    // the caller then validates it against the workout it is on NOW, the
    // chain check rejects a perfectly good set and the tap is lost.
    const both = {
      A: prescriptionOf([exercise()], 'A'),
      B: prescriptionOf([exercise({exercise: 'Squat', weight: 225})], 'B'),
    }
    mount(backend, {prescriptions: both})

    backend.hold()
    fireEvent.click(checkboxes()[0])              // starts session A
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', {name: 'B · lower'}))
    await act(async () => {})
    await backend.release()                      // A's create + write land now

    const calls = vi.mocked(store.writeSet).mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][5]).toBe('w1')               // A's workout, not B's absence
    expect(backend.setById('e:Bench press|0')).toMatchObject({done: true})
  })

  it('suppresses a failure once its workout has been replaced', async () => {
    // The same first-tap operation, but this time the workout it created has
    // been replaced by the time the write fails. It belongs to the one it
    // made, not to whatever is on screen now — treating its initial `null`
    // as a permanent wildcard put the warning on the successor.
    let failWrite: (error: Error) => void = () => {}
    vi.mocked(store.writeSet).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failWrite = reject }),
    )
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.startWorkout).toHaveBeenCalled())
    await emit()

    backend.replaceWorkout('w2')
    await emit()

    await act(async () => { failWrite(new Error('offline')) })
    expect(screen.queryByText(/Could not save that/)).toBeNull()
  })

  it('still reports a failure from the tap that created the workout', async () => {
    // The first tap of the night starts with no workout at all, and by the
    // time its write fails the create it triggered has produced one. That
    // operation belongs to the workout it made, so its failure has to be
    // shown — a stricter "must equal the current workout" would swallow the
    // one failure the user most needs to see.
    let failWrite: (error: Error) => void = () => {}
    vi.mocked(store.writeSet).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failWrite = reject }),
    )
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.startWorkout).toHaveBeenCalled())

    await act(async () => { failWrite(new Error('offline')) })
    expect(screen.getByText(/Could not save that/)).toBeTruthy()
  })

  it('does not put a replaced workout\'s failure on the one that took its place', async () => {
    // A peer finished ours and started the next one: same day, same session,
    // different workout. The slot comparison alone let a late rejection from
    // the first land on the second's screen, where nothing could clear it.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    let failFirst: (error: Error) => void = () => {}
    vi.mocked(store.writeSet).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failFirst = reject }),
    )
    fireEvent.click(checkboxes()[0])            // against w1, still pending
    await act(async () => {})

    backend.replaceWorkout('w2')                // the peer's next session arrives
    await emit()

    await act(async () => { failFirst(new Error('offline')) })
    expect(screen.queryByText(/Could not save that/)).toBeNull()
  })

  it('takes down a warning the workout that replaced this one has no failure for', async () => {
    // The other order: the failure is REPORTED while w1 is still current, and
    // the peer's replacement arrives after. The warning is about a workout
    // that is no longer on screen, so no later write can be a retry of it —
    // and it sat there over a session where everything was saving, which is
    // what invites the second, reversing tap.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    fireEvent.click(checkboxes()[1])            // fails against w1, and says so
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    backend.replaceWorkout('w2')                // the peer's next session arrives
    await emit()

    fireEvent.click(checkboxes()[1])            // a write on w2, which works
    await waitFor(() => expect(screen.queryByText(/Could not save that/)).toBeNull())
  })

  it('does not put a left session\'s failure on the screen you switched to', async () => {
    // The marker is keyed to the session it failed on, so a warning shown on
    // the other screen could never be cleared from there — it just sat, and
    // invited the second, reversing tap.
    const both = {
      A: prescriptionOf([exercise()], 'A'),
      B: prescriptionOf([exercise({exercise: 'Squat', weight: 225})], 'B'),
    }
    mount(backend, {prescriptions: both})

    // The rejection has to land AFTER the switch — rejecting before it would
    // be cleared by the slot change instead, which is a different mechanism.
    let failA: (error: Error) => void = () => {}
    vi.mocked(store.startWorkout).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failA = reject }),
    )
    fireEvent.click(checkboxes()[0])              // session A, still pending
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', {name: 'B · lower'}))
    await act(async () => {})

    await act(async () => { failA(new Error('offline')) })
    expect(screen.queryByText(/Could not save that/)).toBeNull()
  })

  it('clears the warning on the screen whose write succeeded', async () => {
    // A failure left over from the session you switched AWAY from kept the
    // warning up on a screen where everything had saved — which invites the
    // second, reversing tap.
    const both = {
      A: prescriptionOf([exercise()], 'A'),
      B: prescriptionOf([exercise({exercise: 'Squat', weight: 225})], 'B'),
    }
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend, {prescriptions: both})
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    fireEvent.click(checkboxes()[0])                       // session A fails
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', {name: 'B · lower'}))
    backend.setSession('B')
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    fireEvent.click(checkboxes()[0])                       // …and so does B
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(checkboxes()[0])                       // B's retry works
    await waitFor(() => expect(screen.queryByText(/Could not save that/)).toBeNull())
  })

  it('does not warn about a write a later one has already superseded', async () => {
    // Type a weight, then type another before the first lands. The second
    // write saves the number now on screen, so the first's failure is about a
    // value the user has already replaced — recording it anyway put "tap it
    // again" over a saved set and made Finish pause once for nothing.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    let failFirst: (error: Error) => void = () => {}
    vi.mocked(store.writeSet).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failFirst = reject }),
    )
    act(() => weights()[0].focus())
    fireEvent.change(weights()[0], {target: {value: '195'}})
    fireEvent.blur(weights()[0])
    await act(async () => {})

    act(() => weights()[0].focus())
    fireEvent.change(weights()[0], {target: {value: '205'}})
    fireEvent.blur(weights()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalledTimes(2))

    await act(async () => { failFirst(new Error('offline')) })
    expect(screen.queryByText(/Could not save that/)).toBeNull()

    // …and nothing is held back from finishing over it either.
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
  })

  it('says so rather than claiming a discard the store refused', async () => {
    // Discard is enabled from what was last rendered, and a peer's finish can
    // land before the tap. The store refuses to tombstone a finished record —
    // so the view must not report "Discarded" over a session that is sitting
    // safely logged, which would send the user hunting for data that is right
    // where they left it.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    await backend.finishWorkout()          // a peer finishes it; no emission here
    fireEvent.click(screen.getByRole('button', {name: 'Discard'}))

    await waitFor(() => expect(screen.getByText(/already finished elsewhere/)).toBeTruthy())
    expect(screen.queryByText(/^Discarded$/)).toBeNull()
  })

  it('binds a batch that started before the workout to the workout it made', async () => {
    // "all ✓" on a session with no workout yet: the batch's own context is
    // created before there is a workout to name, and a null workout matches
    // whatever is current. Left that way after the batch's first set resolved
    // one, a peer replacing the workout mid-batch inherited it — the new
    // session's Finish waited on the old one's writes, and a late rejection
    // put the old one's warning on the new one's screen.
    mount(backend)

    let failWrite: (error: Error) => void = () => {}
    vi.mocked(store.writeSet).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failWrite = reject }),
    )
    fireEvent.click(screen.getByRole('button', {name: 'all ✓'}))
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())   // w1 exists by now

    backend.replaceWorkout('w2')          // a peer's session takes its place
    await emit()

    await act(async () => { failWrite(new Error('offline')) })
    expect(screen.queryByText(/Could not save that/)).toBeNull()
  })

  it('lets each write in a batch answer for its own set', async () => {
    // "all ✓" ran every set through ONE operation context, and `persist`
    // rewrites that context's set as it goes — so by the end of the loop the
    // success recorded for set 1 claimed to be about set 2. An earlier
    // failure on set 1, which the batch had just re-saved, was then reported
    // as unsaved and made Finish pause over it.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    let failFirst: (error: Error) => void = () => {}
    vi.mocked(store.writeSet).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failFirst = reject }),
    )
    fireEvent.click(checkboxes()[0])        // un-tick set 1 — parked, and will fail
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', {name: 'all ✓'}))
    await waitFor(() => expect(store.writeSet).toHaveBeenCalledTimes(3))

    await act(async () => { failFirst(new Error('offline')) })
    expect(screen.queryByText(/Could not save that/)).toBeNull()

    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
  })

  it('does not let one session\'s write settle the other session\'s failure', async () => {
    // Two sessions of the same week can prescribe the SAME lift, and the
    // change a write is about is named by lift and set index — so A's first
    // set and B's first set have the same name. Settling on that alone let a
    // success on B take down a failure on A, and A's Finish then finalized a
    // value that had never reached a block, silently.
    const both = {
      A: prescriptionOf([exercise()], 'A'),
      B: prescriptionOf([exercise()], 'B'),
    }
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend, {prescriptions: both})
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    fireEvent.click(checkboxes()[1])                       // session A fails
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', {name: 'B · lower'}))
    backend.setSession('B')
    await emit()

    fireEvent.click(checkboxes()[1])                       // the same set, on B
    await waitFor(() => expect(store.writeSet).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', {name: 'A · upper'}))
    backend.setSession('A')
    await emit()

    // A's failure is still true: nothing on A has been retried.
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(screen.getByText(/did not save/)).toBeTruthy())
    expect(store.finishWorkout).not.toHaveBeenCalled()
  })

  it('does not make one session wait on another session\'s write', async () => {
    // The coordinator deliberately lets a write for the session you just left
    // finish on its own. A Finish on the session you switched TO must not wait
    // for it — a slow one left B stuck on "Saving…", and a failing one blocked
    // B with an error belonging to a different evening's log.
    const both = {
      A: prescriptionOf([exercise()], 'A'),
      B: prescriptionOf([exercise({exercise: 'Squat', weight: 225})], 'B'),
    }
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend, {prescriptions: both})
    await emit()

    backend.hold()
    fireEvent.click(checkboxes()[1])          // a write on session A — parked
    await act(async () => {})

    fireEvent.click(screen.getByRole('button', {name: 'B · lower'}))
    backend.setSession('B')
    await emit()

    // B's own draft has nothing to flush (different lift), so Finish goes
    // straight to finalizing — unless it is still waiting on A.
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
  })

  it('says so rather than finalizing over a change that did not save', async () => {
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    const field = weights()[0]
    act(() => field.focus())
    fireEvent.change(field, {target: {value: '195'}})
    fireEvent.blur(field)
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(screen.getByText(/did not save/)).toBeTruthy())
    expect(store.finishWorkout).not.toHaveBeenCalled()

    // …and it does not refuse forever: a set that is gone will never write.
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
  })

  it('lets go when someone else finishes the workout', async () => {
    // The workout leaves `liveWorkouts` exactly as it does for our own
    // Finish, but nothing local said so — the coordinator kept the id, the
    // overlay kept the set ids, `started` stayed true, and Discard was one
    // tap away from tombstoning the session a peer had just logged.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()
    expect(screen.getByRole('button', {name: 'Discard'})).toBeTruthy()

    await backend.finishWorkout()             // the peer's finish syncs in
    await emit()

    expect(screen.queryByRole('button', {name: 'Discard'})).toBeNull()
    expect(checkboxes().some(box => box.checked)).toBe(false)
  })

  it('does not let go while its own create is still catching up', async () => {
    // The other side of the same signal: an absent workout we have NEVER seen
    // is a query behind our own create, and letting go there is the bug the
    // carry-forward exists to prevent.
    backend.hold()
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await act(async () => {})
    await emit()                              // loaded, and still no workout

    expect(checkboxes()[0].checked).toBe(true)
    await backend.release()
    await emit()
    expect(checkboxes()[0].checked).toBe(true)
  })

  it('lets go of the workout once it is finished', async () => {
    // A finished workout simply leaves `liveWorkouts` — indistinguishable, to
    // the overlay, from a query that hasn't caught up. Holding on left every
    // block id on screen: `started` stayed true so DISCARD stayed live, and
    // one tap tombstoned the session that had just been logged.
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()

    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
    await emit()

    expect(screen.queryByRole('button', {name: 'Discard'})).toBeNull()
    expect((screen.getByRole('button', {name: /Finish/}) as HTMLButtonElement).disabled).toBe(true)
    expect(checkboxes().some(box => box.checked)).toBe(false)
    // …and the confirmation the user has not read yet is still there.
    expect(screen.getByText(/Logged A · upper/)).toBeTruthy()
  })

  it('does not leave a value on screen that a failed discard cancelled', async () => {
    // Discard cancels the creates whose blocks it is about to tombstone, and
    // one that resolves in that window yields no block — which `persist`
    // reads as nothing to do. If the discard then FAILS, the workout is still
    // there and the draft was left showing a value no block holds: Finish
    // would log around it without a word.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend, {prescription: prescriptionOf([exercise(), exercise({exercise: 'Squat', weight: 225})])})
    await emit()

    let failDiscard: (error: Error) => void = () => {}
    vi.mocked(store.discardWorkout).mockImplementationOnce(
      () => new Promise((_resolve, reject) => { failDiscard = reject }),
    )

    backend.hold()
    fireEvent.click(checkboxes()[2])      // Squat's first set — it has no block yet
    await act(async () => {})
    expect(checkboxes()[2].checked).toBe(true)

    fireEvent.click(screen.getByRole('button', {name: 'Discard'}))
    await act(async () => {})
    await backend.release()               // the create lands, already cancelled

    await act(async () => { failDiscard(new Error('offline')) })
    await act(async () => {})

    expect(checkboxes()[2].checked).toBe(false)
  })

  it('lets go of the workout it finished, not the one that replaced it', async () => {
    // A peer can replace the workout while `finishWorkout` is in the air.
    // Releasing "whatever is attached now" detached the LIVE w2 on w1's
    // behalf: the session that had just started was reported as logged, its
    // Discard and Finish stopped working, and the next tap opened a third
    // workout for the evening.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    // Deliberately not the fake's own `finishWorkout`: the peer's w2 is still
    // live, so the query must go on reporting a workout for this slot.
    let landFinish: () => void = () => {}
    vi.mocked(store.finishWorkout).mockImplementationOnce(
      () => new Promise<void>(resolve => { landFinish = () => resolve() }),
    )
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())

    backend.replaceWorkout('w2')          // the peer's next session, same slot
    await emit()

    await act(async () => { landFinish() })

    // w2 is still ours to write into, so a tap goes to IT.
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.materializeExercise).toHaveBeenCalled())
    expect(store.startWorkout).not.toHaveBeenCalled()
  })

  it('does not write into the finished session through a query that has not caught up', async () => {
    // Finish releases the workout, but the workout QUERY can go on reporting
    // it in progress for a beat — and the overlay puts its set ids straight
    // back into the draft. Resolving a tap against a cached id while detached
    // sent the write out with NO workout to validate against, and the status
    // check is the thing that refuses a completed record: the write landed in
    // the finished session and moved the next one's prescribed weight.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    // The store finished it; the fake's query deliberately has not heard.
    vi.mocked(store.finishWorkout).mockResolvedValueOnce(undefined)
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
    await emit()                          // …still carrying the finished workout

    fireEvent.click(checkboxes()[0])
    await act(async () => {})
    const unvalidated = vi.mocked(store.writeSet).mock.calls.filter(call => call[5] === undefined)
    expect(unvalidated).toEqual([])
    await waitFor(() => expect(store.startWorkout).toHaveBeenCalledTimes(1))
  })

  it('starts a second session rather than editing the finished one', async () => {
    // The view's half of "session A twice tonight": it must ask the store to
    // start a session again, instead of resolving against the workout id it
    // was holding. Which BLOCKS that second session gets is the store's
    // contract — a finished workout fails `adoptable`, so the derivation
    // takes the next slot — and is covered where the store is.
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
    await emit()

    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.startWorkout).toHaveBeenCalledTimes(2))
    expect(store.materializeExercise).not.toHaveBeenCalled()
  })

  it('does not carry one session\'s blocks into another', async () => {
    // Two sessions can prescribe the same lift, and rows are matched BY the
    // lift — so what is on screen is not an input once the session changes.
    const both = {
      A: prescriptionOf([exercise({exercise: 'Face pulls', defId: 'def-face', weight: 40, sets: 1})], 'A'),
      B: prescriptionOf([exercise({exercise: 'Face pulls', defId: 'def-face', weight: 50, sets: 1})], 'B'),
    }
    mount(backend, {prescriptions: both})
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()

    vi.mocked(store.writeSet).mockClear()
    vi.mocked(store.startWorkout).mockClear()
    fireEvent.click(screen.getByRole('button', {name: 'B · lower'}))
    await act(async () => {})

    expect(checkboxes()[0].checked).toBe(false)
    expect(weights()[0].value).toBe('50')          // B's prescription, not A's
    backend.setSession('B')
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.startWorkout).toHaveBeenCalledTimes(1))
  })

  it('surfaces a write to a set block that is gone instead of swallowing it', async () => {
    // Undo is the likeliest cause: one transaction is one undo step, so a
    // single Cmd-Z after starting a session tombstones its whole subtree.
    // Silently succeeding left the box ticked and every later tap doing
    // nothing, with the footer still saying "Saved as you go".
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    backend.deleteSet('e:Bench press|1')
    fireEvent.click(checkboxes()[1])
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())
    await waitFor(() => expect(checkboxes()[1].checked).toBe(false))
  })

  it('re-attaches to an entry logged before the plan was readable', async () => {
    // `configLoaded` goes true even when the plan read FAILS, so a session can
    // legitimately be logged against name-keyed entries and then meet a
    // prescription that carries plan blocks. Refusing to match there showed a
    // pristine session over real logged sets and invited a second one.
    // One set on the block, two prescribed — so the second set has no block
    // and has to be filled in, which is the half of this that the narrow
    // fallback alone doesn't fix.
    backend.seed('Bench press', [{weight: 205, reps: 5, done: true}])
    mount(backend, {prescription: prescriptionOf([exercise({defId: 'def-bench'})])})
    await emit()

    expect(checkboxes()[0].checked).toBe(true)
    expect(weights()[0].value).toBe('205')

    // …and that second set goes under the entry the row is ATTACHED to, not
    // under a second entry derived from the plan block.
    fireEvent.click(checkboxes()[1])
    await waitFor(() => expect(store.materializeExercise).toHaveBeenCalled())
    await emit()
    expect(backend.entryIds()).toEqual(['e:Bench press'])
  })

  it('re-attaches when the plan is unreadable HERE but was not where the session started', async () => {
    // The mirror image of the case above, and it happens for the same reason:
    // this client's outline read failed, so its rows carry no plan block,
    // while the entries were written by a client whose read succeeded.
    // Orphaning them builds a second, name-keyed tree beside the real one.
    backend.seed('Bench press', [{weight: 205, reps: 5, done: true}, {weight: 205, reps: 5}], 'def-bench')
    mount(backend)                       // prescription has no defId
    await emit()

    expect(checkboxes()[0].checked).toBe(true)
    expect(weights()[0].value).toBe('205')
    fireEvent.click(checkboxes()[1])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()
    expect(backend.entryIds()).toEqual(['e:def-bench'])
  })

  it('does not report a finished workout as unsaved when the shoulder check fails', async () => {
    // Everything after `finishWorkout` is follow-up. Letting it reach the
    // caller's error handler said "Could not save that — tap it again" over a
    // session that WAS saved, and tapping again starts a second one for
    // tonight because the coordinator has already released this one.
    vi.mocked(store.writeShoulderTodo).mockRejectedValue(new Error('offline'))
    setDialogAnswer({checkedIds: ['t1'], checkedPrompts: ['aching']})
    // Three finished sessions, so this one is the fourth and the check is due.
    mount(backend, {history: pastSessions(3)})
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()

    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByText(/Could not save that/)).toBeNull()
    expect(screen.getByText(/Logged A · upper/)).toBeTruthy()
    setDialogAnswer(null)
  })

  it('refuses to log until the plan has been read, and says so', async () => {
    // Writing before the outline resolves derives entry ids from exercise
    // NAMES while the records that exist are keyed on their plan block — a
    // whole parallel tree of blocks for a session already in progress.
    mount(backend, {configLoaded: false})
    expect(screen.getByText('Reading your plan…')).toBeTruthy()
    // Every control, not just the checkbox — a blur commit and "all ✓" are
    // write paths too. (Clicking a disabled input asserts nothing: the DOM
    // swallows the event, so the earlier version of this test had no force
    // beyond this line.)
    expect(checkboxes().every(box => box.disabled)).toBe(true)
    expect(weights().every(field => field.disabled)).toBe(true)
    expect(screen.queryByRole('button', {name: 'all ✓'})).toBeNull()
    expect((screen.getByRole('button', {name: /Finish/}) as HTMLButtonElement).disabled).toBe(true)
  })

  it('reverts a tick whose write failed, and says why', async () => {
    vi.mocked(store.startWorkout).mockRejectedValue(new Error('offline'))
    mount(backend)
    fireEvent.click(checkboxes()[0])

    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())
    // One commit later than the message: the revert is the overlay re-running,
    // which the failure asks for rather than performing itself.
    await waitFor(() => expect(checkboxes()[0].checked).toBe(false))
  })

  it('keeps a set exempt while its OTHER write is still going', async () => {
    // Two writes for one set overlap routinely: typing reps then tapping the
    // checkbox blurs the field first. If the checkbox write comes back `gone`
    // and releases the exemption twice — once directly, once via the catch —
    // the set stops being exempt while the reps write is still in flight, and
    // the next emission reverts what the user typed.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    backend.hold()
    const field = reps()[0]
    act(() => field.focus())
    fireEvent.change(field, {target: {value: '7'}})
    fireEvent.blur(field)                       // write A: reps — parked
    await act(async () => {})

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    fireEvent.click(checkboxes()[0])             // write B: done — answers `gone`
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    await emit()                                 // the block still says 8
    expect(reps()[0].value).toBe('7')
  })

  it('checks the set against the entry its own create just made', async () => {
    // On the first write of a blockless row the draft has no entry id yet, so
    // passing `next[exIdx].blockId` skipped the parent check on exactly the
    // path where the entry had just been materialized.
    mount(backend)
    fireEvent.click(checkboxes()[0])

    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    expect(vi.mocked(store.writeSet).mock.calls[0][4]).toBe('e:Bench press')
  })

  it('takes down "tap it again" once a retry works', async () => {
    // The message tells the user to tap again. Leaving it up after the tap
    // succeeded invites a second, reversing tap.
    vi.mocked(store.startWorkout).mockRejectedValueOnce(new Error('offline'))
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(screen.queryByText(/Could not save that/)).toBeNull())
  })

  it('keeps the failure message up while the set that failed is still failing', async () => {
    // Two writes for one set overlap routinely, so an unrelated success was
    // taking down a warning that was still true — and the field it belonged
    // to then reverted with nothing on screen to explain why.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    fireEvent.click(checkboxes()[0])                    // set 0 fails
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(checkboxes()[1])                    // a DIFFERENT set succeeds
    await waitFor(() => expect(store.writeSet).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.getByText(/Could not save that/)).toBeTruthy()

    fireEvent.click(checkboxes()[0])                    // …and now set 0 works
    await waitFor(() => expect(screen.queryByText(/Could not save that/)).toBeNull())
  })

  it('does not let an older write retire a newer one\'s failure', async () => {
    // The same field edited twice before the first settles. Keyed on the
    // change alone, both writes look identical — so the older one landing took
    // down the newer one's warning, and the value actually on screen was the
    // one that never saved.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    let settleFirst: () => void = () => {}
    vi.mocked(store.writeSet).mockImplementationOnce(
      () => new Promise(resolve => { settleFirst = () => resolve('written') }),
    )
    const field = weights()[0]
    act(() => field.focus())
    fireEvent.change(field, {target: {value: '190'}})
    fireEvent.blur(field)                            // write A — pending
    await act(async () => {})

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    act(() => field.focus())
    fireEvent.change(field, {target: {value: '195'}})
    fireEvent.blur(field)                            // write B — fails
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    await act(async () => { settleFirst() })         // …and now A succeeds
    expect(screen.getByText(/Could not save that/)).toBeTruthy()
  })

  it('keeps the warning up when a DIFFERENT write on the same set succeeds', async () => {
    // Typing reps and then ticking the box are two writes for one set. If the
    // reps write fails and the tick succeeds, the set is not "fine" — the
    // reps never landed, and the resync reverts them. Keyed on the set alone,
    // the tick took the warning down and that revert had no explanation.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    const field = reps()[0]
    act(() => field.focus())
    fireEvent.change(field, {target: {value: '7'}})
    fireEvent.blur(field)                                   // reps write fails
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(checkboxes()[0])                        // done write succeeds
    await waitFor(() => expect(store.writeSet).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(screen.getByText(/Could not save that/)).toBeTruthy()
  })

  it('still offers Discard when the workout holds only lifts the plan no longer lists', async () => {
    // Switching an `or`-group to an option with no blocks yet leaves exactly
    // this: the overlay omits the option switched away from, the new one has
    // no blocks, so no row carries an id — while a whole workout, with its
    // open todo subtree, sits there. Discard vanished with the ids, and with
    // nothing accepted Finish was disabled too, so there was no way to remove
    // it without switching the plan back.
    backend.seed('Overhead press', [{weight: 95, reps: 8}], 'def-ohp')
    mount(backend, {prescription: prescriptionOf([exercise({exercise: 'Landmine press', defId: 'def-lm'})])})
    await emit()

    expect(checkboxes().every(box => !box.checked)).toBe(true)   // nothing of B is logged
    fireEvent.click(screen.getByRole('button', {name: 'Discard'}))
    await waitFor(() => expect(store.discardWorkout).toHaveBeenCalled())
  })

  it('does not carry a discarded workout\'s failure into the next one', async () => {
    // The marker is keyed by day and session, so it outlived the workout it
    // belonged to: the next session of the same type inherited it and Finish
    // reported an unsaved change from a workout the user had thrown away.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    vi.mocked(store.writeSet).mockResolvedValueOnce('gone')
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', {name: 'Discard'}))
    await waitFor(() => expect(screen.getByText('Discarded')).toBeTruthy())
    await emit()

    // A fresh session for the same slot — and a DIFFERENT set, so its own
    // success cannot be what clears the old marker.
    fireEvent.click(checkboxes()[1])
    await waitFor(() => expect(store.startWorkout).toHaveBeenCalled())
    await emit()
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalled())
    expect(screen.queryByText(/did not save/)).toBeNull()
  })

  it('gives the workout back when a discard fails', async () => {
    // `abandon` lets go before the delete is known to have worked, and a
    // release retires on an authoritative ABSENCE — which never comes for a
    // workout that is still there. Left released, a second Discard did
    // nothing and Finish answered "session changed" until a remount.
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()

    vi.mocked(store.discardWorkout).mockRejectedValueOnce(new Error('offline'))
    fireEvent.click(screen.getByRole('button', {name: 'Discard'}))
    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())

    // The second attempt reaches the store rather than silently doing nothing.
    fireEvent.click(screen.getByRole('button', {name: 'Discard'}))
    await waitFor(() => expect(store.discardWorkout).toHaveBeenCalledTimes(2))
  })

  it('does not confirm a Finish whose set vanished under it', async () => {
    // A set this screen shows as accepted was deleted since the last emission.
    // Finishing anyway prunes whatever that leaves empty and then reports the
    // session as logged INCLUDING that set, off a draft that is now fiction.
    backend.seed('Bench press', [{weight: 205, reps: 5, done: true}, {weight: 205, reps: 5, done: true}])
    mount(backend)
    await emit()

    backend.deleteSet('e:Bench press|1')
    fireEvent.click(screen.getByRole('button', {name: /Finish/}))

    await waitFor(() => expect(screen.getByText(/Something changed while saving/)).toBeTruthy())
    expect(store.finishWorkout).not.toHaveBeenCalled()
    expect(screen.queryByText(/Logged A · upper/)).toBeNull()
  })

  it('writes every set of an exercise once when you accept them all', async () => {
    // "all ✓" hands each iteration a snapshot that predates the ids the
    // previous one created; before the coordinator, the later sets concluded
    // their exercise was missing and created a duplicate entry.
    mount(backend, {prescription: prescriptionOf([exercise({sets: 3})])})
    fireEvent.click(screen.getByRole('button', {name: 'all ✓'}))

    await waitFor(() => expect(store.writeSet).toHaveBeenCalledTimes(3))
    expect(store.startWorkout).toHaveBeenCalledTimes(1)
    expect(store.materializeExercise).not.toHaveBeenCalled()
    await emit()
    expect(checkboxes().every(box => box.checked)).toBe(true)
    expect(new Set(vi.mocked(store.writeSet).mock.calls.map(call => call[1])).size).toBe(3)
  })

  it('does not re-date a set that was already accepted', async () => {
    // "Accept the rest" is not a claim about when the ones already logged
    // happened. Writing the batch's shared `now` to every row rewrote real
    // completion times an hour after the fact.
    backend.seed('Bench press', [
      {weight: 205, reps: 5, done: true, completedAt: 111},
      {weight: 205, reps: 5},
    ])
    mount(backend)
    await emit()

    fireEvent.click(screen.getByRole('button', {name: 'all ✓'}))
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()

    expect(backend.setById('e:Bench press|0')).toMatchObject({completedAt: 111})
    expect(backend.setById('e:Bench press|1')!.completedAt).toBeGreaterThan(111)
    expect(vi.mocked(store.writeSet).mock.calls.map(call => call[1])).toEqual(['e:Bench press|1'])
  })

  it('stops an accept-all batch when the session is discarded under it', async () => {
    // Discard stays enabled through the batch, so the session can go between
    // iterations. A later one then found no workout and CREATED one — the
    // screen said "Discarded" while a fresh, fully-accepted workout survived.
    backend.seed('Bench press', [{weight: 185, reps: 8}])          // one block…
    mount(backend, {prescription: prescriptionOf([exercise({sets: 2})])})   // …two prescribed
    await emit()

    backend.hold()
    fireEvent.click(screen.getByRole('button', {name: 'all ✓'}))
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', {name: 'Discard'}))
    await act(async () => {})

    await backend.release()
    await act(async () => {})
    expect(store.startWorkout).not.toHaveBeenCalled()
  })

  it('keeps the whole batch ticked while it is being written', async () => {
    // Each write's own commit emits, and an emission mid-loop saw every set
    // the loop had not reached yet as unprotected — so it reverted their
    // freshly-ticked boxes and the bulk action visibly undid itself.
    backend.seed('Bench press', [{weight: 205, reps: 5}, {weight: 205, reps: 5}])
    mount(backend)
    await emit()

    backend.hold()
    fireEvent.click(screen.getByRole('button', {name: 'all ✓'}))
    await act(async () => {})
    // The loop is sequential, so right now only the FIRST set is inside
    // `persist`. Every set after it is ticked on screen and open on the block
    // — which is exactly what this emission carries.
    await emit()
    expect(checkboxes().map(box => box.checked)).toEqual([true, true])

    await backend.release(1)          // the first write lands, the second parks
    await emit()
    expect(checkboxes().map(box => box.checked)).toEqual([true, true])

    await backend.release()
    await emit()
    expect(checkboxes().map(box => box.checked)).toEqual([true, true])
  })

  it('gives two rows of one lift their own blocks', async () => {
    // Same lift twice in a session: only `occurrence` tells the rows apart,
    // and if they share an entry they overwrite each other set for set.
    const twice = prescriptionOf([
      exercise({exercise: 'Face pulls', defId: 'def-face', sets: 1}),
      exercise({exercise: 'Face pulls', defId: 'def-face', sets: 1}),
    ])
    mount(backend, {prescription: twice})
    fireEvent.click(checkboxes()[1])

    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()
    expect(backend.live()[0].exercises).toHaveLength(2)
    expect(checkboxes()[0].checked).toBe(false)
    expect(checkboxes()[1].checked).toBe(true)
  })

  it('finishes, and reports what it logged', async () => {
    mount(backend)
    fireEvent.click(checkboxes()[0])
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    await emit()

    fireEvent.click(screen.getByRole('button', {name: /Finish/}))
    await waitFor(() => expect(store.finishWorkout).toHaveBeenCalledWith(repo, 'w1'))
    expect(screen.getByText(/Logged A · upper/)).toBeTruthy()
  })

  it('offers Finish for a session whose only ticks came from elsewhere', async () => {
    // Done-ness is the built-in todo checkbox, so a session can be complete
    // without this view ever having been tapped.
    backend.seed('Bench press', [{weight: 185, reps: 8, done: true}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()
    expect((screen.getByRole('button', {name: /Finish/}) as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('NumberField', () => {
  let backend: Backend

  beforeEach(() => {
    vi.clearAllMocks()
    backend = createBackend()
    wire(backend)
  })

  afterEach(cleanup)

  it('keeps keystrokes to itself until blur', async () => {
    // The draft holds only settled values — that is what lets the live
    // overlay run unconditionally instead of carrying a per-set dirty flag.
    mount(backend)
    const field = reps()[0]
    fireEvent.focus(field)
    fireEvent.change(field, {target: {value: '7'}})
    await act(async () => {})
    expect(store.writeSet).not.toHaveBeenCalled()

    fireEvent.blur(field)
    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    expect(vi.mocked(store.writeSet).mock.calls[0][2]).toEqual({reps: 7})
  })

  it('commits on Enter, which is how a phone keyboard says "done"', async () => {
    // Without it the typed value lives only in the DOM until something else
    // blurs the field — lock the phone first and it is gone.
    mount(backend)
    const field = weights()[0]
    // Really focused, not just sent a focus event: Enter commits by blurring
    // the field, and `blur()` on an element that was never the active one is
    // a no-op — which is also what would happen to a user.
    act(() => field.focus())
    fireEvent.change(field, {target: {value: '190'}})
    fireEvent.keyDown(field, {key: 'Enter'})

    await waitFor(() => expect(store.writeSet).toHaveBeenCalled())
    expect(vi.mocked(store.writeSet).mock.calls[0][2]).toEqual({weight: 190})
  })

  it('does not write back a number it was merely showing', async () => {
    // Focus, don't type, blur. Comparing against the prop instead of what the
    // field read on focus wrote the on-screen number back over a newer one.
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()

    const field = weights()[0]
    fireEvent.focus(field)
    backend.setById('e:Bench press|0')!.weight = 195
    await emit()
    fireEvent.blur(field)

    await act(async () => {})
    expect(store.writeSet).not.toHaveBeenCalled()
    expect(weights()[0].value).toBe('195')
  })

  it('follows the block while the field is untouched', async () => {
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()
    expect(weights()[0].value).toBe('185')

    backend.setById('e:Bench press|0')!.weight = 205
    await emit()
    expect(weights()[0].value).toBe('205')
  })
})
