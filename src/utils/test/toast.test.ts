// @vitest-environment jsdom
import { createElement } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sonner = vi.hoisted(() => ({
  base: vi.fn(),
  custom: vi.fn(() => 'toast-id'),
  dismiss: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  success: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(sonner.base, {
    custom: sonner.custom,
    dismiss: sonner.dismiss,
    error: sonner.error,
    info: sonner.info,
    loading: sonner.loading,
    success: sonner.success,
  }),
}))

import { showCustom } from '../toast.ts'

describe('toast facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not pass an undefined id to custom toasts', () => {
    const render = () => createElement('div')

    showCustom(render, {duration: 1234})

    expect(sonner.custom).toHaveBeenCalledWith(render, {duration: 1234})
    const [, options] = sonner.custom.mock.calls[0] as unknown as [
      unknown,
      Record<string, unknown>,
    ]
    expect('id' in options).toBe(false)
  })

  it('passes explicit custom toast ids through', () => {
    const render = () => createElement('div')

    showCustom(render, {duration: 1234, id: 'stable-id'})

    expect(sonner.custom).toHaveBeenCalledWith(render, {
      duration: 1234,
      id: 'stable-id',
    })
  })
})
