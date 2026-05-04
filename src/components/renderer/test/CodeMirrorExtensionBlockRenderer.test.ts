import { describe, expect, it, vi } from 'vitest'
import type { Block } from '../../../data/block'
import type { BlockData, BlockRendererProps } from '@/types.ts'

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
  it('returns true when block type is extension', () => {
    const block = fakeBlock('ext-1', {type: 'extension'})
    expect(CodeMirrorExtensionBlockRenderer.canRender?.(propsFor(block))).toBe(true)
  })

  it('returns false when block type is anything else', () => {
    const block = fakeBlock('plain-1', {type: 'note'})
    expect(CodeMirrorExtensionBlockRenderer.canRender?.(propsFor(block))).toBe(false)
  })

  it('returns false when type property is missing', () => {
    const block = fakeBlock('plain-2')
    expect(CodeMirrorExtensionBlockRenderer.canRender?.(propsFor(block))).toBe(false)
  })

  it('reports priority 5', () => {
    const block = fakeBlock('any')
    expect(CodeMirrorExtensionBlockRenderer.priority?.(propsFor(block))).toBe(5)
  })
})
