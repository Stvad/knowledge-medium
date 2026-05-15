// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BacklinkFilters } from '../BacklinkFilters.tsx'

vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => ({
    block: (id: string) => ({id}),
  }),
}))

vi.mock('@/hooks/block.ts', () => ({
  useHandle: (
    block: {id: string},
    opts: {selector: (value: {content: string; properties: Record<string, unknown>} | undefined) => string},
  ) => opts.selector({content: block.id, properties: {}}),
}))

vi.mock('@/hooks/propertySchemas.ts', () => ({
  usePropertySchemas: () => new Map(),
}))

describe('BacklinkFilters', () => {
  it('shows a config action for displayed default filters', () => {
    const openConfig = vi.fn()

    render(
      <BacklinkFilters
        workspaceId="ws-1"
        filter={{}}
        baseFilter={{exclude: [{scope: 'ancestor', referencedBy: {id: 'done'}}]}}
        baseLabel="Daily note defaults"
        baseConfigLabel="Open daily note defaults"
        onBaseConfigClick={openConfig}
        onChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', {name: 'Open daily note defaults'}))

    expect(openConfig).toHaveBeenCalledOnce()
  })
})
