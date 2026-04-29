import { describe, expect, it } from 'vitest'
import { planImport } from '../plan'
import { roamBlockId } from '../ids'
import { dailyNoteBlockId } from '@/data/dailyNotes'
import type { RoamExport } from '../types'

const WORKSPACE = '11111111-2222-4333-8444-555555555555'
const USER = '99999999-aaaa-4bbb-8ccc-dddddddddddd'

const minimalExport: RoamExport = [
  {
    title: 'wcs/plan',
    uid: 'page1uid',
    'create-time': 1700000000000,
    'edit-time': 1700000000000,
    children: [
      {
        string: 'top with ((child1uid))',
        uid: 'parentuid',
        'create-time': 1700000001000,
        'edit-time': 1700000001000,
        ':block/refs': [{':block/uid': 'child1uid'}],
        children: [
          {
            string: '#tag and **bold**',
            uid: 'child1uid',
            'create-time': 1700000002000,
            heading: 2,
          },
        ],
      },
    ],
  },
  {
    title: 'April 28th, 2026',
    uid: '04-28-2026',
    'create-time': 1777334400000,
    'edit-time': 1777334400000,
    ':log/id': 1777334400000,
    children: [
      {
        string: 'morning notes',
        uid: 'dailychild',
        'create-time': 1777334401000,
      },
    ],
  },
]

describe('planImport', () => {
  it('builds deterministic ids per Roam uid', () => {
    const plan = planImport(minimalExport, {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.uidMap.get('page1uid')).toBe(roamBlockId(WORKSPACE, 'page1uid'))
    expect(plan.uidMap.get('parentuid')).toBe(roamBlockId(WORKSPACE, 'parentuid'))
    expect(plan.uidMap.get('child1uid')).toBe(roamBlockId(WORKSPACE, 'child1uid'))
  })

  it('routes daily pages through dailyNoteBlockId', () => {
    const plan = planImport(minimalExport, {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.uidMap.get('04-28-2026')).toBe(dailyNoteBlockId(WORKSPACE, '2026-04-28'))
    const daily = plan.pages.find(p => p.isDaily)
    expect(daily?.iso).toBe('2026-04-28')
    expect(daily?.title).toBe('April 28th, 2026')
  })

  it('emits non-daily page data with alias property and child ids', () => {
    const plan = planImport(minimalExport, {workspaceId: WORKSPACE, currentUserId: USER})

    const wcs = plan.pages.find(p => p.roamUid === 'page1uid')
    expect(wcs).toBeDefined()
    expect(wcs?.isDaily).toBe(false)
    expect(wcs?.data).toBeDefined()
    expect(wcs?.data?.content).toBe('wcs/plan')
    expect(wcs?.data?.properties.alias?.value).toEqual(['wcs/plan'])
    expect(wcs?.data?.properties.type?.value).toBe('page')
    expect(wcs?.childIds).toEqual([roamBlockId(WORKSPACE, 'parentuid')])
    expect(wcs?.data?.parentId).toBeUndefined()
  })

  it('emits descendants in post-order: leaves before parents', () => {
    const plan = planImport(minimalExport, {workspaceId: WORKSPACE, currentUserId: USER})

    const order = plan.descendants.map(d => d.roamUid)
    expect(order).toEqual(['child1uid', 'parentuid', 'dailychild'])
  })

  it('rewrites block refs and #tags in content', () => {
    const plan = planImport(minimalExport, {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentuid')
    expect(parent?.data.content).toBe(
      `top with ((${roamBlockId(WORKSPACE, 'child1uid')}))`,
    )

    const leaf = plan.descendants.find(d => d.roamUid === 'child1uid')
    expect(leaf?.data.content).toBe('## [[tag]] and **bold**')
  })

  it('pre-populates references[] from :block/refs when target was imported', () => {
    const plan = planImport(minimalExport, {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentuid')
    expect(parent?.data.references).toEqual([
      {
        id: roamBlockId(WORKSPACE, 'child1uid'),
        alias: roamBlockId(WORKSPACE, 'child1uid'),
      },
    ])
  })

  it('records unresolved block uids', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: '((unknownUid))',
        uid: 'b',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect([...plan.unresolvedBlockUids]).toEqual(['unknownUid'])
    expect(plan.diagnostics.some(d => d.includes('unknownUid') || d.includes('1'))).toBe(true)
  })

  it('records aliases referenced from content', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'see [[Some Page]] and [[Another]]',
        uid: 'b',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.aliasesUsed.has('Some Page')).toBe(true)
    expect(plan.aliasesUsed.has('Another')).toBe(true)
  })

  it('promotes Roam attributes (props/:block/props) to namespaced properties', () => {
    // Cast through RoamExport — `:readwise-highlight-id` is a free-form
    // Roam attribute key not declared on the typed RoamBlock interface.
    const sample = [{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'highlight',
        uid: 'b',
        ':readwise-highlight-id': 1009146325,
        'readwise-highlight-id': 1009146325,
        ':block/props': {':readwise-highlight-id': 1009146325},
      }],
    }] as unknown as RoamExport
    const plan = planImport(sample, {workspaceId: WORKSPACE, currentUserId: USER})

    const block = plan.descendants[0]
    const prop = block.data.properties['roam:readwise-highlight-id']
    expect(prop).toBeDefined()
    expect(prop?.type).toBe('number')
    expect(prop?.value).toBe(1009146325)
  })
})
