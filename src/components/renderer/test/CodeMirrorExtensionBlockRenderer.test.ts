import { describe, expect, it, vi } from 'vitest'
import type { Block } from '../../../data/block'
import type { Repo } from '@/data/repo'
import type { BlockData } from '@/types.js'
import type { BlockRendererContext } from '@/extensions/blockInteraction.js'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { getBlockTypes, typesProp } from '@/data/properties'

// Importing the renderer pulls in DefaultBlockRenderer → radix-ui →
// react-dom. Stub the heavy transitive deps so the resolve surface is
// testable in isolation.
vi.mock('@/components/renderer/DefaultBlockRenderer.tsx', () => ({
  DefaultBlockRenderer: () => null,
}))
vi.mock('@/components/BlockEditor.tsx', () => ({
  BlockEditor: () => null,
}))

const { CodeMirrorExtensionBlockRenderer, codeMirrorExtensionRendererRegistration } = await import(
  '@/components/renderer/CodeMirrorExtensionBlockRenderer.tsx'
)

const fakeBlock = (id: string, properties: BlockData['properties'] = {}): Block => {
  const data: BlockData = {
    id,
    workspaceId: 'ws-1',
    parentId: null,
    orderKey: 'a0',
    content: 'export default []',
    properties,
    references: [],
    createdAt: 0,
    updatedAt: 0,
    userUpdatedAt: 0,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    deleted: false,
  }
  return {
    id,
    peek: () => data,
  } as unknown as Block
}

const ctxFor = (block: Block): BlockRendererContext => ({
  block,
  repo: {} as Repo,
  types: getBlockTypes(block.peek()!),
})

describe('codeMirrorExtensionRendererRegistration.resolve', () => {
  it('claims the block when it has the extension type', () => {
    const block = fakeBlock('ext-1', {[typesProp.name]: typesProp.codec.encode([EXTENSION_TYPE])})
    expect(codeMirrorExtensionRendererRegistration.resolve?.(ctxFor(block)))
      .toEqual({render: CodeMirrorExtensionBlockRenderer, claims: true})
  })

  it('declines a block with another type', () => {
    const block = fakeBlock('plain-1', {[typesProp.name]: typesProp.codec.encode(['note'])})
    expect(codeMirrorExtensionRendererRegistration.resolve?.(ctxFor(block)))
      .toMatchObject({claims: false})
  })

  it('declines a block with no types property', () => {
    const block = fakeBlock('plain-2')
    expect(codeMirrorExtensionRendererRegistration.resolve?.(ctxFor(block)))
      .toMatchObject({claims: false})
  })

  // Declining without dropping out is what keeps a stored `renderer:
  // extension` on an ordinary block working — the registry lookup used to
  // bypass the gate entirely, and `byId` only sees variants that resolved.
  it('stays available to an explicit request on a block it does not claim', () => {
    const block = fakeBlock('plain-3', {[typesProp.name]: typesProp.codec.encode(['note'])})
    expect(codeMirrorExtensionRendererRegistration.resolve?.(ctxFor(block)))
      .toMatchObject({render: CodeMirrorExtensionBlockRenderer})
  })
})
