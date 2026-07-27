/** The one data hook: assembles config, reactive history/layoffs, and
 *  tonight's prescription for a Strength Log page.
 *
 *  Config is loaded once from the plan outline (async) but seeded
 *  synchronously with the plan-faithful defaults, so the surface is usable
 *  the instant it mounts and refines when the live plan resolves. History
 *  and layoffs are reactive typed-block queries, so logging a set re-derives
 *  the prescription with no manual refresh.
 */

import {useEffect, useMemo, useRef, useState} from 'react'

import {useBlockQuery, useHandle} from '@/hooks/block.js'
import {hasBlockType} from '@/data/properties.js'
import type {Repo} from '@/data/repo.js'

import {prescribe} from '../engine/prescribe'
import {trainingDay} from '../engine/schedule'
import type {LayoffRecord, Prescription, ProgramConfig, SessionType, WorkoutRecord} from '../engine/types'
import {DEFAULT_CONFIG} from '../program/defaults'
import {loadConfig} from '../km/config'
import {getOrCreateSettingsBlock} from '../km/page'
import {writeAltChoice} from '../km/store'
import {buildHistory, buildLayoffs, buildLiveWorkouts, type LiveWorkout} from '../km/history'
import {EXERCISE_ENTRY_TYPE, LAYOFF_TYPE, SET_TYPE, WORKOUT_TYPE} from '../km/fields'

export interface ProgramState {
  config: ProgramConfig
  warnings: readonly string[]
  planRootId: string | null
  settingsBlockId: string | null
  history: readonly WorkoutRecord[]
  layoffs: readonly LayoffRecord[]
  /** In-progress (unfinished) workouts, block-backed with set ids. */
  liveWorkouts: readonly LiveWorkout[]
  /** Have the blocks behind the live workout answered at least once?
   *
   *  Until they have, an absent workout / entry / set is silence rather than
   *  news, and the logging view must not read it as a deletion. See the
   *  `useHandle` comment below: `useBlockQuery` cannot express this, because
   *  it gives `[]` for both. */
  liveLoaded: boolean
  /** Has the plan outline been read yet?
   *
   *  `config` is seeded synchronously with plan-faithful defaults so the
   *  surface is usable the instant it mounts — but those defaults carry no
   *  plan-block ids, and a logged entry's block id is DERIVED from its plan
   *  block. Writing before this is true derives name-keyed ids for records
   *  that already exist under defId-keyed ones, i.e. a whole parallel set of
   *  blocks. Read-only surfaces can ignore it; the write path must not. */
  configLoaded: boolean
  day: string
  session: SessionType
  setSession: (session: SessionType | null) => void
  prescription: Prescription
  /** Track a different option of a plan `or`-group, by its option key
   *  (`altOptionKey`). `label` is the option's name — it becomes the choice
   *  block's readable content. */
  setAltChoice: (groupKey: string, optionKey: string, label: string) => void
  reload: () => void
}

