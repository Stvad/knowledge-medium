// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockGutterItem } from '@/extensions/blockInteraction.js'

const { useHandleMock, retryAgentMock } = vi.hoisted(() => ({
  useHandleMock: vi.fn(),
  retryAgentMock: vi.fn(async () => {}),
}))
vi.mock('@/hooks/block.js', () => ({ useHandle: useHandleMock }))
vi.mock('../retryAgent.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../retryAgent.ts')>(),
  retryAgent: retryAgentMock,
}))

import { agentStatusChipContribution } from '../AgentStatusChip.tsx'
import { clearAskedAgent, isAskedAgent, markAskedAgent } from '../askedStore.ts'

const block = {
  id: 'block-1',
  repo: {isReadOnly: false, onReadOnlyChange: () => () => {}},
} as unknown as Block

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

  it('offers Retry on a failed chip even when there is no session to resume', () => {
    withProperties({
      'agent:status': 'error',
      'agent:watcher': 'review',
      'agent:error': 'Authentication expired',
    })
    render(<Chip block={block} />)

    const trigger = screen.getByRole('button', {name: /Authentication expired/})
    fireEvent.pointerDown(trigger, {button: 0, ctrlKey: false, pointerType: 'mouse'})
    fireEvent.click(screen.getByRole('menuitem', {name: 'Retry'}))

    expect(retryAgentMock).toHaveBeenCalledExactlyOnceWith(block)
  })

  it('keeps the failure visible until the watcher accepts the retry', () => {
    withProperties({
      'agent:status': 'error',
      'agent:watcher': 'review',
      'agent:error': 'Authentication expired',
      'agent:retry-at': 500,
    })
    const {container} = render(<Chip block={block} />)

    expect(chipNode(container)?.getAttribute('data-agent-dispatch-chip')).toBe('error')
    expect(chipNode(container)?.getAttribute('title')).toContain('Authentication expired · Retry requested')
    expect(screen.getByText('Retry pending')).toBeVisible()
    expect(screen.queryByRole('button')).toBeNull()
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
    expect(chip.getAttribute('aria-label')).toContain('task actions')

    act(() => { vi.advanceTimersByTime(1_000) })
    expect(chip.getAttribute('title')).toContain('No progress for 21s')
    expect(chip.textContent).toContain('⚠')
    expect(chip.getAttribute('aria-label')).toContain('No progress for 21s')
  })

  it('shows compact activity and step age while details keep exact activity and total runtime', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    withProperties({
      'agent:status': 'running',
      'agent:updated-at': 88_000,
      'agent:activity': 'km: get_block',
      'agent:activity-at': 97_000,
    })
    const view = render(<Chip block={block} />)
    const chip = chipNode(view.container)!
    expect(chip.textContent).toContain('Reading')
    expect(chip.textContent).toContain('3s')
    expect(chip.textContent).not.toContain('km: get_block')
    expect(chip.getAttribute('title')).toContain('km: get_block')
    expect(chip.getAttribute('title')).toContain('3s on this step')
    expect(chip.getAttribute('title')).toContain('12s total')
    expect(chip.getAttribute('aria-label')).toContain('Reading: km: get_block · 3s on this step')

    fireEvent.pointerDown(chip, {button: 0, ctrlKey: false, pointerType: 'mouse'})
    expect(document.body.textContent).toContain('km: get_block · 3s on this step · 12s total')

    act(() => { vi.advanceTimersByTime(3_000) })
    withProperties({
      'agent:status': 'running',
      'agent:updated-at': 88_000,
      'agent:activity': 'Thinking',
      'agent:activity-at': 102_000,
    })
    act(() => view.rerender(<Chip block={block} />))
    const updatedChip = chipNode(view.container)!
    expect(updatedChip.textContent).toContain('Thinking')
    expect(updatedChip.textContent).toContain('1s')
    expect(updatedChip.getAttribute('title')).toContain('1s on this step')
    expect(updatedChip.getAttribute('title')).toContain('15s total')
  })

  it('uses Working for unknown activity and omits step age when its timestamp is missing', () => {
    vi.useFakeTimers()
    vi.setSystemTime(100_000)
    withProperties({
      'agent:status': 'running',
      'agent:updated-at': 90_000,
      'agent:activity': 'km: future_tool',
      'agent:activity-at': 98_000,
    })
    const { container, rerender } = render(<Chip block={block} />)
    expect(chipNode(container)?.textContent).toContain('Working')
    expect(chipNode(container)?.textContent).toContain('2s')

    withProperties({
      'agent:status': 'running',
      'agent:updated-at': 90_000,
      'agent:activity': 'km: future_tool',
    })
    act(() => rerender(<Chip block={block} />))
    const chip = chipNode(container)!
    expect(chip.textContent).toContain('Working')
    expect(chip.textContent).not.toMatch(/\b\d+s\b/)
    expect(chip.getAttribute('title')).toContain('km: future_tool')
    expect(chip.getAttribute('title')).not.toContain('on this step')
    expect(chip.getAttribute('title')).toContain('10s total')
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
