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
import type {Prescription, PrescribedExercise, SessionType} from '../src/engine/types'
import {DEFAULT_CONFIG} from '../src/program/defaults'
import {TonightView} from '../src/ui/TonightView'
import type {ProgramState} from '../src/ui/useProgram'

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

const liftKey = (definitionId: string | undefined, exercise: string, occurrence: number): string =>
  `${definitionId ?? exercise}|${occurrence}`

const createBackend = () => {
  /** Entries by derived key, in creation order — the shape a workout's
   *  children actually have. */
  const entries = new Map<string, LiveExercise>()
  let started = false
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

  const upsertEntry = (ex: ExerciseDraft): ExerciseEntryIds => {
    const key = liftKey(ex.definitionId, ex.exercise, ex.occurrence)
    const existing = entries.get(key)
    const id = existing?.id ?? `e:${key}`
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
    entries.set(key, {
      id,
      exercise: ex.exercise,
      definitionId: ex.definitionId,
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
    /** What the live query would answer right now. */
    live: (): LiveWorkout[] =>
      started ? [{id: 'w1', day: DAY, session: 'A', exercises: [...entries.values()]}] : [],

    /** Seed a session that is already in progress — a reload, or another
     *  device. Values here are deliberately NOT the prescription's. */
    seed: (exercise: string, sets: readonly Partial<LiveSet>[], definitionId?: string) => {
      started = true
      const id = `e:${liftKey(definitionId, exercise, 0)}`
      entries.set(liftKey(definitionId, exercise, 0), {
        id,
        exercise,
        definitionId,
        unit: 'lb',
        sets: sets.map((s, i) => ({id: `${id}|${i}`, weight: 0, reps: 0, done: false, ...s})),
      })
    },

    setById: findSet,

    /** Park every write until `release()`. */
    hold: () => {
      held = []
    },
    release: async () => {
      const parked = held ?? []
      held = null
      await act(async () => {
        for (const resolve of parked) resolve()
      })
    },

    startWorkout: (draft: {exercises: readonly ExerciseDraft[]}): Promise<MaterializedWorkout> =>
      settle(() => {
        started = true
        return {workoutId: 'w1', exercises: draft.exercises.map(upsertEntry)}
      }),

    materializeExercise: (_workoutId: string, ex: ExerciseDraft): Promise<ExerciseEntryIds> =>
      settle(() => upsertEntry(ex)),

    writeSet: (setId: string, patch: Partial<SetDraft>): Promise<void> =>
      settle(() => {
        const set = findSet(setId)
        if (!set) return
        if (patch.weight !== undefined) set.weight = patch.weight
        if (patch.reps !== undefined) set.reps = patch.reps
        if (patch.done !== undefined) set.done = patch.done
        if ('completedAt' in patch) {
          if (patch.completedAt === undefined) delete set.completedAt
          else set.completedAt = patch.completedAt
        }
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

const prescriptionOf = (exercises: PrescribedExercise[] = [exercise()]): Prescription => ({
  day: DAY,
  session: 'A' as SessionType,
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
  prescription,
  configLoaded,
}: {
  backend: Backend
  prescription: Prescription
  configLoaded: boolean
}) {
  const [liveWorkouts, setLiveWorkouts] = useState<readonly LiveWorkout[]>([])
  publish = () => setLiveWorkouts(backend.live())

  const program: ProgramState = {
    config: DEFAULT_CONFIG,
    warnings: [],
    planRootId: 'plan',
    settingsBlockId: 'settings',
    history: [],
    layoffs: [],
    liveWorkouts,
    configLoaded,
    day: DAY,
    session: 'A',
    setSession: () => {},
    prescription,
    setAltChoice: () => {},
    reload: () => {},
  }
  return <TonightView repo={repo} workspaceId="ws" pageId="page" program={program} />
}

const mount = (backend: Backend, options: {prescription?: Prescription; configLoaded?: boolean} = {}) =>
  render(
    <Harness
      backend={backend}
      prescription={options.prescription ?? prescriptionOf()}
      configLoaded={options.configLoaded ?? true}
    />,
  )

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
    vi.mocked(store.startWorkout).mockImplementation((_repo, _ws, _page, draft) =>
      backend.startWorkout(draft))
    vi.mocked(store.materializeExercise).mockImplementation((_repo, workoutId, ex) =>
      backend.materializeExercise(workoutId, ex))
    vi.mocked(store.writeSet).mockImplementation((_repo, setId, patch) => backend.writeSet(setId, patch))
    vi.mocked(store.finishWorkout).mockResolvedValue(undefined)
    vi.mocked(store.discardWorkout).mockResolvedValue(undefined)
  })

  afterEach(cleanup)

  it('materializes the session on the first tap and keeps the tick', async () => {
    mount(backend)
    fireEvent.click(checkboxes()[0])

    await waitFor(() => expect(store.startWorkout).toHaveBeenCalledTimes(1))
    await emit()
    expect(checkboxes()[0].checked).toBe(true)
    expect(backend.live()[0].exercises[0].sets[0].done).toBe(true)
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
    backend.setById('e:Bench press|0|0')!.done = false
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
    expect(backend.setById('e:Bench press|0|0')).toMatchObject({weight: 205, reps: 5, done: true})
    expect(weights()[0].value).toBe('205')
  })

  it('shows a tick made somewhere else — the outline, another device', async () => {
    backend.seed('Bench press', [{weight: 185, reps: 8}, {weight: 185, reps: 8}])
    mount(backend)
    await emit()
    expect(checkboxes()[0].checked).toBe(false)

    backend.setById('e:Bench press|0|0')!.done = true
    await emit()
    expect(checkboxes()[0].checked).toBe(true)
  })

  it('refuses to log until the plan has been read, and says so', async () => {
    // Writing before the outline resolves derives entry ids from exercise
    // NAMES while the records that exist are keyed on their plan block — a
    // whole parallel tree of blocks for a session already in progress.
    mount(backend, {configLoaded: false})
    expect(screen.getByText('Reading your plan…')).toBeTruthy()
    expect(checkboxes()[0].disabled).toBe(true)

    fireEvent.click(checkboxes()[0])
    await act(async () => {})
    expect(store.startWorkout).not.toHaveBeenCalled()
  })

  it('reverts a tick whose write failed, and says why', async () => {
    vi.mocked(store.startWorkout).mockRejectedValue(new Error('offline'))
    mount(backend)
    fireEvent.click(checkboxes()[0])

    await waitFor(() => expect(screen.getByText(/Could not save that/)).toBeTruthy())
    expect(checkboxes()[0].checked).toBe(false)
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
    vi.mocked(store.startWorkout).mockImplementation((_repo, _ws, _page, draft) =>
      backend.startWorkout(draft))
    vi.mocked(store.materializeExercise).mockImplementation((_repo, workoutId, ex) =>
      backend.materializeExercise(workoutId, ex))
    vi.mocked(store.writeSet).mockImplementation((_repo, setId, patch) => backend.writeSet(setId, patch))
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
    backend.setById('e:Bench press|0|0')!.weight = 195
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

    backend.setById('e:Bench press|0|0')!.weight = 205
    await emit()
    expect(weights()[0].value).toBe('205')
  })
})