export const useProgram = (repo: Repo, workspaceId: string, pageId: string): ProgramState => {
  const [config, setConfig] = useState<ProgramConfig>(DEFAULT_CONFIG)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [planRootId, setPlanRootId] = useState<string | null>(null)
  const [settingsBlockId, setSettingsBlockId] = useState<string | null>(null)
  const [sessionOverride, setSessionOverride] = useState<SessionType | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Capture "now" once so a session that crosses midnight stays on one day.
  const [now] = useState(() => new Date())
  /** Has the plan outline ever been read successfully? Decides which of two
   *  quite different situations a failed read is. */
  const planEverRead = useRef(false)

  useEffect(() => {
    let cancelled = false
    // Lock writing for the duration of every load, not just the first. This
    // latch says "the prescription on screen is the one the plan describes",
    // and a RELOAD (switching an `or`-group bumps `reloadKey`) makes that
    // false again until it settles — tapping a set in that window
    // materialized the option the user had just switched away from, leaving
    // an extra lift in the session.
    setConfigLoaded(false)
    void (async () => {
      const settingsId = await getOrCreateSettingsBlock(repo, workspaceId, pageId).catch(() => null)
      if (cancelled) return
      setSettingsBlockId(settingsId)
      try {
        const loaded = await loadConfig(repo, workspaceId, settingsId)
        if (cancelled) return
        planEverRead.current = true
        setConfig(loaded.config)
        setWarnings(loaded.warnings)
        setPlanRootId(loaded.planRootId)
      } catch (error) {
        console.error('[strength] could not read the plan outline', error)
        // Say so on screen, not just in the console. Logging is deliberately
        // unlocked below even on failure — blocking it on an unreadable plan
        // is worse — but that means the user has to be told what their session
        // is being recorded against. Progression is derived from what gets
        // logged, so "which plan was this" is not a detail.
        //
        // And WHICH message depends on whether a plan was ever read. A failed
        // RELOAD leaves the last good plan in `config`, so saying "showing the
        // built-in defaults" would be false. The config is deliberately not
        // reset to the defaults either: that would throw away real plan blocks
        // over what is usually a transient read, and logging without them
        // derives name-keyed ids for entries that already exist under
        // plan-keyed ones — the parallel-tree failure this extension has spent
        // its whole history avoiding. Keep the good data, say what it is.
        if (!cancelled) {
          setWarnings([
            planEverRead.current
              ? 'Could not re-read your plan outline — still using the copy read earlier. '
                + 'A change you just made to the plan may not be reflected here yet.'
              : 'Could not read your plan outline — showing the built-in defaults. '
                + 'Anything you log now is recorded against those, not your plan.',
          ])
        }
      } finally {
        // Settled either way — including when the read FAILED and we kept the
        // defaults. This gates writing, and blocking logging forever on an
        // unreadable plan is worse than logging against the default names.
        if (!cancelled) setConfigLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [repo, workspaceId, pageId, reloadKey])

  // ONE query for the whole workout tree, not one per type.
  //
  // `types` is any-of, so this is a single consistent snapshot of workouts,
  // entries and sets. Three separate queries were three separate loads that
  // reload INDEPENDENTLY, and the overlay reads a workout with no entries as
  // an authoritative deletion — so in the window where the workout query had
  // published a new (or replacement) workout and the entry query had not yet
  // published its children, tonight's logged values were replaced on screen
  // by the prescription's defaults, and a tap could land in that window.
  // There is no such window to reason about when there is one answer.
  //
  // `useHandle` rather than `useBlockQuery`, for the one thing the latter
  // throws away: it collapses an UNRESOLVED query to `[]`, which is the same
  // value a resolved-and-empty one gives. Those mean opposite things to a
  // logging surface — "the blocks haven't arrived" versus "that lift has no
  // sets any more" — and every attempt to guess between them from the data
  // alone contradicted itself, because there is nothing in `[]` to tell them
  // apart. `undefined` says it outright.
  const treeRows = useHandle(repo.query.typedBlocks({
    workspaceId,
    types: [WORKOUT_TYPE, EXERCISE_ENTRY_TYPE, SET_TYPE],
  }))
  const layoffRows = useBlockQuery({workspaceId, types: [LAYOFF_TYPE]})

  /** The blocks behind the live workout have answered. Until they have, an
   *  absence is silence, not news. */
  const liveLoaded = treeRows !== undefined

  // Split by the same predicate the query selected on. Tested where it can be
  // seen: a set block is deliberately a `todo` as well, so "carries this type"
  // is the question, never "is only this type".
  type TreeRow = NonNullable<typeof treeRows>[number]
  const tree = useMemo(() => {
    const workouts: TreeRow[] = []
    const exercises: TreeRow[] = []
    const sets: TreeRow[] = []
    for (const row of treeRows ?? []) {
      if (hasBlockType(row, WORKOUT_TYPE)) workouts.push(row)
      if (hasBlockType(row, EXERCISE_ENTRY_TYPE)) exercises.push(row)
      if (hasBlockType(row, SET_TYPE)) sets.push(row)
    }
    return {workouts, exercises, sets}
  }, [treeRows])

  const history = useMemo(
    () => buildHistory(tree.workouts, tree.exercises, tree.sets),
    [tree],
  )
  const liveWorkouts = useMemo(
    () => buildLiveWorkouts(tree.workouts, tree.exercises, tree.sets),
    [tree],
  )
  const layoffs = useMemo(() => buildLayoffs(layoffRows), [layoffRows])

  const day = useMemo(() => trainingDay(now, config.dayRolloverHour), [now, config.dayRolloverHour])

  const prescription = useMemo(
    () => prescribe({history, layoffs, config, now, session: sessionOverride ?? undefined}),
    [history, layoffs, config, now, sessionOverride],
  )

  return {
    config,
    warnings,
    planRootId,
    settingsBlockId,
    history,
    layoffs,
    liveWorkouts,
    liveLoaded,
    configLoaded,
    day,
    session: prescription.session,
    setSession: setSessionOverride,
    prescription,
    setAltChoice: (groupKey, optionKey, label) => {
      if (!settingsBlockId) return
      // Lock writing NOW, not when the reload eventually starts. The
      // preference write has to land before `reloadKey` moves, and in that gap
      // the old card is still on screen and still writable — a quick tap
      // materialized the option the user had just switched away from and left
      // an extra lift in the session.
      setConfigLoaded(false)
      void writeAltChoice(repo, settingsBlockId, groupKey, optionKey, label)
        .then(() => setReloadKey(k => k + 1))
        // The switch never happened, so the prescription on screen is still
        // the right one to log against. Unlock rather than stranding it.
        .catch(error => {
          console.error('[strength] could not record the variant choice', error)
          setConfigLoaded(true)
        })
    },
    reload: () => setReloadKey(k => k + 1),
  }
}
