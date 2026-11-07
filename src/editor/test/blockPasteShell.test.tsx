// @vitest-environment happy-dom
import { fireEvent, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SOURCE_BLOCK, setupBlockUi } from '@/test/blockUiFixture.tsx'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import { HTML_DOCUMENT_TYPE } from '@/data/blockTypes'
import { focusBlock } from '@/data/properties.js'
import { captureMediaVerb } from '@/paste/captureMediaVerb.js'
import { pasteDecisionVerb } from '@/paste/decision.js'
import { BlockPasteShellDecorator } from '../BlockPasteShellDecorator.tsx'

vi.mock('@/components/Login.tsx', () => ({useUser: () => ({id: 'user-1', name: 'Alice'})}))

const PASTED = '<div>\n  <p>[[1,2],[3,4]]</p>\n</div>'

const shellProps = (block: Block, uiStateBlock: Block) => ({
  resolveContext: {block, repo: block.repo, uiStateBlock, scopeRootId: undefined, blockContext: {}},
  state: {shellProps: {}, shortcutSurfaceOptions: {}},
  children: state => <div data-testid="shell" {...state.shellProps}/>,
}) as ComponentProps<typeof BlockPasteShellDecorator>

/** Mounts the decorator on the fixture's block, typed and focused with no editor open. */
const openBlock = async ({mount, panel}: ReturnType<typeof setupBlockUi>, types: string[] = [HTML_DOCUMENT_TYPE]): Promise<Block> => {
  let target!: Block
  mount(block => {
    target = block
    return <BlockPasteShellDecorator {...shellProps(block, panel())}/>
  })
  await target.repo.tx(tx => tx.update(SOURCE_BLOCK, {properties: {types}}), {scope: ChangeScope.BlockDefault})
  await target.load()
  await focusBlock(panel(), SOURCE_BLOCK)
  return target
}

const paste = async (clipboard: {text?: string; html?: string; files?: File[]}) => {
  fireEvent.paste(await screen.findByTestId('shell'), {
    clipboardData: {
      getData: (kind: string) => (kind === 'text/plain' ? clipboard.text : kind === 'text/html' ? clipboard.html : '') ?? '',
      files: clipboard.files ?? [],
    },
  })
}

describe('pasting on an empty source block with no editor open', () => {
  // What the attachments plugin contributes: a file makes it a `media` paste, whatever
  // the intent, and its capture is spliced in as `((id))` text.
  const ui = setupBlockUi('', [
    pasteDecisionVerb.decorator(next => request => (request.files?.length ? {kind: 'media'} : next(request)), {source: 'test'}),
    captureMediaVerb.impl(async ({files}) => ({references: files.map(() => '((captured-file))')}), {source: 'test'}),
  ])
  const FILE = new File(['x'], 'x.png', {type: 'image/png'})

  it('puts the text into it whole', async () => {
    const target = await openBlock(ui)
    await paste({text: PASTED})
    await waitFor(() => expect(target.peek()?.content).toBe(PASTED))
    expect(await target.childIds.load()).toEqual([])
  })

  it('leaves an empty ordinary block to paste as an outline', async () => {
    const target = await openBlock(ui, [])
    await paste({text: PASTED})
    await waitFor(() => expect(target.peek()?.content).toBe('<div>'))
  })

  // No write has a moment to fence on, so the next paste is the fence: it only lands
  // whole on a block the first one left empty.
  it.each<[string, {html?: string; files?: File[]}]>([
    ['html alone', {html: '<div><p>one</p><p>two</p></div>'}],
    ['a file alone', {files: [FILE]}],
  ])('writes nothing for %s', async (_name, clipboard) => {
    const target = await openBlock(ui)
    await paste(clipboard)
    await paste({text: PASTED})
    await waitFor(() => expect(target.peek()?.content).toBe(PASTED))
    expect(await target.childIds.load()).toEqual([])
  })

  it('leaves a file out when there is text too', async () => {
    const target = await openBlock(ui)
    await paste({text: PASTED, files: [FILE]})
    await waitFor(() => expect(target.peek()?.content).toBe(PASTED))
  })
})

describe('pasting on a source block that already has content', () => {
  const ui = setupBlockUi('<p>keep</p>')

  it('never overwrites it, and pastes around it as an outline', async () => {
    const target = await openBlock(ui)
    await paste({text: PASTED})
    // It lands elsewhere; the fence is that it landed.
    await waitFor(async () => expect((await target.childIds.load()).length).toBeGreaterThan(0))
    expect(target.peek()?.content).toBe('<p>keep</p>')
    const [first] = await target.childIds.load()
    expect(target.repo.block(first).peek()?.content).toBe('<div>')
  })
})
