// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Block } from '@/data/block'
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
  it('renders as a compact line-end accessory', () => {
    const accessory = agentStatusChipContribution({} as never)
    if (!accessory || Array.isArray(accessory)) throw new Error('expected agent status accessory')
    const Accessory = (accessory as Exclude<typeof accessory, readonly unknown[]>).render

    render(<Accessory block={{id: 'block-1'} as Block}/>)

    expect(screen.getByTitle(/Codex is working/)).toHaveClass('block-line-end-accessory')
    expect(document.querySelector('[data-agent-dispatch-chip="running"]')).not.toHaveClass('absolute', 'right-0')
  })
})
