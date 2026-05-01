/* eslint-disable react-compiler/react-compiler */
'use no memo'
/**
 * Virtualized flat-list rendering of a block subtree.
 *
 * NOTE on React Compiler: this file is compiler-disabled. Both
 * react-virtuoso and @tanstack/react-virtual maintain internal state
 * machines that drive re-renders on scroll/resize. React Compiler's
 * aggressive memoization treats those internal updates as stale and
 * skips the re-render — the visible-rows window never advances and the
 * virtualizer wedges. Opt out so the libraries' own rendering loop
 * works.
 *
 * Spike: replaces the recursive `<BlockChildren>` tree with a flat list
 * of `(block, depth)` rows fed into `@tanstack/react-virtual`. Only the
 * blocks intersecting the scroll viewport are mounted, so the per-block
 * subscription / hook cost stays bounded regardless of how big the
 * subtree is.
 *
 * Each row renders `<BlockComponent>` under a `suppressChildren=true`
 * context, so `DefaultBlockRenderer` skips its own `<BlockChildren>`
 * recursion — descendants appear as siblings in the flat list instead.
 *
 * Why @tanstack/react-virtual (not react-virtuoso): we tried virtuoso
 * first and it would not start rendering items past ~100 entries — its
 * data prop arrived but `itemContent` was never invoked. Tanstack is
 * lower-level: we own the scroll container layout and the per-row
 * positioning, which is more code but also more predictable for a
 * non-trivial integration.
 *
 * Sizing: each row's actual height is captured via
 * `virtualizer.measureElement` (ResizeObserver-based). The initial
 * estimate is the average we measured across content (~80 px after the
 * first row, ~30 px for short bullets — picked 60 as a compromise).
 * Subsequent items reposition once measured.
 *
 * Collapse handling: ancestors flagged with `isCollapsedProp` hide
 * their descendants from the flat list. The flatten reads each block's
 * snapshot via `block.peek()` (no extra subscriptions). Tree-shape
 * changes propagate through the subtree handle's reactivity.
 */

import { useMemo, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Block } from '@/data/internals/block'
import { useSubtree } from '@/hooks/block.ts'
import { isCollapsedProp } from '@/data/properties.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { BlockComponent } from '@/components/BlockComponent.tsx'

interface FlatRow {
  block: Block
  depth: number
}

const INDENT_PX = 24
const ESTIMATED_ROW_PX = 60
const SUPPRESS_CHILDREN_OVERRIDE = { suppressChildren: true } as const
const EMPTY_ROWS: FlatRow[] = []

const flattenSubtree = (blocks: Block[], rootId: string): FlatRow[] => {
  if (blocks.length === 0) return EMPTY_ROWS

  const byId = new Map<string, Block>()
  const childrenByParent = new Map<string | null, Block[]>()
  for (const b of blocks) {
    byId.set(b.id, b)
    const data = b.peek()
    if (!data) continue
    const list = childrenByParent.get(data.parentId) ?? []
    list.push(b)
    childrenByParent.set(data.parentId, list)
  }

  const collapsedKey = isCollapsedProp.name
  const isCollapsed = (block: Block): boolean => {
    const data = block.peek()
    if (!data) return false
    const stored = data.properties?.[collapsedKey]
    if (stored === undefined) return false
    try {
      return Boolean(isCollapsedProp.codec.decode(stored))
    } catch {
      return false
    }
  }

  const out: FlatRow[] = []
  const root = byId.get(rootId)
  if (!root) return EMPTY_ROWS
  const stack: FlatRow[] = [{ block: root, depth: 0 }]
  while (stack.length > 0) {
    const row = stack.pop()!
    out.push(row)
    if (isCollapsed(row.block)) continue
    const kids = childrenByParent.get(row.block.id)
    if (!kids) continue
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({ block: kids[i], depth: row.depth + 1 })
    }
  }
  return out
}

export function VirtualizedBlockTree({ rootBlock }: { rootBlock: Block }) {
  const blocks = useSubtree(rootBlock)

  const flatRows = useMemo<FlatRow[]>(() => {
    if (blocks.length === 0) return EMPTY_ROWS
    return flattenSubtree(blocks, rootBlock.id)
  }, [blocks, rootBlock])

  const parentRef = useRef<HTMLDivElement | null>(null)

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 8,
    getItemKey: (index) => flatRows[index]?.block.id ?? index,
  })

  const items = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div
      ref={parentRef}
      className="virtualized-block-tree flex-grow min-h-0 overflow-y-auto scrollbar-none"
    >
      <div
        style={{
          height: `${totalSize}px`,
          width: '100%',
          position: 'relative',
        }}
      >
        {items.map((virtualRow) => {
          const row = flatRows[virtualRow.index]
          if (!row) return null
          return (
            <div
              key={virtualRow.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                paddingLeft: `${row.depth * INDENT_PX}px`,
              }}
            >
              <NestedBlockContextProvider overrides={SUPPRESS_CHILDREN_OVERRIDE}>
                <BlockComponent blockId={row.block.id} />
              </NestedBlockContextProvider>
            </div>
          )
        })}
      </div>
    </div>
  )
}
