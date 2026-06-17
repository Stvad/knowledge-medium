import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createElement } from 'react'
import { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import type { RejectionToastContribution } from '@/extensions/core.js'
import { routeProcessorRejection } from './processorRejectionToast.ts'

vi.mock('@/utils/toast.js', () => ({
  // showCustom invokes its render callback with a toast id so the test
  // can assert the contribution's `render` ran with the dispatched id.
  showCustom: vi.fn((render: (id: string | number) => unknown) => render('toast-id')),
  showError: vi.fn(),
}))
const { showCustom, showError } = await import('@/utils/toast.js')

const repo = {} as Repo

describe('routeProcessorRejection', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the toast contributed for the rejection code', () => {
    const render = vi.fn(() => createElement('span'))
    const contributions = new Map<string, RejectionToastContribution>([
      ['alias.collision', {code: 'alias.collision', render}],
    ])
    const error = new ProcessorRejection('msg', 'alias.collision', {alias: 'x'})

    routeProcessorRejection(error, repo, contributions)

    expect(showCustom).toHaveBeenCalledOnce()
    expect(render).toHaveBeenCalledWith(error, repo, 'toast-id')
    expect(showError).not.toHaveBeenCalled()
  })

  it('falls back to the raw message when no contribution claims the code', () => {
    const error = new ProcessorRejection('something failed', 'unknown.code')

    routeProcessorRejection(error, repo, new Map())

    expect(showError).toHaveBeenCalledWith('something failed')
    expect(showCustom).not.toHaveBeenCalled()
  })
})
