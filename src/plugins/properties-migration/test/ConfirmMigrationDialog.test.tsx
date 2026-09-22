// @vitest-environment happy-dom
/**
 * The consent screen for the one-way properties migration.
 *
 * The subject is what it TELLS the operator, so these render the real
 * component and read the text — the gesture's own tests can only pin the props
 * it hands over, which a dropped `<KeyNames>` would leave green.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ConfirmMigrationDialog, type ConfirmMigrationDialogProps,
} from '../ConfirmMigrationDialog.tsx'

afterEach(cleanup)

const NONE = {count: 0, names: []}

const show = (over: Partial<ConfirmMigrationDialogProps> = {}) => render(
  <ConfirmMigrationDialog
    blockCount={7} childBacked
    synthesizedKeys={NONE} unfixableKeys={NONE} repairableKeys={NONE} stranded={null}
    resolve={vi.fn()} cancel={vi.fn()}
    {...over}
  />,
)

/** The whole screen's text, since a sentence and the names under it are
 *  separate nodes by design. */
const copy = () => screen.getByRole('dialog').textContent ?? ''

describe('what the consent screen names', () => {
  it('names the keys it will invent a definition for', () => {
    show({synthesizedKeys: {count: 2, names: ['demo:from-import', 'demo:orphan']}})

    expect(copy()).toContain('"demo:from-import", "demo:orphan"')
  })

  it('names the keys with a broken definition', () => {
    show({repairableKeys: {count: 1, names: ['demo:broken']}})

    expect(copy()).toContain('"demo:broken"')
  })

  it('names the keys nothing can ever define', () => {
    show({unfixableKeys: {count: 1, names: ['[[demo]]']}})

    expect(copy()).toContain('"[[demo]]"')
  })

  it('says how many keys it did not name, counting off the real total', () => {
    // The names are a sample — a consent screen listing hundreds of property
    // keys is one nobody finishes reading. Without the remainder the sample
    // reads as the whole list, which is the same lie the bare count told.
    show({synthesizedKeys: {count: 400, names: ['a', 'b', 'c']}})

    expect(copy()).toContain('and 397 more')
  })

  it('calls a key this device will not mint for stranded, not impossible', () => {
    // The repair is real and cheap and belongs to the DEVICE, so filing it
    // under "cannot be given a definition at all" is how it gets missed — the
    // same mistake `repairableKeys` was split out to avoid.
    show({stranded: {
      count: 1, names: ['demo:orphan'],
      reason: 'this device holds no content key for the encrypted workspace',
    }})

    expect(copy()).toContain('this device holds no content key')
    expect(copy()).toContain('"demo:orphan"')
    expect(copy()).not.toContain('cannot be given a definition at all')
  })

  it('says nothing about a category that has no keys', () => {
    show()

    expect(copy()).not.toMatch(/no definition|cannot be given|cannot read/)
  })
})
