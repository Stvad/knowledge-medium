// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import type { Block } from '@/data/block'
import { PropertyRow } from './PropertyRow'
import type { PropertyPanelModelRow } from './model'

// PropertyRow renders `usePropertyEditingActivation`, which calls the
// standard hook chain (useUIStateBlock → useRepo, useActiveContextsDispatch).
// This test renders PropertyRow in isolation and doesn't care about that
// chain — mock the leaf hooks so the chain doesn't throw.
vi.mock('@/context/repo.tsx', () => ({
  useRepo: () => ({} as unknown),
}))
vi.mock('@/data/globalState.ts', () => ({
  useUIStateBlock: () => ({id: 'ui-state'} as unknown as Block),
}))
vi.mock('@/shortcuts/ActiveContexts.tsx', () => ({
  useActiveContextsDispatch: () => ({activate: vi.fn(), deactivate: vi.fn()}),
}))

const stringProp = defineProperty<string>('roam:email', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

describe('PropertyRow', () => {
  it('renders the raw JSON value when a known property fails to decode', () => {
    const row: PropertyPanelModelRow = {
      name: stringProp.name,
      encodedValue: ['a@example.com', 'b@example.com'],
      isSet: true,
      labelText: stringProp.name,
      shape: stringProp.codec.type,
      schema: stringProp,
      schemaUnknown: false,
      decodeFailed: true,
      value: ['a@example.com', 'b@example.com'],
      Editor: undefined,
      Glyph: undefined,
      canRename: false,
      canDelete: true,
      canChangeShape: false,
      isHidden: false,
    }

    render(
      <PropertyRow
        row={row}
        block={{id: 'block-1'} as Block}
        readOnly={false}
        canConfigure={false}
        onNavigate={vi.fn()}
        onConfigure={vi.fn()}
        onChange={vi.fn()}
        onRename={vi.fn()}
        onDelete={vi.fn()}
      />,
    )

    expect(screen.getByText('["a@example.com","b@example.com"]')).toBeTruthy()
    expect(screen.queryByText('Decode failed')).toBeNull()
  })
})
