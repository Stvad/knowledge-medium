import { describe, expect, it, vi } from 'vitest'
import type { Block } from '../../../data/block'
import type { BlockData, BlockRendererProps } from '@/types.ts'
import { EXTENSION_TYPE } from '@/data/blockTypes'
import { typesProp } from '@/data/properties'

// Importing the renderer pulls in DefaultBlockRenderer → radix-ui →
// react-dom. Stub the heavy transitive deps so the canRender/priority
// surface is testable in isolation.
vi.mock('@/components/renderer/DefaultBlockRenderer.tsx', () => ({
  DefaultBlockRenderer: () => null,
}))
vi.mock('@/components/BlockEditor.tsx', () => ({
  BlockEditor: () => null,
}))

const { CodeMirrorExtensionBlockRenderer } = await import(
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
    createdBy: 'user-1',
    updatedBy: 'user-1',
    deleted: false,
  }
  return {
    id,
    peek: () => data,
  } as unknown as Block
}

const propsFor = (block: Block): BlockRendererProps => ({block} as unknown as BlockRendererProps)

describe('CodeMirrorExtensionBlockRenderer.canRender', () => {
  it('returns true when block has the extension type', () => {
    const block = fakeBlock('ext-1', {[typesProp.name]: typesProp.codec.encode([EXTENSION_TYPE])})
    expect(CodeMirrorExtensionBlockRenderer.canRender?.(propsFor(block))).toBe(true)
  })

  it('returns false when block has another type', () => {
    const block = fakeBlock('plain-1', {[typesProp.name]: typesProp.codec.encode(['note'])})
    expect(CodeMirrorExtensionBlockRenderer.canRender?.(propsFor(block))).toBe(false)
  })

  it('returns false when types property is missing', () => {
    const block = fakeBlock('plain-2')
    expect(CodeMirrorExtensionBlockRenderer.canRender?.(propsFor(block))).toBe(false)
  })

  it('reports priority 5', () => {
    const block = fakeBlock('any')
    expect(CodeMirrorExtensionBlockRenderer.priority?.(propsFor(block))).toBe(5)
  })
})
