import { describe, expect, it } from 'vitest'
import type { BlockData } from '@/data/api'
import { PAGE_TYPE } from '@/data/blockTypes.js'
import { typesProp } from '@/data/properties.js'
import { pickMergeContentStrategy } from './strategy.ts'

const makeBlock = (overrides: Partial<BlockData> = {}): BlockData => ({
  id: overrides.id ?? 'b',
  workspaceId: 'ws-1',
  parentId: null,
  orderKey: 'a0',
  content: '',
  properties: {},
  references: [],
  createdAt: 0,
  updatedAt: 0,
  createdBy: 'u',
  updatedBy: 'u',
  deleted: false,
  ...overrides,
})

const asPage = (block: BlockData): BlockData => ({
  ...block,
  properties: {...block.properties, [typesProp.name]: typesProp.codec.encode([PAGE_TYPE])},
})

describe('pickMergeContentStrategy', () => {
  it("returns 'concat' when neither block is a page (outline-block merge)", () => {
    expect(pickMergeContentStrategy(makeBlock(), makeBlock())).toBe('concat')
  })

  it("returns 'keepTarget' when source is a page", () => {
    expect(pickMergeContentStrategy(asPage(makeBlock()), makeBlock())).toBe('keepTarget')
  })

  it("returns 'keepTarget' when target is a page", () => {
    expect(pickMergeContentStrategy(makeBlock(), asPage(makeBlock()))).toBe('keepTarget')
  })

  it("returns 'keepTarget' when both are pages", () => {
    expect(pickMergeContentStrategy(asPage(makeBlock()), asPage(makeBlock()))).toBe('keepTarget')
  })
})
