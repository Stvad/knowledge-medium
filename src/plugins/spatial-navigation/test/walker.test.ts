// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetSpatialNavigationForTesting,
  firstInstanceIn,
  horizontalNeighborPanel,
  lastInstanceIn,
  locateInstance,
  panelById,
  rememberInstancePosition,
  stackSiblingPanel,
  verticalNeighbor,
} from '@/plugins/spatial-navigation/walker.ts'

interface InstanceSpec {
  blockId: string
  instance: string
  surface?: string
  entryId?: string
}

interface PanelSpec {
  panelId: string
  instances: InstanceSpec[]
}

type LayoutSpec = ReadonlyArray<
  | {kind: 'panel'; columnId: string; panel: PanelSpec}
  | {kind: 'stack'; columnId: string; panels: PanelSpec[]}
>

const buildPanel = (spec: PanelSpec): HTMLElement => {
  const el = document.createElement('div')
  el.setAttribute('data-panel-id', spec.panelId)
  for (const inst of spec.instances) {
    const block = document.createElement('div')
    block.setAttribute('data-block-instance', inst.instance)
    block.setAttribute('data-block-id', inst.blockId)
    if (inst.surface) block.setAttribute('data-block-surface', inst.surface)
    if (inst.entryId) block.setAttribute('data-backlink-entry-id', inst.entryId)
    el.appendChild(block)
  }
  return el
}

const buildLayout = (spec: LayoutSpec): HTMLElement => {
  const root = document.createElement('div')
  for (const entry of spec) {
    const column = document.createElement('div')
    column.setAttribute('data-layout-column-id', entry.columnId)
    if (entry.kind === 'panel') {
      column.appendChild(buildPanel(entry.panel))
    } else {
      for (const p of entry.panels) column.appendChild(buildPanel(p))
    }
    root.appendChild(column)
  }
  document.body.appendChild(root)
  return root
}

