import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import {
  routeProcessorRejection,
  type RejectionToastContribution,
} from './processorRejectionToast.ts'

vi.mock('@/utils/toast.js', () => ({
  showError: vi.fn(),
}))
const { showError } = await import('@/utils/toast.js')

const repo = {} as Repo

describe('routeProcessorRejection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('dispatches to the handler contributed for the rejection code', () => {
    const handle = vi.fn()
    const contributions = new Map<string, RejectionToastContribution>([
      ['alias.collision', {code: 'alias.collision', handle}],
    ])
    const error = new ProcessorRejection('msg', 'alias.collision', {alias: 'x'})

    routeProcessorRejection(error, repo, contributions)

    expect(handle).toHaveBeenCalledWith(error, repo)
    expect(showError).not.toHaveBeenCalled()
  })

  it('falls back to the raw message when no handler is registered for the code', () => {
    const error = new ProcessorRejection('something failed', 'unknown.code')

    routeProcessorRejection(error, repo, new Map())

    expect(showError).toHaveBeenCalledWith('something failed')
  })
})
