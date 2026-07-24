/** The one data hook: assembles config, reactive history/layoffs, and
 *  tonight's prescription for a Strength Log page.
 *
 *  Config is loaded once from the plan outline (async) but seeded
 *  synchronously with the plan-faithful defaults, so the surface is usable
 *  the instant it mounts and refines when the live plan resolves. History
 *  and layoffs are reactive typed-block queries, so logging a set re-derives
 *  the prescription with no manual refresh.
 */

import {useEffect, useMemo, useState} from 'react'

import {useBlockQuery} from '@/hooks/block.js'
import type {Repo} from '@/data/repo.js'

import {prescribe} from '../engine/prescribe'
import {trainingDay} from '../engine/schedule'
import type {LayoffRecord, Prescription, ProgramConfig, SessionType, WorkoutRecord} from '../engine/types'
import {DEFAULT_CONFIG} from '../program/defaults'
import {loadConfig} from '../km/config'
import {getOrCreateSettingsBlock} from '../km/page'
import {buildHistory, buildLayoffs} from '../km/history'
import {EXERCISE_ENTRY_TYPE, LAYOFF_TYPE, WORKOUT_TYPE} from '../km/fields'

export interface ProgramState {
  config: ProgramConfig
  warnings: readonly string[]
  planRootId: string | null
  settingsBlockId: string | null
  history: readonly WorkoutRecord[]
  layoffs: readonly LayoffRecord[]
  day: string
  session: SessionType
  setSession: (session: SessionType | null) => void
  prescription: Prescription
  reload: () => void
}

export const useProgram = (repo: Repo, workspaceId: string, pageId: string): ProgramState => {
  const [config, setConfig] = useState<ProgramConfig>(DEFAULT_CONFIG)
  const [warnings, setWarnings] = useState<readonly string[]>([])
  const [planRootId, setPlanRootId] = useState<string | null>(null)
  const [settingsBlockId, setSettingsBlockId] = useState<string | null>(null)
  const [sessionOverride, setSessionOverride] = useState<SessionType | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  // Capture "now" once so a session that crosses midnight stays on one day.
  const [now] = useState(() => new Date())

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const settingsId = await getOrCreateSettingsBlock(repo, workspaceId, pageId).catch(() => null)
      if (cancelled) return
      setSettingsBlockId(settingsId)
      const loaded = await loadConfig(repo, workspaceId, settingsId)
      if (cancelled) return
      setConfig(loaded.config)
      setWarnings(loaded.warnings)
      setPlanRootId(loaded.planRootId)
    })()
    return () => {
      cancelled = true
    }
  }, [repo, workspaceId, pageId, reloadKey])

  const workoutRows = useBlockQuery({workspaceId, types: [WORKOUT_TYPE]})
  const exerciseRows = useBlockQuery({workspaceId, types: [EXERCISE_ENTRY_TYPE]})
  const layoffRows = useBlockQuery({workspaceId, types: [LAYOFF_TYPE]})

  const history = useMemo(() => buildHistory(workoutRows, exerciseRows), [workoutRows, exerciseRows])
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
    day,
    session: prescription.session,
    setSession: setSessionOverride,
    prescription,
    reload: () => setReloadKey(k => k + 1),
  }
}
