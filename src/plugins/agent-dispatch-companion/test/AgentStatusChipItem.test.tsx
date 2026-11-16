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
      'agent:activity-at': 80_000,
    })
    const { container } = render(<Chip block={block} />)
    const chip = chipNode(container)!
    expect(chip.textContent).not.toContain('km: comments')
    expect(chip.textContent).toContain('20s')
    expect(chip.getAttribute('title')).not.toContain('No progress')
    expect(chip.getAttribute('title')?.match(/km: comments/g)).toHaveLength(1)
    expect(chip.getAttribute('aria-label')).toContain('Claude task actions')

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(chip.getAttribute('title')).toContain('No progress for 21s')
    expect(chip.textContent).toContain('⚠')
    expect(chip.getAttribute('aria-label')).toContain('warning: no progress for 21s')
  })

  it('starts the clock with current time, and stops ticking when cancelling or ended', () => {
    vi.useFakeTimers()
    vi.setSystemTime(50_000)
    withProperties({ 'agent:status': 'queued' })
    const view = render(<Chip block={block} />)
    expect(vi.getTimerCount()).toBe(0)

    vi.setSystemTime(100_000)
    withProperties({
      'agent:status': 'running',
      'agent:activity': 'km: comments',
      'agent:activity-at': 40_000,
    })
    act(() => view.rerender(<Chip block={block} />))
    expect(vi.getTimerCount()).toBe(1)
    expect(chipNode(view.container)?.textContent).toContain('60s')

    withProperties({ 'agent:status': 'running', 'agent:cancel': true })
    act(() => view.rerender(<Chip block={block} />))
    expect(vi.getTimerCount()).toBe(0)
    expect(chipNode(view.container)?.textContent).toContain('cancelling…')

    withProperties({ 'agent:status': 'done' })
    act(() => view.rerender(<Chip block={block} />))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the existing compact pill when activity has no valid start timestamp', () => {
    withProperties({ 'agent:status': 'running', 'agent:activity': 'km: comments' })
    const { container } = render(<Chip block={block} />)
    const chip = chipNode(container)!
    expect(chip.textContent).not.toContain('km: comments')
    expect(chip.getAttribute('title')).toContain('km: comments')
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