const findInstance = (instance: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-block-instance="${instance}"]`)
  if (!el) throw new Error(`instance ${instance} not in DOM`)
  return el
}

beforeEach(() => {
  __resetSpatialNavigationForTesting()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('vertical neighbor (h/k)', () => {
  it('walks DOM order within a panel', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'A', instance: 'p1:A'},
          {blockId: 'B', instance: 'p1:B'},
          {blockId: 'C', instance: 'p1:C'},
        ],
      }},
    ])
    expect(verticalNeighbor(findInstance('p1:A'), 'down')?.dataset.blockInstance).toBe('p1:B')
    expect(verticalNeighbor(findInstance('p1:B'), 'down')?.dataset.blockInstance).toBe('p1:C')
    expect(verticalNeighbor(findInstance('p1:C'), 'down')).toBeNull()
    expect(verticalNeighbor(findInstance('p1:B'), 'up')?.dataset.blockInstance).toBe('p1:A')
  })

  it('walks into the backlinks surface as just more in-panel instances', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'A', instance: 'p1:A', surface: 'outline'},
          {blockId: 'B', instance: 'p1:B', surface: 'outline'},
          {blockId: 'X', instance: 'p1:backlink:e1:X', surface: 'backlink', entryId: 'e1'},
          {blockId: 'Y', instance: 'p1:backlink:e2:Y', surface: 'backlink', entryId: 'e2'},
        ],
      }},
    ])
    expect(verticalNeighbor(findInstance('p1:B'), 'down')?.dataset.blockInstance).toBe('p1:backlink:e1:X')
    expect(verticalNeighbor(findInstance('p1:backlink:e1:X'), 'down')?.dataset.blockInstance).toBe('p1:backlink:e2:Y')
  })

  it('skips breadcrumb-surface instances when walking', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'crumb', instance: 'p1:crumb:1', surface: 'breadcrumb'},
          {blockId: 'A', instance: 'p1:A', surface: 'outline'},
          {blockId: 'B', instance: 'p1:B', surface: 'outline'},
        ],
      }},
    ])
    expect(verticalNeighbor(findInstance('p1:A'), 'up')).toBeNull()
    expect(verticalNeighbor(findInstance('p1:A'), 'down')?.dataset.blockInstance).toBe('p1:B')
  })

  it('does not loop when the same block appears twice in backlinks', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [
          {blockId: 'A', instance: 'p1:A', surface: 'outline'},
          {blockId: 'X', instance: 'p1:backlink:e1:X', surface: 'backlink', entryId: 'e1'},
          {blockId: 'X', instance: 'p1:backlink:e2:X', surface: 'backlink', entryId: 'e2'},
        ],
      }},
    ])
    // Same block (X) appears twice; distinct instance keys differentiate them.
    expect(verticalNeighbor(findInstance('p1:backlink:e1:X'), 'down')?.dataset.blockInstance)
      .toBe('p1:backlink:e2:X')
    expect(verticalNeighbor(findInstance('p1:backlink:e2:X'), 'down')).toBeNull()
  })

  it('falls through to a stack-sibling panel below in the same column', () => {
    buildLayout([
      {kind: 'stack', columnId: 'c1', panels: [
        {panelId: 'p-top', instances: [
          {blockId: 'A', instance: 'p-top:A'},
          {blockId: 'B', instance: 'p-top:B'},
        ]},
        {panelId: 'p-bot', instances: [
          {blockId: 'C', instance: 'p-bot:C'},
          {blockId: 'D', instance: 'p-bot:D'},
        ]},
      ]},
    ])
    // Off the bottom of the top stack panel → first instance of bottom panel.
    expect(verticalNeighbor(findInstance('p-top:B'), 'down')?.dataset.blockInstance).toBe('p-bot:C')
    // Off the top of the bottom stack panel → last instance of top panel.
    expect(verticalNeighbor(findInstance('p-bot:C'), 'up')?.dataset.blockInstance).toBe('p-top:B')
  })

  it('does NOT fall through into a horizontally-adjacent column for k', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {
        panelId: 'p1',
        instances: [{blockId: 'A', instance: 'p1:A'}],
      }},
      {kind: 'panel', columnId: 'c2', panel: {
        panelId: 'p2',
        instances: [{blockId: 'B', instance: 'p2:B'}],
      }},
    ])
    // p1 has no in-panel down target; p2 is in a different column → null.
    expect(verticalNeighbor(findInstance('p1:A'), 'down')).toBeNull()
  })
})

describe('horizontal neighbor panel (j/l)', () => {
  it('moves to the next/prev column panel', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
      {kind: 'panel', columnId: 'c2', panel: {panelId: 'p2', instances: [{blockId: 'B', instance: 'p2:B'}]}},
      {kind: 'panel', columnId: 'c3', panel: {panelId: 'p3', instances: [{blockId: 'C', instance: 'p3:C'}]}},
    ])
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'right')?.dataset.panelId).toBe('p2')
    expect(horizontalNeighborPanel(findInstance('p2:B'), 'right')?.dataset.panelId).toBe('p3')
    expect(horizontalNeighborPanel(findInstance('p3:C'), 'right')).toBeNull()
    expect(horizontalNeighborPanel(findInstance('p2:B'), 'left')?.dataset.panelId).toBe('p1')
  })

  it('skips past stack-mates and enters the top of an adjacent stack column', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
      {kind: 'stack', columnId: 'c2', panels: [
        {panelId: 'p2-top', instances: [{blockId: 'B', instance: 'p2-top:B'}]},
        {panelId: 'p2-bot', instances: [{blockId: 'C', instance: 'p2-bot:C'}]},
      ]},
      {kind: 'panel', columnId: 'c3', panel: {panelId: 'p3', instances: [{blockId: 'D', instance: 'p3:D'}]}},
    ])
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'right')?.dataset.panelId).toBe('p2-top')
    // From inside the stack's bottom panel, j/l moves to c3 — NOT to p2-top.
    expect(horizontalNeighborPanel(findInstance('p2-bot:C'), 'right')?.dataset.panelId).toBe('p3')
  })

  it('no-op when there is only one column', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
    ])
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'right')).toBeNull()
    expect(horizontalNeighborPanel(findInstance('p1:A'), 'left')).toBeNull()
  })
})

describe('stackSiblingPanel', () => {
  it('returns null for single-panel columns', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
    ])
    expect(stackSiblingPanel(panelById('p1')!, 'down')).toBeNull()
  })

  it('returns the next/prev panel in a stacked column', () => {
    buildLayout([
      {kind: 'stack', columnId: 'c1', panels: [
        {panelId: 'p-top', instances: [{blockId: 'A', instance: 'p-top:A'}]},
        {panelId: 'p-mid', instances: [{blockId: 'B', instance: 'p-mid:B'}]},
        {panelId: 'p-bot', instances: [{blockId: 'C', instance: 'p-bot:C'}]},
      ]},
    ])
    expect(stackSiblingPanel(panelById('p-top')!, 'down')?.dataset.panelId).toBe('p-mid')
    expect(stackSiblingPanel(panelById('p-mid')!, 'down')?.dataset.panelId).toBe('p-bot')
    expect(stackSiblingPanel(panelById('p-bot')!, 'down')).toBeNull()
    expect(stackSiblingPanel(panelById('p-bot')!, 'up')?.dataset.panelId).toBe('p-mid')
  })
})

describe('locateInstance recovery', () => {
  it('tier 1: exact key match', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    const result = locateInstance('p1', {focusedBlockId: 'A', focusedVisualTargetKey: 'p1:B'})
    expect(result?.dataset.blockInstance).toBe('p1:B')
  })

  it('tier 2: any instance of the focused block (key gone after re-render)', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A-new'},
      ]}},
    ])
    // The old key (p1:A-old) no longer exists; block A is still present
    // under a new instance key after re-render.
    const result = locateInstance('p1', {focusedBlockId: 'A', focusedVisualTargetKey: 'p1:A-old'})
    expect(result?.dataset.blockInstance).toBe('p1:A-new')
  })

  it("tier 3: recovers to 'block just above' when the focused block disappeared", () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'Y', instance: 'p1:Y'},
        {blockId: 'Z', instance: 'p1:Z'},
      ]}},
    ])
    // User was sitting on Y — we tracked its position.
    rememberInstancePosition('p1', findInstance('p1:Y'))
    // Y is edited out of the panel (e.g. a backlink that no longer
    // matches); X and Z remain.
    findInstance('p1:Y').remove()
    // focusedBlockId still points to Y. Recovery target: the block
    // immediately above Y was X, so we land on X.
    const result = locateInstance('p1', {focusedBlockId: 'Y'})
    expect(result?.dataset.blockInstance).toBe('p1:X')
  })

  it('tier 3: clamps "block just above" to 0 when the disappeared block was first', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    rememberInstancePosition('p1', findInstance('p1:A'))
    findInstance('p1:A').remove()
    // A was at idx 0; -1 clamps to 0 in the remaining single-item list.
    expect(locateInstance('p1', {focusedBlockId: 'A'})?.dataset.blockInstance).toBe('p1:B')
  })

  it('tier 3: ignores a stale hint that points to a different block', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'Y', instance: 'p1:Y'},
        {blockId: 'Z', instance: 'p1:Z'},
      ]}},
    ])
    // Hint records Y, but we're recovering for an unrelated 'A' that
    // never sat in this panel. Falls through to tier 4 (first instance).
    rememberInstancePosition('p1', findInstance('p1:Y'))
    const result = locateInstance('p1', {focusedBlockId: 'A', focusedVisualTargetKey: 'gone'})
    expect(result?.dataset.blockInstance).toBe('p1:X')
  })

  it('falls back to the first instance when no hints are stored', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'X', instance: 'p1:X'},
        {blockId: 'Y', instance: 'p1:Y'},
      ]}},
    ])
    const result = locateInstance('p1', {})
    expect(result?.dataset.blockInstance).toBe('p1:X')
  })

  it('returns null when the panel has no instances', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: []}},
    ])
    expect(locateInstance('p1', {focusedBlockId: 'A'})).toBeNull()
  })

  it('returns null when the panel is not in the DOM', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [{blockId: 'A', instance: 'p1:A'}]}},
    ])
    expect(locateInstance('not-mounted', {})).toBeNull()
  })
})

describe('firstInstanceIn / lastInstanceIn', () => {
  it('returns first and last navigable instances', () => {
    buildLayout([
      {kind: 'panel', columnId: 'c1', panel: {panelId: 'p1', instances: [
        {blockId: 'crumb', instance: 'p1:crumb', surface: 'breadcrumb'},
        {blockId: 'A', instance: 'p1:A'},
        {blockId: 'B', instance: 'p1:B'},
      ]}},
    ])
    const panel = panelById('p1')!
    expect(firstInstanceIn(panel)?.dataset.blockInstance).toBe('p1:A')
    expect(lastInstanceIn(panel)?.dataset.blockInstance).toBe('p1:B')
  })
})
