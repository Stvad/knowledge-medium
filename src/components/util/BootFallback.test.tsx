// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { discardDbOpenTimeline, recordStartupDbFiles, resetStartupTimeline } from '@/utils/startupTimeline.js'
import { BootFallback } from './BootFallback.tsx'

const GB = 1024 ** 3

afterEach(() => {
  cleanup()
  resetStartupTimeline()
})

describe('BootFallback', () => {
  it('says the open is applying changes once boot finds a large log, even after it first rendered', () => {
    render(<BootFallback/>)
    expect(screen.getByText('Loading...')).toBeTruthy()

    act(() => { recordStartupDbFiles({main: 3 * GB, '-wa0': 0, '-wa1': 1.8 * GB}) })

    expect(screen.getByText(/applying 1\.80 GB of pending database changes/i)).toBeTruthy()
  })

  it('stays plain for a log the open reads in no noticeable time', () => {
    recordStartupDbFiles({main: 3 * GB, '-wa0': 12_448, '-wa1': 5_226_368})

    render(<BootFallback/>)

    expect(screen.getByText('Loading...')).toBeTruthy()
  })

  it('drops the hint when that open fails, since the next attempt has not looked yet', () => {
    recordStartupDbFiles({main: 3 * GB, '-wa0': 0, '-wa1': 1.8 * GB})
    render(<BootFallback/>)

    act(() => { discardDbOpenTimeline() })

    expect(screen.getByText('Loading...')).toBeTruthy()
  })
})
