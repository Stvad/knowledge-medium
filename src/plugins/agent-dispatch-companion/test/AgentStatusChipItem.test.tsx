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
