// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { SOURCE_BLOCK, setupBlockUi } from '@/components/renderer/test/sourceEditorFixture.tsx'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { HTML_DOCUMENT_TYPE } from '@/data/blockTypes'
import { focusBlock } from '@/data/properties.js'
import { BlockPasteShellDecorator } from '../BlockPasteShellDecorator.tsx'

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1', name: 'Alice'})}))

const SHELL_STATE = {shellProps: {}, shortcutSurfaceOptions: {}}
const PASTED = '<div>\n  <p>[[1,2],[3,4]]</p>\n</div>'

describe('pasting on a focused block, with no editor open', () => {
  const {mount} = setupBlockUi('')

  const shell = (block: Block) => {
    const context = {block, repo: block.repo, uiStateBlock: block.repo.block('panel'), scopeRootId: undefined, blockContext: {}}
    return (
      <BlockPasteShellDecorator resolveContext={context as never} state={SHELL_STATE as never}>
        {state => <div data-testid="shell" {...state.shellProps}/>}
      </BlockPasteShellDecorator>
    )
  }

  it('puts the clipboard whole into an empty source block', async () => {
    let target!: Block
    mount(block => {
      target = block
      return shell(block)
    })
    await target.repo.tx(tx => tx.update(SOURCE_BLOCK, {properties: {types: [HTML_DOCUMENT_TYPE]}}), {scope: ChangeScope.BlockDefault})
    await target.load()
    await focusBlock(target.repo.block('panel'), SOURCE_BLOCK)

    fireEvent.paste(await screen.findByTestId('shell'), {
      clipboardData: {getData: (kind: string) => kind === 'text/plain' ? PASTED : '', files: []},
    })

    await waitFor(() => expect(target.peek()?.content).toBe(PASTED))
    expect(await target.childIds.load()).toEqual([])
  })
})

describe('pasting on a focused source block that already has content', () => {
  const {mount} = setupBlockUi('<p>keep</p>')

  it('never overwrites it', async () => {
    let target!: Block
    mount(block => {
      target = block
      const context = {block, repo: block.repo, uiStateBlock: block.repo.block('panel'), scopeRootId: undefined, blockContext: {}}
      return (
        <BlockPasteShellDecorator resolveContext={context as never} state={SHELL_STATE as never}>
          {state => <div data-testid="shell" {...state.shellProps}/>}
        </BlockPasteShellDecorator>
      )
    })
    await target.repo.tx(tx => tx.update(SOURCE_BLOCK, {properties: {types: [HTML_DOCUMENT_TYPE]}}), {scope: ChangeScope.BlockDefault})
    await target.load()
    await focusBlock(target.repo.block('panel'), SOURCE_BLOCK)

    fireEvent.paste(await screen.findByTestId('shell'), {
      clipboardData: {getData: (kind: string) => kind === 'text/plain' ? PASTED : '', files: []},
    })

    // It lands elsewhere; the fence is that it landed.
    await waitFor(async () => expect((await target.childIds.load()).length).toBeGreaterThan(0))
    expect(target.peek()?.content).toBe('<p>keep</p>')
  })
})
