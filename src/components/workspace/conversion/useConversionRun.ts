/**
 * Drives one conversion run from React. The run asks through a
 * {@link PromptChannel}: each question renders as the current prompt until the
 * user answers it. Cancelling, or unmounting, aborts the run and rejects
 * whatever it was waiting on.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ConversionRunResult, ConversionStatus } from '@/sync/conversion/runConversion'

export interface PromptChannel {
  /** Show `render`'s prompt until it calls `answer`; rejects when the run is cancelled. */
  ask<T>(render: (answer: (value: T) => void, cancel: () => void) => ReactNode): Promise<T>
  status(status: ConversionStatus): void
}

export type RunState =
  | {readonly kind: 'idle'}
  | {readonly kind: 'running'; readonly status: ConversionStatus | null; readonly prompt: ReactNode | null}
  | {readonly kind: 'finished'; readonly result: ConversionRunResult}
  | {readonly kind: 'failed'; readonly error: unknown}
  | {readonly kind: 'cancelled'}

type Running = Extract<RunState, {kind: 'running'}>

/** The cancellation itself, or a request it aborted: PostgREST reports an
 *  aborted fetch as an error whose message names the AbortError. */
const isCancellation = (error: unknown, signal: AbortSignal): boolean => {
  if (!signal.aborted) return false
  let current = error
  for (let depth = 0; current && depth < 4; depth++) {
    if (current === signal.reason || (current as {name?: unknown}).name === 'AbortError') return true
    const message = (current as {message?: unknown}).message
    if (typeof message === 'string' && message.includes('AbortError')) return true
    current = (current as {cause?: unknown}).cause
  }
  return false
}

const createChannel = (
  signal: AbortSignal,
  cancel: () => void,
  update: (change: (running: Running) => Running) => void,
): PromptChannel => ({
  ask: <T>(render: (answer: (value: T) => void, cancel: () => void) => ReactNode) =>
    new Promise<T>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason)
      const onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, {once: true})
      const answer = (value: T) => {
        signal.removeEventListener('abort', onAbort)
        update(current => ({...current, prompt: null}))
        resolve(value)
      }
      update(running => ({...running, prompt: render(answer, cancel)}))
    }),
  status: status => update(running => ({...running, status})),
})

export interface ConversionRun {
  readonly state: RunState
  readonly start: () => void
  readonly cancel: () => void
}

export const useConversionRun = (
  runWith: (channel: PromptChannel, signal: AbortSignal) => Promise<ConversionRunResult>,
): ConversionRun => {
  const [state, setState] = useState<RunState>({kind: 'idle'})
  const controller = useRef<AbortController | null>(null)

  useEffect(() => () => controller.current?.abort(), [])

  const cancel = useCallback(() => {
    const run = controller.current
    if (!run || run.signal.aborted) return
    run.abort(new DOMException('The conversion run was cancelled', 'AbortError'))
  }, [])

  const start = useCallback(() => {
    if (controller.current && !controller.current.signal.aborted) return
    const run = new AbortController()
    controller.current = run
    const update = (change: (running: Running) => Running) =>
      setState(current => (current.kind === 'running' && controller.current === run ? change(current) : current))
    setState({kind: 'running', status: null, prompt: null})
    runWith(createChannel(run.signal, cancel, update), run.signal).then(
      result => {
        if (controller.current === run) setState({kind: 'finished', result})
      },
      (error: unknown) => {
        if (controller.current !== run) return
        // An error that merely followed the cancellation is still reported.
        setState(isCancellation(error, run.signal) ? {kind: 'cancelled'} : {kind: 'failed', error})
      },
    ).finally(() => run.abort())
  }, [runWith, cancel])

  return {state, start, cancel}
}
