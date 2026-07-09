// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
import type { BlockRenderer } from '@/types'
import { agentStatusChipContribution } from '../AgentStatusChip.tsx'

vi.mock('@/hooks/block.js', () => ({
  useHandle: (_block: unknown, opts: {selector: (doc: {properties: Record<string, unknown>}) => unknown}) =>
    opts.selector({
      properties: {
        'agent:status': 'running',
        'agent:executor': 'codex',
        'agent:updated-at': Date.now(),
      },
    }),
}))

afterEach(() => {
  cleanup()
})

describe('AgentStatusChip', () => {
  it('overlays the status chip without shrinking the content column', () => {
    const Inner: BlockRenderer = () => <div data-testid="block-text">Block text</div>
    const decorate = agentStatusChipContribution({} as never)
    if (!decorate) throw new Error('expected agent status chip decorator')
    const Decorated = decorate(Inner)

    render(<Decorated block={{id: 'block-1'} as Block}/>)

    expect(screen.getByTestId('block-text').parentElement).toHaveClass('w-full')
    expect(screen.getByTestId('block-text').parentElement?.parentElement).toHaveClass('relative', 'w-full')
    expect(document.querySelector('[data-agent-dispatch-chip="running"]')).toHaveClass('absolute', 'right-0')
  })
})
