// @vitest-environment happy-dom
import {fireEvent, screen, waitFor, within} from '@testing-library/react'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {SOURCE_BLOCK, setupBlockUi} from '@/components/renderer/test/sourceEditorFixture.tsx'
import {actionContextsFacet} from '@/extensions/core.js'
import {DialogHost} from '@/extensions/dialogAppMount.js'
import {defaultActionContextConfigs} from '@/shortcuts/defaultContexts.js'
import {HtmlDocumentView} from '../HtmlDocumentContent.tsx'
import {readConsent} from '../scriptConsent.ts'

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1', name: 'Alice'})}))

const SOURCE = '<p>hi</p><script>x()</script>'

describe('Run scripts on the strip', () => {
  const {mount} = setupBlockUi(SOURCE, defaultActionContextConfigs.map(context => actionContextsFacet.of(context)))
  beforeEach(() => localStorage.clear())

  const openDialogFromStrip = async () => {
    mount(block => <><HtmlDocumentView block={block}/><DialogHost/></>)
    fireEvent.click(await screen.findByRole('button', {name: 'Run scripts'}))
    return await screen.findByRole('dialog')
  }

  it('allows nothing until the dialog is confirmed, and ignores a click that follows straight on', async () => {
    const dialog = await openDialogFromStrip()
    expect(readConsent(SOURCE_BLOCK)).toBe('')
    expect(document.querySelector('.ring-primary')).not.toBeNull()

    const confirm = within(dialog).getByRole<HTMLButtonElement>('button', {name: 'Run scripts'})
    fireEvent.click(confirm)
    expect(screen.queryByRole('dialog')).not.toBeNull()
    expect(readConsent(SOURCE_BLOCK)).toBe('')

    await waitFor(() => expect(confirm.disabled).toBe(false))
    fireEvent.click(confirm)
    await screen.findByRole('button', {name: 'Stop scripts'})
    expect(readConsent(SOURCE_BLOCK)).not.toBe('')
  })

  it('stays held on Cancel', async () => {
    const dialog = await openDialogFromStrip()
    fireEvent.click(within(dialog).getByRole('button', {name: 'Cancel'}))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(readConsent(SOURCE_BLOCK)).toBe('')
    expect(document.querySelector('.ring-primary')).toBeNull()
  })
})
