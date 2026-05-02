import { describe, expect, it } from 'vitest'
import { planImport } from '../plan'
import { roamBlockId } from '../ids'
import { dailyNoteBlockId } from '@/data/dailyNotes'
import { aliasesProp, typeProp } from '@/data/properties'
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
    expect(wcs?.data?.content).toBe('wcs/plan')
    // Flat property shape: encoded value stored directly.
    expect(wcs?.data?.properties[aliasesProp.name])
      .toEqual(aliasesProp.codec.encode(['wcs/plan']))
    expect(wcs?.data?.properties[typeProp.name])
      .toBe(typeProp.codec.encode('page'))
    expect(wcs?.childIds).toEqual([roamBlockId(WORKSPACE, 'parentuid')])
    expect(wcs?.data?.parentId).toBeNull()
  })

  it('emits descendants in post-order: leaves before parents', () => {
    const plan = planImport(minimalExport, {workspaceId: WORKSPACE, currentUserId: USER})

    const order = plan.descendants.map(d => d.roamUid)
    expect(order).toEqual(['child1uid', 'parentuid', 'dailychild'])
  })

  it('treats pages with implausible :log/id years as non-daily', () => {
    // Real-bug repro: a Roam page with a :log/id that decodes to a
    // 5-digit year (e.g. from a typo'd daily title that Roam still
    // tagged with a synthetic log id) used to crash the import. The
    // page should fall through to the regular non-daily branch.
    // 5.75e14 ms ≈ year 20201.
    const result = planImport([{
      title: 'April 1st, 20201',
      uid: 'odd-uid',
      ':log/id': 5.75e14,
      'create-time': 1700000000000,
      children: [],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const page = result.pages[0]
    expect(page.isDaily).toBe(false)
    expect(page.data).toBeDefined()
  })

  it('treats pages whose title parses to a 5-digit year as non-daily', () => {
    // chrono will accept "April 1st, 20201" — we reject in
    // parseRelativeDate so the page imports as a regular page
    // instead of crashing the daily-note path.
    const result = planImport([{
      title: 'April 1st, 20201',
      uid: 'plain-uid',
      'create-time': 1700000000000,
      children: [],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(result.pages[0].isDaily).toBe(false)
    expect(result.pages[0].data).toBeDefined()
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

  it('registers placeholders for `((uid))` refs to blocks not in the export', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: '((unknownUid))',
        uid: 'b',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.placeholders).toEqual([
      {roamUid: 'unknownUid', blockId: roamBlockId(WORKSPACE, 'unknownUid')},
    ])
    // Content rewrites against the placeholder's deterministic id so a
    // later import that includes the real block upserts onto the same row.
    const block = plan.descendants.find(d => d.roamUid === 'b')
    expect(block?.data.content).toBe(
      `((${roamBlockId(WORKSPACE, 'unknownUid')}))`,
    )
    expect(plan.diagnostics.some(d => d.includes('placeholder'))).toBe(true)
  })

  it('does not register placeholders for refs whose target IS in the export', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [
        {string: 'parent with ((leaf))', uid: 'b1'},
        {string: 'leaf', uid: 'leaf'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.placeholders).toEqual([])
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

  it('hoists simple inline `key::value` children onto the parent and drops them', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [
        {string: 'URL::https://example.com/foo', uid: 'b1'},
        {string: 'author:: [[@stvad:matrix.org]]', uid: 'b2'},
        {string: 'plain bullet, no attr', uid: 'b3'},
        // Multi-line: not a simple attr — pass through.
        {string: 'URL::https://example.com\nfollowed by extra notes', uid: 'b4'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    // Standalone attr blocks are dropped — the property lives on the parent.
    expect(byUid('b1')).toBeUndefined()
    expect(byUid('b2')).toBeUndefined()
    // Non-attr / multi-line blocks survive.
    expect(byUid('b3')?.content).toBe('plain bullet, no attr')
    expect(byUid('b4')?.content).toBe('URL::https://example.com\nfollowed by extra notes')
    // The page (parent) carries the hoisted attributes.
    const page = plan.pages.find(p => p.roamUid === 'pUid')
    expect(page?.data?.properties['roam:URL']).toBe('https://example.com/foo')
    expect(page?.data?.properties['roam:author']).toBe('[[@stvad:matrix.org]]')
    expect(page?.promotedFromChildren).toEqual({
      'roam:URL': 'https://example.com/foo',
      'roam:author': '[[@stvad:matrix.org]]',
    })
    // childIds skip the dropped attr blocks.
    expect(page?.childIds).toEqual([
      roamBlockId(WORKSPACE, 'b3'),
      roamBlockId(WORKSPACE, 'b4'),
    ])
  })

  it('keeps `key::` blocks with non-attr children and lifts the bullets as a list value (case 4)', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent block',
        uid: 'parentUid',
        children: [{
          string: 'highlights::',
          uid: 'attrUid',
          children: [
            {string: 'first highlight', uid: 'h1'},
            {string: 'second highlight', uid: 'h2'},
          ],
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    // The attr block stays — its subtree would otherwise be unreachable.
    const attr = byUid('attrUid')
    expect(attr).toBeDefined()
    expect(attr?.content).toBe('highlights::')
    // It does NOT carry the property itself — the property is on the parent.
    expect(attr?.properties['roam:highlights']).toBeUndefined()
    // The parent block gets a LIST property with the two bullets as values.
    // Empty inline value (`highlights::`) is filtered out so it doesn't add
    // a stray "" entry to the list.
    expect(byUid('parentUid')?.properties['roam:highlights']).toEqual([
      'first highlight',
      'second highlight',
    ])
    // Highlights survive too, parented under the attr block.
    expect(byUid('h1')?.parentId).toBe(roamBlockId(WORKSPACE, 'attrUid'))
    expect(byUid('h2')?.parentId).toBe(roamBlockId(WORKSPACE, 'attrUid'))
  })

  it('handles blocks with no `string` field (empty bullets in real exports)', () => {
    const sample = [{
      title: 'p',
      uid: 'pUid',
      children: [
        // No `string` at all — empty Roam bullet.
        {uid: 'empty1'},
        // Empty children array, also no string.
        {uid: 'empty2', children: []},
        // Sibling with content — must still import normally.
        {string: 'has content', uid: 'b3'},
      ],
    }] as unknown as RoamExport
    const plan = planImport(sample, {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    expect(byUid('empty1')?.content).toBe('')
    expect(byUid('empty2')?.content).toBe('')
    expect(byUid('b3')?.content).toBe('has content')
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
    // Flat property shape: number values land directly as numbers.
    expect(block.data.properties['roam:readwise-highlight-id']).toBe(1009146325)
  })

  // ──── Property-promotion cases ────

  it('case 1: hoists sub-attribute children of an attr block to the grandparent', () => {
    // The URL block has only attribute children — author and timestamp
    // describe the URL. Per the user-stated rule, all three values
    // (URL, author, timestamp) collapse onto the parent and the URL
    // block itself is dropped because it has no surviving children.
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent bullet',
        uid: 'parentUid',
        children: [{
          string: 'URL::https://matrix.to/example',
          uid: 'urlUid',
          children: [
            {string: 'author::[[stvad]]', uid: 'authorUid'},
            {string: 'timestamp::5/1/2026, 2:44:23 AM PDT', uid: 'tsUid'},
          ],
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    const parent = byUid('parentUid')
    expect(parent?.properties['roam:URL']).toBe('https://matrix.to/example')
    expect(parent?.properties['roam:author']).toBe('[[stvad]]')
    expect(parent?.properties['roam:timestamp']).toBe('5/1/2026, 2:44:23 AM PDT')
    // URL block and its attribute children all drop out of the tree.
    expect(byUid('urlUid')).toBeUndefined()
    expect(byUid('authorUid')).toBeUndefined()
    expect(byUid('tsUid')).toBeUndefined()
    // Page-value `[[stvad]]` makes its way into aliasesUsed so the
    // alias seat for `stvad` gets created at import time.
    expect(plan.aliasesUsed.has('stvad')).toBe(true)
  })

  it('case 1 mixed: keeps an attr block when it has non-attr children but still bubbles its sub-attrs', () => {
    // URL has one attribute child (author) and one plain bullet. Per
    // the user-stated rule, author bubbles to the grandparent; the
    // URL block survives carrying just its non-attr child.
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{
          string: 'URL::https://example.com',
          uid: 'urlUid',
          children: [
            {string: 'author::stvad', uid: 'authorUid'},
            {string: 'plain note', uid: 'noteUid'},
          ],
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    const parent = byUid('parentUid')
    // URL gets a list because the plain note also contributes (case 4
    // behaviour applies to mixed children).
    expect(parent?.properties['roam:URL']).toEqual(['https://example.com', 'plain note'])
    expect(parent?.properties['roam:author']).toBe('stvad')
    // URL block kept; its children list is reduced to just the plain note.
    const urlBlock = byUid('urlUid')
    expect(urlBlock).toBeDefined()
    expect(byUid('authorUid')).toBeUndefined()
    expect(byUid('noteUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'urlUid'))
  })

  it('case 1 deep nesting logs a diagnostic but still bubbles', () => {
    // Three levels of attribute nesting. The third level still
    // bubbles all the way up to the grandparent so no data is lost,
    // but a diagnostic flags the unusual depth for the post-import log.
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{
          string: 'URL::v',
          uid: 'urlUid',
          children: [{
            string: 'author::stvad',
            uid: 'authorUid',
            children: [{string: 'since::2020', uid: 'sinceUid'}],
          }],
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    const parent = byUid('parentUid')
    expect(parent?.properties['roam:URL']).toBe('v')
    expect(parent?.properties['roam:author']).toBe('stvad')
    expect(parent?.properties['roam:since']).toBe('2020')
    expect(plan.diagnostics.some(d => d.includes('since') && d.includes('depth'))).toBe(true)
  })

  it('case 2: merges same-key sibling attrs into a list', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [
          {string: 'URL::https://read.readwise.io/x', uid: 'u1'},
          {string: 'URL::https://www.lesswrong.com/x', uid: 'u2'},
          {string: 'URL::https://matrix.to/x', uid: 'u3'},
        ],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    expect(byUid('parentUid')?.properties['roam:URL']).toEqual([
      'https://read.readwise.io/x',
      'https://www.lesswrong.com/x',
      'https://matrix.to/x',
    ])
    // All three standalone attr blocks dropped.
    expect(byUid('u1')).toBeUndefined()
    expect(byUid('u2')).toBeUndefined()
    expect(byUid('u3')).toBeUndefined()
  })

  it('case 3: explodes a `[[X]] [[Y]]` scalar value into a list of bracketed pages', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [
          {string: 'isa::[[person]] [[friend]]', uid: 'i1'},
          // Allowed separators: whitespace, comma, semicolon. The
          // scalar still explodes into a clean two-token list.
          {string: 'tags::[[a]], [[b]]; [[c]]', uid: 'i2'},
          // Single token → stays scalar (no spurious length-1 list).
          {string: 'kind::[[doc]]', uid: 'i3'},
          // Mixed (page tokens + free text) is NOT a page list — keep
          // the original scalar string so we don't silently drop the
          // free-text fragment.
          {string: 'mixed::[[X]] some text [[Y]]', uid: 'i4'},
        ],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const props = plan.descendants.find(d => d.roamUid === 'parentUid')?.data.properties
    expect(props?.['roam:isa']).toEqual(['[[person]]', '[[friend]]'])
    expect(props?.['roam:tags']).toEqual(['[[a]]', '[[b]]', '[[c]]'])
    expect(props?.['roam:kind']).toBe('[[doc]]')
    expect(props?.['roam:mixed']).toBe('[[X]] some text [[Y]]')
    // Aliases registered for downstream seat creation.
    expect(plan.aliasesUsed.has('person')).toBe(true)
    expect(plan.aliasesUsed.has('friend')).toBe(true)
    expect(plan.aliasesUsed.has('a')).toBe(true)
    expect(plan.aliasesUsed.has('doc')).toBe(true)
  })

  it('case 4: empty `key::` with bullet children promotes the bullets as a list', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{
          string: 'email::',
          uid: 'emailUid',
          children: [
            {string: '[gliderok@gmail.com](mailto:gliderok@gmail.com)', uid: 'e1'},
            {string: '[aix123@yandex.ru](mailto:aix123@yandex.ru)', uid: 'e2'},
          ],
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    expect(byUid('parentUid')?.properties['roam:email']).toEqual([
      '[gliderok@gmail.com](mailto:gliderok@gmail.com)',
      '[aix123@yandex.ru](mailto:aix123@yandex.ru)',
    ])
    // Block tree preserved: email:: kept, both children parented under it.
    expect(byUid('emailUid')?.content).toBe('email::')
    expect(byUid('e1')?.parentId).toBe(roamBlockId(WORKSPACE, 'emailUid'))
    expect(byUid('e2')?.parentId).toBe(roamBlockId(WORKSPACE, 'emailUid'))
  })

  it('case 4 with attr children: treats children as case-1 sub-attrs (not as list values)', () => {
    // `email::` has TWO attribute children (work, home). Per case 4
    // sub-rule "treat as case 1 if children are themselves attrs" —
    // we hoist work/home to the grandparent and do NOT create an
    // email property at all (the inline value was empty too).
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{
          string: 'email::',
          uid: 'emailUid',
          children: [
            {string: 'work::a@b.com', uid: 'w'},
            {string: 'home::c@d.com', uid: 'h'},
          ],
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    const parent = byUid('parentUid')
    expect(parent?.properties['roam:work']).toBe('a@b.com')
    expect(parent?.properties['roam:home']).toBe('c@d.com')
    expect(parent?.properties['roam:email']).toBeUndefined()
    // The whole subtree drops out — no remaining children to keep.
    expect(byUid('emailUid')).toBeUndefined()
    expect(byUid('w')).toBeUndefined()
    expect(byUid('h')).toBeUndefined()
  })

  it('combines case 2 + case 4: same-key inline siblings merge with children-list values', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [
          {string: 'email::primary@x.com', uid: 'p1'},
          {
            string: 'email::',
            uid: 'p2',
            children: [
              {string: 'secondary@x.com', uid: 's1'},
              {string: 'tertiary@x.com', uid: 's2'},
            ],
          },
        ],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)?.data
    expect(byUid('parentUid')?.properties['roam:email']).toEqual([
      'primary@x.com',
      'secondary@x.com',
      'tertiary@x.com',
    ])
  })
})
