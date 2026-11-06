// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SOURCE_BLOCK, setupBlockUi } from '@/components/renderer/test/sourceEditorFixture.tsx'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { HTML_DOCUMENT_TYPE } from '@/data/blockTypes'
import { focusBlock } from '@/data/properties.js'
import { BlockPasteShellDecorator } from '../BlockPasteShellDecorator.tsx'

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1', name: 'Alice'})}))

const PASTED = '<div>\n  <p>[[1,2],[3,4]]</p>\n</div>'

const shellProps = (block: Block) => ({
  resolveContext: {block, repo: block.repo, uiStateBlock: block.repo.block('panel'), scopeRootId: undefined, blockContext: {}},
  state: {shellProps: {}, shortcutSurfaceOptions: {}},
  children: state => <div data-testid="shell" {...state.shellProps}/>,
}) as ComponentProps<typeof BlockPasteShellDecorator>

/** Mounts the decorator on the fixture's block, typed as source and focused with no
 *  editor open, then pastes on it. */
const pasteOnSourceBlock = async (mount: ReturnType<typeof setupBlockUi>['mount']): Promise<Block> => {
  let target!: Block
  mount(block => {
    target = block
    return <BlockPasteShellDecorator {...shellProps(block)}/>
  })
  await target.repo.tx(tx => tx.update(SOURCE_BLOCK, {properties: {types: [HTML_DOCUMENT_TYPE]}}), {scope: ChangeScope.BlockDefault})
  await target.load()
  await focusBlock(target.repo.block('panel'), SOURCE_BLOCK)
  fireEvent.paste(await screen.findByTestId('shell'), {
    clipboardData: {getData: (kind: string) => kind === 'text/plain' ? PASTED : '', files: []},
  })
  return target
}

describe('pasting on an empty source block with no editor open', () => {
  const {mount} = setupBlockUi('')

  it('puts the clipboard into it whole', async () => {
    const target = await pasteOnSourceBlock(mount)
    await waitFor(() => expect(target.peek()?.content).toBe(PASTED))
    expect(await target.childIds.load()).toEqual([])
  })
})

describe('pasting on a source block that already has content', () => {
  const {mount} = setupBlockUi('<p>keep</p>')

  it('never overwrites it', async () => {
    const target = await pasteOnSourceBlock(mount)
    // It lands elsewhere; the fence is that it landed.
    await waitFor(async () => expect((await target.childIds.load()).length).toBeGreaterThan(0))
    expect(target.peek()?.content).toBe('<p>keep</p>')
  })
})
