// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty } from '@/data/api'
import type { Block } from '@/data/block'
import { PropertyRow } from './PropertyRow'
import type { PropertyPanelModelRow } from './model'

// PropertyRow calls `usePropertyEditingActivation` for the rename input and
// the value cell; stub it rather than mocking the deep useRepo /
// useUIStateBlock / useActiveContextsDispatch chain underneath. Stable spies
// (not fresh ones per call) so the value-cell wiring can be asserted.
const activation = {onFocus: vi.fn(), onBlur: vi.fn()}
vi.mock('./usePropertyEditingActivation', () => ({
  usePropertyEditingActivation: () => activation,
}))

const stringProp = defineProperty<string>('roam:email', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

// A cell key whose stored name carries padding — an import, or a definition
// synthesized for an orphaned key, which mints it verbatim.
const paddedProp = defineProperty<string>(' padded ', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

// A stored key carrying a line break: a text input cannot hold one, so its DOM
// value is already a different string before the user touches anything.
const newlineRow = (): PropertyPanelModelRow => ({
  name: ' pad\nded ',
  encodedValue: 'v',
  isSet: true,
  labelText: ' pad\nded ',
  shape: paddedProp.codec.type,
  schema: paddedProp,
  schemaUnknown: true,
  decodeFailed: false,
  value: 'v',
  Editor: undefined,
  Glyph: undefined,
  canRename: true,
  canDelete: true,
  canChangeShape: false,
  isHidden: false,
  readOnly: false,
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

  it('activates property editing for an editor that never wired itself up', () => {
    // A value preset registered by a plugin renders an arbitrary component
    // here. Its author never saw `usePropertyEditingActivation`, so if the
    // row didn't activate for it, Escape would be rejected by the
    // editable-target filter and the field would never exit — the reported
    // bug, surviving in every custom editor.
    activation.onFocus.mockClear()
    activation.onBlur.mockClear()

    const CustomEditor = () => <input aria-label="custom editor" />
    const row: PropertyPanelModelRow = {
      name: stringProp.name,
      encodedValue: 'a@example.com',
      isSet: true,
      labelText: stringProp.name,
      shape: stringProp.codec.type,
      schema: stringProp,
      schemaUnknown: false,
      decodeFailed: false,
      value: 'a@example.com',
      Editor: CustomEditor,
      Glyph: undefined,
      canRename: false,
      canDelete: false,
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

    fireEvent.focus(screen.getByLabelText('custom editor'))
    expect(activation.onFocus).toHaveBeenCalledTimes(1)

    fireEvent.blur(screen.getByLabelText('custom editor'))
    expect(activation.onBlur).toHaveBeenCalledTimes(1)
  })

  // `renameProperty` decides whether the user edited anything by comparing the
  // committed name against what this input hands back, so the input has to be
  // seeded with the RAW key — not `labelText`, which the read-only branch a few
  // lines away does render. Seeding it with the display label would rename every
  // overridden row to its label on a bare focus-and-leave.
  it('seeds the rename input with the raw key, not the display label', () => {
    const row: PropertyPanelModelRow = {
      name: ' padded ',
      encodedValue: 'v',
      isSet: true,
      labelText: 'Padded (display)',
      shape: paddedProp.codec.type,
      // A key with no registered schema still carries a synthesized display
      // schema — and `canRename` is true precisely because it is unknown.
      schema: paddedProp,
      schemaUnknown: true,
      decodeFailed: false,
      value: 'v',
      Editor: undefined,
      Glyph: undefined,
      canRename: true,
      canDelete: true,
      canChangeShape: false,
      isHidden: false,
      readOnly: false,
    }
    const onRename = vi.fn()

    render(
      <PropertyRow
        row={row}
        block={{id: 'block-1'} as Block}
        readOnly={false}
        canConfigure={false}
        onNavigate={vi.fn()}
        onConfigure={vi.fn()}
        onChange={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    )

    const input = screen.getByLabelText(`Field ${row.labelText}`) as HTMLInputElement
    expect(input.value).toBe(' padded ')
    // The edit itself still commits the raw key it was seeded from.
    fireEvent.change(input, {target: {value: ' padded x'}})
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledWith(' padded x')
  })

  // A text input's DOM value is sanitized — CR/LF are stripped — so an
  // UNTOUCHED field hands back a string that differs from the stored key, and
  // an editedness test that compares strings reads that as a rename. Only an
  // actual input event means the user typed something.
  it('does not rename a key containing a newline on a bare focus-and-blur', () => {
    const row = newlineRow()
    const onRename = vi.fn()

    const {container} = render(
      <PropertyRow
        row={row}
        block={{id: 'block-1'} as Block}
        readOnly={false}
        canConfigure={false}
        onNavigate={vi.fn()}
        onConfigure={vi.fn()}
        onChange={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    )

    const input = container.querySelector('input[data-property-label]') as HTMLInputElement
    // The precondition this case turns on: the DOM already differs from the key.
    expect(input.value).toBe(' padded ')
    expect(row.name).toBe(' pad\nded ')

    fireEvent.focus(input)
    fireEvent.blur(input)
    expect(onRename).not.toHaveBeenCalled()
  })

  it('still renames a newline key the user actually edits', () => {
    const row = newlineRow()
    const onRename = vi.fn()

    const {container} = render(
      <PropertyRow
        row={row}
        block={{id: 'block-1'} as Block}
        readOnly={false}
        canConfigure={false}
        onNavigate={vi.fn()}
        onConfigure={vi.fn()}
        onChange={vi.fn()}
        onRename={onRename}
        onDelete={vi.fn()}
      />,
    )

    const input = container.querySelector('input[data-property-label]') as HTMLInputElement
    fireEvent.change(input, {target: {value: 'padded'}})
    fireEvent.blur(input)
    expect(onRename).toHaveBeenCalledWith('padded')
  })
})
