// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import type { Block } from '@/data/block'
import { PropertyRow } from './PropertyRow'
import type { PropertyPanelModelRow } from './model'

// PropertyRow calls `usePropertyEditingActivation` unconditionally; this
// test doesn't exercise the activation path (read-only decode-failed row),
// so stub the hook to a no-op rather than mocking the deep useRepo /
// useUIStateBlock / useActiveContextsDispatch chain underneath.
vi.mock('./usePropertyEditingActivation', () => ({
  usePropertyEditingActivation: () => ({onFocus: vi.fn(), onBlur: vi.fn()}),
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
      readOnly: false,
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

  it('renders the raw value as text when no editor is registered (e.g. an object blob)', () => {
    const objectProp = defineProperty<{tti: number} | undefined>('startupRecord', {
      codec: codecs.optionalIdentity<{tti: number}>('object'),
      defaultValue: undefined,
      changeScope: ChangeScope.UiState,
    })
    const row: PropertyPanelModelRow = {
      name: objectProp.name,
      encodedValue: {tti: 42},
      isSet: true,
      labelText: objectProp.name,
      shape: objectProp.codec.type,
      schema: objectProp,
      schemaUnknown: false,
      decodeFailed: false,
      value: {tti: 42},
      Editor: undefined, // no preset/override for codec type 'object'
      Glyph: undefined,
      canRename: false,
      canDelete: true,
      canChangeShape: false,
      isHidden: false,
      readOnly: false,
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

    expect(screen.getByText('{"tti":42}')).toBeTruthy()
    expect(screen.queryByText('No editor registered')).toBeNull() // shows the value, not a placeholder
  })

  it('renders declaration-only values with attribution and no editing affordances', () => {
    const encodedValue = {queue: ['block-1'], threshold: 2}
    const UnexpectedEditor = () => <div data-testid="unexpected-editor">Editor</div>
    const row: PropertyPanelModelRow = {
      name: 'srs:config',
      encodedValue,
      isSet: true,
      labelText: 'srs:config',
      shape: 'object',
      schema: defineProperty('srs:config', {
        codec: codecs.optionalIdentity<Record<string, unknown>>('object'),
        defaultValue: undefined,
        changeScope: ChangeScope.BlockDefault,
      }),
      schemaUnknown: false,
      decodeFailed: false,
      value: encodedValue,
      Editor: UnexpectedEditor,
      Glyph: undefined,
      // Row-level read-only is the defensive boundary. Keep capability flags
      // true here so the component test proves it suppresses every affordance
      // independently of the model's declaration-only capability policy.
      canRename: true,
      canDelete: true,
      canChangeShape: true,
      isHidden: false,
      readOnly: true,
      statusText: 'Provided by srs-rescheduling — not installed/disabled',
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

    expect(screen.getByText('{"queue":["block-1"],"threshold":2}')).toBeTruthy()
    expect(screen.getByText('Provided by srs-rescheduling — not installed/disabled')).toBeTruthy()
    expect(screen.queryByTestId('unexpected-editor')).toBeNull()
    expect(screen.queryByLabelText('Field srs:config')).toBeNull()
    expect(screen.queryByTitle('Delete srs:config')).toBeNull()
  })
})
