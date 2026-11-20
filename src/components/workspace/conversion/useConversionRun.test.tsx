// @vitest-environment happy-dom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ConversionRunResult } from '@/sync/conversion/runConversion'
import { useConversionRun, type PromptChannel } from './useConversionRun'

describe('useConversionRun', () => {
  it('lets a prompt clear only itself, so a late second answer leaves the next prompt standing', async () => {
    let answerFirst!: () => void
    const run = async (channel: PromptChannel): Promise<ConversionRunResult> => {
      await channel.ask<void>(answer => {
        answerFirst = () => answer()
        return 'first'
      })
      await channel.ask<void>(() => 'second')
      return {kind: 'busy'}
    }
    const {result} = renderHook(() => useConversionRun(run))
    act(() => result.current.start())
    await waitFor(() => expect(answerFirst).toBeDefined())

    act(() => answerFirst())
    await waitFor(() => expect(result.current.state).toMatchObject({kind: 'running', prompt: expect.anything()}))
    const second = result.current.state.kind === 'running' ? result.current.state.prompt : null
    // A double click on the first prompt's async picker answers it again.
    act(() => answerFirst())

    expect(result.current.state.kind === 'running' && result.current.state.prompt).toBe(second)
  })
})
