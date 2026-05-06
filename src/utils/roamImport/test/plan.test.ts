import { describe, expect, it } from 'vitest'
import {
  computePromotedFromChildren,
  extractRoamTodoMarker,
  extractSrsScheduleMarker,
  parseRoamImportReferences,
  planImport,
} from '../plan'
import { roamBlockId } from '../ids'
import { dailyNoteBlockId } from '@/data/dailyNotes'
import { aliasesProp, typesProp } from '@/data/properties'
import { PAGE_TYPE } from '@/data/blockTypes'
import {
  srsArchivedProp,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '@/plugins/srs-rescheduling/schema'
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
    expect(wcs?.data?.properties[typesProp.name])
      .toEqual(typesProp.codec.encode([PAGE_TYPE]))
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

  it('extracts Roam TODO markers even when they are embedded later in the node', () => {
    const todo = extractRoamTodoMarker('initial review date::[[April 27th, 2026]] {{[[DONE]]}}')

    expect(todo.content).toBe('initial review date::[[April 27th, 2026]]')
    expect(todo.todoState).toBe('DONE')
  })

  it('derives roam:author from `[[doc]] by [[Author]]` entries', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: '[[doc/Takes from two months as an aspiring LLM naturalist]] by [[AnnaSalamon]]',
        uid: 'entryUid',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const entry = plan.descendants.find(d => d.roamUid === 'entryUid')?.data
    expect(entry?.properties['roam:author']).toBe('[[AnnaSalamon]]')
    expect(plan.aliasesUsed.has('AnnaSalamon')).toBe(true)
  })

  it('does not treat later refs in generic `by` prose as authors', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: '[[Interactive essay]] by [[Peter Norvig]] on #economics using [[Jupyter notebook]]',
        uid: 'entryUid',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const entry = plan.descendants.find(d => d.roamUid === 'entryUid')?.data
    expect(entry?.properties['roam:author']).toBeUndefined()
  })

  it('derives author and URL props from old all-in-one Readwise url/via entries', () => {
    const readwiseUrl = 'https://read.readwise.io/read/01hgeg920ybrh1104p2vq6099n'
    const viaUrl = 'https://www.lesswrong.com/s/JdAfXBx4gS3DjN5s6/p/9QxnfMYccz9QRgZ5z'
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string:
          `[[The Costly Coordination Mechanism of Common Knowledge]] by Ben Pace\n` +
          ` url: ${readwiseUrl}\nvia ${viaUrl}\n\nsummary [[to/read]]`,
        uid: 'entryUid',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const entry = plan.descendants.find(d => d.roamUid === 'entryUid')?.data
    expect(entry?.properties['roam:author']).toBe('[[Ben Pace]]')
    expect(entry?.properties['roam:URL']).toEqual([readwiseUrl, viaUrl])
    expect(plan.aliasesUsed.has('Ben Pace')).toBe(true)
  })

  it('normalizes old markdown Readwise links to doc wikilinks and saves the link URLs', () => {
    const readwiseUrl = 'https://read.readwise.io/read/01h7wy938mgf88cnk2q7q5fvyn'
    const viaUrl = 'https://www.lesswrong.com/posts/pZrvkZzL2JnbRgEBC/feedbackloop-first-rationality'
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string:
          `{{[[DONE]]}} [Feedbackloop-first Rationality](${readwiseUrl}) by Raemon\n` +
          `via ${viaUrl}\n\nsummary [[to/read]]`,
        uid: 'entryUid',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const entry = plan.descendants.find(d => d.roamUid === 'entryUid')
    expect(entry?.data.content.startsWith('[[doc/Feedbackloop-first Rationality]] by Raemon'))
      .toBe(true)
    expect(entry?.data.properties['roam:author']).toBe('[[Raemon]]')
    expect(entry?.data.properties['roam:URL']).toEqual([readwiseUrl, viaUrl])
    expect(entry?.todoState).toBe('DONE')
    expect(plan.aliasesUsed.has('doc/Feedbackloop-first Rationality')).toBe(true)
    expect(plan.aliasesUsed.has('Raemon')).toBe(true)
  })

  it('keeps wiki-label markdown Readwise links as wikilinks while saving URL props', () => {
    const readwiseUrl = 'https://read.readwise.io/read/01hbabc'
    const viaUrl = 'https://example.com/post'
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: `[[Designing a Better Judging System]](${readwiseUrl}) by Anish Athalye via ${viaUrl}`,
        uid: 'entryUid',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const entry = plan.descendants.find(d => d.roamUid === 'entryUid')?.data
    expect(entry?.content).toBe(
      `[[Designing a Better Judging System]](${readwiseUrl}) by Anish Athalye via ${viaUrl}`,
    )
    expect(entry?.properties['roam:author']).toBe('[[Anish Athalye]]')
    expect(entry?.properties['roam:URL']).toEqual([readwiseUrl, viaUrl])
  })

  it('reports ambiguous exact Readwise author candidates', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [
        {
          string: '[[doc/Episode 17: Exploring the Intersection of Dance & Therapy]] by [[Infuse Compassion]] [[Brandi Guild]]',
          uid: 'multiAuthorUid',
        },
        {
          string: '[[doc/Chapter 3: Standard | A Practical Guide to Evil]] by [[]]',
          uid: 'blankAuthorUid',
        },
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.descendants.find(d => d.roamUid === 'multiAuthorUid')?.data.properties['roam:author'])
      .toBeUndefined()
    expect(plan.descendants.find(d => d.roamUid === 'blankAuthorUid')?.data.properties['roam:author'])
      .toBeUndefined()
    expect(plan.diagnostics.some(d =>
      d.includes('multiAuthorUid') &&
      d.includes('2 exact author refs'),
    )).toBe(true)
    expect(plan.diagnostics.some(d =>
      d.includes('blankAuthorUid') &&
      d.includes('blank [[]] author'),
    )).toBe(true)
  })

  it('extracts SRS SM-2.5 child metadata onto the parent block', () => {
    const marker = '[[[[interval]]:31.1]] [[[[factor]]:2.50]] [[June 6th, 2026]] * * *'
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{string: marker, uid: 'srsUid'}],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentUid')
    const expectedDateId = dailyNoteBlockId(WORKSPACE, '2026-06-06')
    expect(parent?.srsSchedule).toEqual({
      interval: 31.1,
      factor: 2.5,
      nextReviewDateAlias: 'June 6th, 2026',
      nextReviewDateId: expectedDateId,
      reviewCount: 3,
    })
    expect(parent?.data.properties[srsIntervalProp.name]).toBe(31.1)
    expect(parent?.data.properties[srsFactorProp.name]).toBe(2.5)
    expect(parent?.data.properties[srsNextReviewDateProp.name]).toBe(expectedDateId)
    expect(parent?.data.properties[srsReviewCountProp.name]).toBe(3)
    expect(parent?.data.references).toContainEqual({
      id: expectedDateId,
      alias: 'June 6th, 2026',
      sourceField: srsNextReviewDateProp.name,
    })
    expect(plan.aliasesUsed.has('June 6th, 2026')).toBe(true)

    const markerBlock = plan.descendants.find(d => d.roamUid === 'srsUid')?.data
    expect(markerBlock?.content).toBe(marker)
  })

  it('extracts no-star SRS marker metadata with review count zero', () => {
    const marker = '[[[[interval]]:31.1]] [[[[factor]]:2.50]] [[June 6th, 2026]]'
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{string: marker, uid: 'srsUid'}],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentUid')
    expect(parent?.srsSchedule?.reviewCount).toBe(0)
    expect(parent?.data.properties[srsReviewCountProp.name]).toBe(0)
  })

  it('applies embedded SRS metadata to the block that contains substantial content', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{
          string: 'check in on [[Alice]] [[[[interval]]:5]] [[[[factor]]:2.00]] [[June 6th, 2026]]',
          uid: 'taskUid',
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentUid')
    const task = plan.descendants.find(d => d.roamUid === 'taskUid')
    const expectedDateId = dailyNoteBlockId(WORKSPACE, '2026-06-06')

    expect(parent?.srsSchedule).toBeUndefined()
    expect(parent?.data.properties[srsIntervalProp.name]).toBeUndefined()
    expect(task?.srsSchedule).toMatchObject({
      interval: 5,
      factor: 2,
      nextReviewDateId: expectedDateId,
      reviewCount: 0,
    })
    expect(task?.data.properties[srsIntervalProp.name]).toBe(5)
    expect(task?.data.references).toContainEqual({
      id: expectedDateId,
      alias: 'June 6th, 2026',
      sourceField: srsNextReviewDateProp.name,
    })
  })

  it('still promotes marker children that only add refs or tags around SRS metadata', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{
          string: '[[[[interval]]:5]] [[[[factor]]:2.00]] [[June 6th, 2026]] [[health]] #w *',
          uid: 'markerUid',
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentUid')
    const marker = plan.descendants.find(d => d.roamUid === 'markerUid')
    expect(parent?.srsSchedule?.interval).toBe(5)
    expect(marker?.srsSchedule).toBeUndefined()
  })

  it('still promotes marker children that only add hash-page tags around SRS metadata', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [{
          string: '[[[[interval]]:5]] [[[[factor]]:2.00]] [[June 6th, 2026]] #[[programming]] *',
          uid: 'markerUid',
        }],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentUid')
    const marker = plan.descendants.find(d => d.roamUid === 'markerUid')
    expect(parent?.srsSchedule?.interval).toBe(5)
    expect(marker?.srsSchedule).toBeUndefined()
  })

  it('reports SRS-looking markers whose daily review date cannot be parsed', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: '[[[[interval]]:615.9]] [[[[factor]]:1.60]] [[January 29th, 202 6]] *',
        uid: 'badSrsUid',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.diagnostics.some(d =>
      d.includes('badSrsUid') &&
      d.includes('no parseable daily review date'),
    )).toBe(true)
  })

  it('reports multiple marker-only SRS children under one parent', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [
          {string: '[[[[interval]]:5]] [[[[factor]]:2.00]] [[June 6th, 2026]]', uid: 'firstMarker'},
          {string: '[[[[interval]]:7]] [[[[factor]]:2.10]] [[June 8th, 2026]]', uid: 'secondMarker'},
        ],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const parent = plan.descendants.find(d => d.roamUid === 'parentUid')
    expect(parent?.srsSchedule?.interval).toBe(5)
    expect(plan.diagnostics.some(d =>
      d.includes('Multiple marker-only Roam SRS children') &&
      d.includes('parentUid'),
    )).toBe(true)
  })

  it('treats Roam inline property wrappers as page references', () => {
    const marker = '[[[[interval]]:31.1]] [[[[factor]]:2.50]] [[June 6th, 2026]] * * *'

    expect(parseRoamImportReferences(marker).map(ref => ref.alias))
      .toEqual([
        '[[interval]]:31.1',
        'interval',
        '[[factor]]:2.50',
        'factor',
        'June 6th, 2026',
      ])
    expect(extractSrsScheduleMarker(marker, WORKSPACE)?.reviewCount).toBe(3)
  })

  it('does not parse page refs inside code spans or fences as import aliases', () => {
    expect(parseRoamImportReferences(
      '`[[Nope]]` ```clojure\n[[Also Nope]]\n``` [[Yes]]',
    ).map(ref => ref.alias)).toEqual(['Yes'])
  })

  it('imports roam/memo snapshots onto referenced SRS blocks', () => {
    const plan = planImport([
      {
        title: 'cards',
        uid: 'cardsPage',
        children: [{string: 'Question #memo', uid: 'targetUid'}],
      },
      {
        title: 'roam/memo',
        uid: 'memoPage',
        children: [{
          string: 'data',
          uid: 'memoData',
          children: [{
            string: '((targetUid))',
            uid: 'memoEntry',
            children: [
              {
                string: '[[May 5th, 2026]] 🔵',
                uid: 'newerSession',
                children: [
                  {string: 'reviewMode:: SPACED_INTERVAL', uid: 'newerMode'},
                  {string: 'nextDueDate:: [[May 10th, 2026]]', uid: 'newerDue'},
                  {string: 'repetitions:: 2', uid: 'newerReps'},
                  {string: 'interval:: 5', uid: 'newerInterval'},
                  {string: 'eFactor:: 2.2', uid: 'newerFactor'},
                  {string: 'grade:: 4', uid: 'newerGrade'},
                ],
              },
              {
                string: '[[May 1st, 2026]] 🟢',
                uid: 'olderSession',
                children: [
                  {string: 'reviewMode:: SPACED_INTERVAL', uid: 'olderMode'},
                  {string: 'nextDueDate:: [[May 5th, 2026]]', uid: 'olderDue'},
                  {string: 'repetitions:: 1', uid: 'olderReps'},
                  {string: 'interval:: 4', uid: 'olderInterval'},
                  {string: 'eFactor:: 2.3', uid: 'olderFactor'},
                  {string: 'grade:: 5', uid: 'olderGrade'},
                ],
              },
              {string: '[[memo/archived]]', uid: 'archivedTag'},
              {string: '[[memo/to-review]]', uid: 'toReviewTag'},
            ],
          }],
        }],
      },
    ], {workspaceId: WORKSPACE, currentUserId: USER})

    const target = plan.descendants.find(d => d.roamUid === 'targetUid')
    const props = target?.data.properties
    const may1 = dailyNoteBlockId(WORKSPACE, '2026-05-01')
    const may5 = dailyNoteBlockId(WORKSPACE, '2026-05-05')
    const may10 = dailyNoteBlockId(WORKSPACE, '2026-05-10')

    expect(props?.[srsIntervalProp.name]).toBe(5)
    expect(props?.[srsFactorProp.name]).toBe(2.2)
    expect(props?.[srsNextReviewDateProp.name]).toBe(may10)
    expect(props?.[srsReviewCountProp.name]).toBe(2)
    expect(props?.[srsGradeProp.name]).toBe(4)
    expect(props?.[srsArchivedProp.name]).toBe(true)
    expect(props?.[srsSnapshotHistoryProp.name]).toEqual([
      {reviewedAt: may1, grade: 5, interval: 4, factor: 2.3, reviewCount: 1},
      {reviewedAt: may5, grade: 4, interval: 5, factor: 2.2, reviewCount: 2},
    ])
    expect(props?.['roam:memo/to-review']).toBeUndefined()
    expect(target?.data.references).toContainEqual({
      id: may10,
      alias: 'May 10th, 2026',
      sourceField: srsNextReviewDateProp.name,
    })
    expect(plan.roamMemo).toMatchObject({
      entries: 1,
      matchedTargets: 1,
      archivedTargets: 1,
      toReviewRefs: 1,
      snapshots: 2,
      targetsWithHistory: 1,
    })
  })

  it('hoists simple inline `key::value` children onto the parent while keeping the source blocks', () => {
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
    // Every source block survives; promotion is purely additive on the
    // parent's properties bag.
    expect(byUid('b1')?.content).toBe('URL::https://example.com/foo')
    expect(byUid('b2')?.content).toBe('author:: [[@stvad:matrix.org]]')
    expect(byUid('b3')?.content).toBe('plain bullet, no attr')
    expect(byUid('b4')?.content).toBe('URL::https://example.com\nfollowed by extra notes')
    // The page (parent) still carries the hoisted attributes — the
    // tree-preservation change doesn't affect the property values.
    const page = plan.pages.find(p => p.roamUid === 'pUid')
    expect(page?.data?.properties['roam:URL']).toBe('https://example.com/foo')
    expect(page?.data?.properties['roam:author']).toBe('[[@stvad:matrix.org]]')
    expect(page?.promotedFromChildren).toEqual({
      'roam:URL': 'https://example.com/foo',
      'roam:author': '[[@stvad:matrix.org]]',
    })
    // childIds includes every direct child of the page (no skips now).
    expect(page?.childIds).toEqual([
      roamBlockId(WORKSPACE, 'b1'),
      roamBlockId(WORKSPACE, 'b2'),
      roamBlockId(WORKSPACE, 'b3'),
      roamBlockId(WORKSPACE, 'b4'),
    ])
  })

  it('unwraps scalar markdown-link property values while preserving the source property block', () => {
    const url = 'https://read.readwise.io/read/01kq8b3ps566yg1m55r6qytjwx'
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [
        {string: `source:: [View Highlight](${url})`, uid: 'sourceUid'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const page = plan.pages.find(p => p.roamUid === 'pUid')
    const source = plan.descendants.find(d => d.roamUid === 'sourceUid')?.data
    expect(page?.data?.properties['roam:source']).toBe(url)
    expect(source?.content).toBe(`source:: [View Highlight](${url})`)
  })

  it('strips SRS metadata from promoted property values while keeping SRS on the source block', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'initial review date::[[November 3rd, 2025]] [[[[interval]]:5.1]] [[[[factor]]:2.50]] *',
        uid: 'reviewUid',
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const page = plan.pages.find(p => p.roamUid === 'pUid')
    const review = plan.descendants.find(d => d.roamUid === 'reviewUid')
    expect(page?.data?.properties['roam:initial review date']).toBe('[[November 3rd, 2025]]')
    expect(review?.srsSchedule).toMatchObject({
      interval: 5.1,
      factor: 2.5,
      nextReviewDateAlias: 'November 3rd, 2025',
      reviewCount: 1,
    })
  })

  it('preserves embed-path source metadata while importing it as a block embed', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [
        {string: '{{[[embed-path]]: ((targetUid))}}', uid: 'embedPathUid'},
        {string: 'target', uid: 'targetUid'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const embedPath = plan.descendants.find(d => d.roamUid === 'embedPathUid')?.data
    const targetId = roamBlockId(WORKSPACE, 'targetUid')
    expect(embedPath?.content).toBe(`!((${targetId}))`)
    expect(embedPath?.properties['roam:embed-path']).toBe(targetId)
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

  it('preserves Roam view types as namespaced properties', () => {
    const sample = [{
      title: 'p',
      uid: 'pUid',
      ':children/view-type': ':document',
      children: [{
        string: 'numbered parent',
        uid: 'b',
        ':children/view-type': ':numbered',
      }],
    }] satisfies RoamExport
    const plan = planImport(sample, {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.pages[0].data?.properties['roam:children/view-type']).toBe(':document')
    expect(plan.descendants[0].data.properties['roam:children/view-type']).toBe(':numbered')
  })

  it('reports non-standard page_alias values without using them for alias merging', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [
        {string: 'page_alias::LukeProg', uid: 'aliasUid'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.pages[0].pageAliases).toEqual([])
    expect(plan.diagnostics.some(d =>
      d.includes('Non-standard page_alias') &&
      d.includes('LukeProg'),
    )).toBe(true)
  })

  it('handles nested page refs in page_alias values without creating partial aliases', () => {
    const plan = planImport([{
      title: 'EVOC',
      uid: 'pUid',
      children: [
        {string: 'page_alias:: [[defensive [[driving]]]]', uid: 'aliasUid'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.pages[0].pageAliases).toEqual(['defensive [[driving]]'])
    expect(plan.aliasesUsed.has('defensive [[driving]]')).toBe(true)
    expect(plan.aliasesUsed.has('defensive [[driving')).toBe(false)
  })

  it('reports page title and Roam command weirdness summaries', () => {
    const plan = planImport([{
      title: ' odd\npage ',
      uid: 'pUid',
      children: [
        {string: '{{[[query]]: {and: [[TODO]]}}}', uid: 'queryUid'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.diagnostics.some(d =>
      d.includes('Roam page title weirdness') &&
      d.includes('leading/trailing whitespace') &&
      d.includes('newlines'),
    )).toBe(true)
    expect(plan.diagnostics.some(d =>
      d.includes('Roam command follow-up') &&
      d.includes('query 1'),
    )).toBe(true)
  })

  it('reports unknown Roam commands while ignoring code blocks', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [
        {string: '{{word-count}} and `{{ignored-code-command}}`', uid: 'commandUid'},
      ],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    expect(plan.diagnostics.some(d =>
      d.includes('Unknown Roam command follow-up') &&
      d.includes('word-count 1') &&
      !d.includes('ignored-code-command'),
    )).toBe(true)
  })

  // ──── Property-promotion cases ────

  it('case 1: hoists sub-attribute children of an attr block to the grandparent and keeps the source blocks', () => {
    // URL has only attribute children — author and timestamp describe
    // the URL. All three values land on the parent's property bag.
    // Every source block survives in the tree so backlinks (e.g. the
    // `[[stvad]]` token in the author block's content) keep working
    // through the block's own references[] entry.
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
    // Source blocks all survive with their original content + parenting.
    expect(byUid('urlUid')?.content).toBe('URL::https://matrix.to/example')
    expect(byUid('urlUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'parentUid'))
    expect(byUid('authorUid')?.content).toBe('author::[[stvad]]')
    expect(byUid('authorUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'urlUid'))
    expect(byUid('tsUid')?.content).toBe('timestamp::5/1/2026, 2:44:23 AM PDT')
    expect(byUid('tsUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'urlUid'))
    // bubbledUids prevents intermediate blocks from re-bubbling — the
    // URL block doesn't claim author/timestamp as its own properties.
    expect(byUid('urlUid')?.properties['roam:author']).toBeUndefined()
    expect(byUid('urlUid')?.properties['roam:timestamp']).toBeUndefined()
    // `[[stvad]]` reaches aliasesUsed (the author block's content scan
    // catches it) so the alias seat is materialised at import time.
    expect(plan.aliasesUsed.has('stvad')).toBe(true)
  })

  it('case 1 mixed: bubbles sub-attrs to the grandparent while the source blocks (and the plain note) stay in place', () => {
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
    // URL gets a list because the plain note also contributes via case-4.
    expect(parent?.properties['roam:URL']).toEqual(['https://example.com', 'plain note'])
    expect(parent?.properties['roam:author']).toBe('stvad')
    // Every source block survives, including author (no longer dropped).
    expect(byUid('urlUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'parentUid'))
    expect(byUid('authorUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'urlUid'))
    expect(byUid('noteUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'urlUid'))
    // The URL block doesn't redo its own promotion either.
    expect(byUid('urlUid')?.properties['roam:author']).toBeUndefined()
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
    // All three source blocks survive as descendants of the parent.
    expect(byUid('u1')?.content).toBe('URL::https://read.readwise.io/x')
    expect(byUid('u2')?.content).toBe('URL::https://www.lesswrong.com/x')
    expect(byUid('u3')?.content).toBe('URL::https://matrix.to/x')
    expect(byUid('u1')?.parentId).toBe(roamBlockId(WORKSPACE, 'parentUid'))
  })

  it('promotes attributes with a custom namespace and key transform', () => {
    const promotion = computePromotedFromChildren([
      {string: 'URL::https://matrix.to/x', uid: 'u1'},
      {string: 'author::[[stvad]]', uid: 'u2'},
    ], new Set(), {
      namespacePrefix: 'matrix',
      transformKey: key => key.toLowerCase(),
    })

    expect(promotion.promoted).toEqual({
      'matrix:url': 'https://matrix.to/x',
      'matrix:author': '[[stvad]]',
    })
  })

  it('promotes spaced property keys after stripping TODO markers from values', () => {
    const plan = planImport([{
      title: 'p',
      uid: 'pUid',
      children: [{
        string: 'parent',
        uid: 'parentUid',
        children: [
          {
            string: 'initial review date::[[April 27th, 2026]] {{[[DONE]]}}',
            uid: 'reviewUid',
          },
          {string: 'Full Title:: Algorithms to Live By', uid: 'titleUid'},
          {string: 'muscle mass %:: 41', uid: 'muscleUid'},
          {string: '6. Runs ::fix-needs-update after transact', uid: 'proseUid'},
        ],
      }],
    }], {workspaceId: WORKSPACE, currentUserId: USER})

    const byUid = (uid: string) => plan.descendants.find(d => d.roamUid === uid)
    const props = byUid('parentUid')?.data.properties
    expect(props?.['roam:initial review date']).toBe('[[April 27th, 2026]]')
    expect(props?.['roam:Full Title']).toBe('Algorithms to Live By')
    expect(props?.['roam:muscle mass %']).toBe('41')
    expect(props?.['roam:6. Runs']).toBeUndefined()

    expect(byUid('reviewUid')?.data.content)
      .toBe('initial review date::[[April 27th, 2026]]')
    expect(byUid('reviewUid')?.todoState).toBe('DONE')
  })

  it('promotes broader real-world Roam attribute keys without treating page-ref attr values as keys', () => {
    const promotion = computePromotedFromChildren([
      {string: 'Have Backbone; Disagree and Commit::4', uid: 'lp1'},
      {string: 'Any risks / hazards? Potential distractions, procrastination, etc.:: usual setup hazards', uid: 'risk'},
      {string: 'Nino Annighöfer:: contact', uid: 'person'},
      {string: '[[account number]]:: 1234', uid: 'pageRefKey'},
      {string: 'Connecting layer [[local priority::1]]', uid: 'notAttr'},
    ], new Set())

    expect(promotion.promoted['roam:Have Backbone; Disagree and Commit']).toBe('4')
    expect(promotion.promoted['roam:Any risks / hazards? Potential distractions, procrastination, etc.'])
      .toBe('usual setup hazards')
    expect(promotion.promoted['roam:Nino Annighöfer']).toBe('contact')
    expect(promotion.promoted['roam:[[account number]]']).toBe('1234')
    expect(promotion.promoted['roam:Connecting layer [[local priority']).toBeUndefined()
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
      'mailto:gliderok@gmail.com',
      'mailto:aix123@yandex.ru',
    ])
    // Block tree preserved: email:: kept, both children parented under it.
    expect(byUid('emailUid')?.content).toBe('email::')
    expect(byUid('e1')?.parentId).toBe(roamBlockId(WORKSPACE, 'emailUid'))
    expect(byUid('e2')?.parentId).toBe(roamBlockId(WORKSPACE, 'emailUid'))
  })

  it('case 4 with attr children: treats children as case-1 sub-attrs (not as list values)', () => {
    // `email::` has TWO attribute children (work, home). Per case 4
    // sub-rule "treat as case 1 if children are themselves attrs" —
    // we hoist work/home to the grandparent. The empty inline `email`
    // value contributes nothing to the property bag. All source blocks
    // survive in the tree.
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
    // Every source block survives.
    expect(byUid('emailUid')?.parentId).toBe(roamBlockId(WORKSPACE, 'parentUid'))
    expect(byUid('w')?.parentId).toBe(roamBlockId(WORKSPACE, 'emailUid'))
    expect(byUid('h')?.parentId).toBe(roamBlockId(WORKSPACE, 'emailUid'))
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
