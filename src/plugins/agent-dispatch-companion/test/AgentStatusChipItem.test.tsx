// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockGutterItem } from '@/extensions/blockInteraction.js'

const { useHandleMock } = vi.hoisted(() => ({ useHandleMock: vi.fn() }))
vi.mock('@/hooks/block.js', () => ({ useHandle: useHandleMock }))

import { agentStatusChipContribution } from '../AgentStatusChip.tsx'
import { clearAskedAgent, isAskedAgent, markAskedAgent } from '../askedStore.ts'

const block = { id: 'block-1' } as Block

const Chip = (() => {
  const item = agentStatusChipContribution({ isTopLevel: false } as never) as BlockGutterItem
  return item.component
})()

const withProperties = (properties: Record<string, unknown> | undefined) =>
  useHandleMock.mockImplementation((_handle: unknown, options: { selector: (doc: unknown) => unknown }) =>
    options.selector(properties ? { properties } : undefined))

const chipNode = (container: HTMLElement) => container.querySelector('[data-agent-dispatch-chip]')

afterEach(() => {
  cleanup()
  clearAskedAgent(block.id)
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('AgentStatusChipItem', () => {
  it('renders nothing for a block with no agent lifecycle', () => {
    withProperties({})
    const { container } = render(<Chip block={block} />)
    expect(container.innerHTML).toBe('')
  })

  it('renders the chip for the daemon-written lifecycle', () => {
    withProperties({ 'agent:status': 'done', 'agent:executor': 'codex' })
    const { container } = render(<Chip block={block} />)
    expect(chipNode(container)?.getAttribute('data-agent-dispatch-chip')).toBe('done')
    expect(container.textContent).toContain('Codex')
  })

  it('updates the running activity age and warning on the mounted chip', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    withProperties({
      'agent:status': 'running',
      'agent:updated-at': 10_000,
      'agent:activity': 'km: comments',
      'agent:activity-at': 40_000,
    })
    const { container } = render(<Chip block={block} />)
    const chip = chipNode(container)!
    expect(chip.textContent).toContain('km: comments')
    expect(chip.textContent).toContain('60s')
    expect(chip.getAttribute('title')).not.toContain('No progress')
    expect(chip.className).toContain('w-72')

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(chip.getAttribute('title')).toContain('No progress for 61s on km: comments')
    expect(chip.getAttribute('title')).toContain('the app tab may not be answering')
    expect(chip.className).toContain('text-amber-700')
  })

  it('runs the clock only while the task is running and releases it when the task ends', () => {
    vi.useFakeTimers()
    withProperties({ 'agent:status': 'queued' })
    const view = render(<Chip block={block} />)
    expect(vi.getTimerCount()).toBe(0)
    withProperties({ 'agent:status': 'running' })
    act(() => view.rerender(<Chip block={block} />))
    expect(vi.getTimerCount()).toBe(1)
    withProperties({ 'agent:status': 'done' })
    act(() => view.rerender(<Chip block={block} />))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the existing compact pill when activity has no valid start timestamp', () => {
    withProperties({ 'agent:status': 'running', 'agent:activity': 'km: comments' })
    const { container } = render(<Chip block={block} />)
    const chip = chipNode(container)!
    expect(chip.className).toContain('w-24')
    expect(chip.className).not.toContain('w-72')
    expect(chip.textContent).not.toContain('km: comments')
  })

  it('shows the optimistic queued mark, and real lifecycle props supersede it', () => {
    markAskedAgent(block.id)
    withProperties({})
    const view = render(<Chip block={block} />)
    expect(chipNode(view.container)?.getAttribute('data-agent-dispatch-chip')).toBe('queued')

    withProperties({ 'agent:status': 'done' })
    act(() => view.rerender(<Chip block={block} />))
    expect(chipNode(view.container)?.getAttribute('data-agent-dispatch-chip')).toBe('done')
    expect(isAskedAgent(block.id)).toBe(false)
  })
})
