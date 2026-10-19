/**
 * Drives one conversion run from React: the run asks through
 * {@link ConversionUi}, and each question becomes the `pending` prompt the
 * flow renders until the user answers it. Cancelling, or unmounting, aborts
 * the run and rejects whatever it was waiting on.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { SavedKeyProblem, SaveKeyPrompt } from '@/sync/conversion/conversionKey'
import type { PreflightReport } from '@/sync/conversion/preflight'
import {
  runConversion,
  type ActiveStage,
  type ConversionFlowDeps,
  type ConversionRunResult,
  type ConversionStatus,
  type ConversionUi,
} from '@/sync/conversion/runConversion'
import type { ConversionUnavailable } from './conversionFlowDeps'

export type PendingPrompt =
  | {readonly kind: 'contract'; readonly stage: ActiveStage; readonly answer: () => void}
  | {readonly kind: 'preflight'; readonly report: PreflightReport; readonly answer: () => void}
  | {readonly kind: 'save-key'; readonly prompt: SaveKeyPrompt; readonly answer: (typed: string) => void}
  | {readonly kind: 'saved-key'; readonly problem: SavedKeyProblem | null; readonly answer: (pasted: string) => void}

export type RunState =
  | {readonly kind: 'idle'}
  | {readonly kind: 'running'; readonly status: ConversionStatus | null; readonly pending: PendingPrompt | null}
  | {readonly kind: 'finished'; readonly result: ConversionRunResult}
  | {readonly kind: 'failed'; readonly error: unknown}
  | {readonly kind: 'cancelled'}
  | {readonly kind: 'unavailable'; readonly why: ConversionUnavailable}

type Running = Extract<RunState, {kind: 'running'}>

const createUi = (signal: AbortSignal, update: (change: (running: Running) => Running) => void): ConversionUi => {
  const ask = <T>(prompt: (answer: (value: T) => void) => PendingPrompt): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, {once: true})
      update(running => ({
        ...running,
        pending: prompt(value => {
          signal.removeEventListener('abort', onAbort)
          update(current => ({...current, pending: null}))
          resolve(value)
        }),
      }))
    })
  return {
    confirmContract: stage => ask<void>(answer => ({kind: 'contract', stage, answer: () => answer()})),
    confirmPreflight: report => ask<void>(answer => ({kind: 'preflight', report, answer: () => answer()})),
    saveKey: prompt => ask<string>(answer => ({kind: 'save-key', prompt, answer})),
    enterSavedKey: ({problem}) => ask<string>(answer => ({kind: 'saved-key', problem, answer})),
    status: status => update(running => ({...running, status})),
  }
}

export interface ConversionRun {
  readonly state: RunState
  readonly start: () => void
  readonly cancel: () => void
}

export const useConversionRun = (
  makeDeps: (ui: ConversionUi, signal: AbortSignal) => ConversionFlowDeps | ConversionUnavailable,
): ConversionRun => {
  const [state, setState] = useState<RunState>({kind: 'idle'})
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const start = useCallback(() => {
    if (controller.current && !controller.current.signal.aborted) return
    const run = new AbortController()
    controller.current = run
    const update = (change: (running: Running) => Running) =>
      setState(current => (current.kind === 'running' && controller.current === run ? change(current) : current))
    const deps = makeDeps(createUi(run.signal, update), run.signal)
    if (typeof deps === 'string') {
      setState({kind: 'unavailable', why: deps})
      return
    }
    setState({kind: 'running', status: null, pending: null})
    runConversion(deps).then(
      result => {
        if (controller.current === run) setState({kind: 'finished', result})
      },
      (error: unknown) => {
        if (controller.current === run) setState(run.signal.aborted ? {kind: 'cancelled'} : {kind: 'failed', error})
      },
    ).finally(() => run.abort())
  }, [makeDeps])

  const cancel = useCallback(() => {
    const run = controller.current
    if (!run || run.signal.aborted) return
    run.abort(new DOMException('The conversion run was cancelled', 'AbortError'))
  }, [])

  return {state, start, cancel}
}
