import { describe, expect, it } from 'vitest'
import { applyHeading, collectContentRefUids, rewriteRoamContent } from '../content'

const uidMap = new Map<string, string>([
  ['vgkFNA64b', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'],
  ['3iAWxE3r8', '11111111-2222-4333-8444-555555555555'],
])

describe('rewriteRoamContent', () => {
  it('rewrites bare block refs to mapped uuids', () => {
    const {content, unresolvedBlockUids} = rewriteRoamContent(
      '**Weekly focus:** ((vgkFNA64b))',
      uidMap,
    )
    expect(content).toBe('**Weekly focus:** ((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee))')
    expect(unresolvedBlockUids).toEqual([])
  })

  it('rewrites embed macro to !((uuid))', () => {
    const {content} = rewriteRoamContent(
      '{{embed: ((vgkFNA64b))}} and {{ embed : ((3iAWxE3r8)) }}',
      uidMap,
    )
    expect(content).toBe(
      '!((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)) and !((11111111-2222-4333-8444-555555555555))',
    )
  })

  it('rewrites wikilink embed directive macro to !((uuid))', () => {
    const {content} = rewriteRoamContent(
      '{{[[embed]]: ((vgkFNA64b))}} and {{ [[embed]] : ((3iAWxE3r8)) }}',
      uidMap,
    )
    expect(content).toBe(
      '!((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)) and !((11111111-2222-4333-8444-555555555555))',
    )
  })

  it('rewrites embed-path macros to embeds and reports their source targets', () => {
    const {content, embedPathTargets} = rewriteRoamContent(
      '{{embed-path: ((vgkFNA64b))}} and {{[[embed-path]]:: ((3iAWxE3r8))}}',
      uidMap,
    )
    expect(content).toBe(
      '!((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)) and !((11111111-2222-4333-8444-555555555555))',
    )
    expect(embedPathTargets).toEqual([
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      '11111111-2222-4333-8444-555555555555',
    ])
  })

  it('preserves label on aliased block ref [text](((uid)))', () => {
    const {content} = rewriteRoamContent(
      '[control hip weight transfer](((vgkFNA64b)))',
      uidMap,
    )
    expect(content).toBe(
      '[control hip weight transfer](((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)))',
    )
  })

  it('does not re-resolve mapped UUIDs introduced by an earlier rewrite step', () => {
    // Regression: when EMBED/ALIASED rewrites ran before a sequential
    // BLOCK_REF_RE replace, the UUID emitted by the earlier rewrite got
    // matched by the bare `((uid))` regex on the next pass and reported
    // as `unresolved`. Now the three rewrites resolve from the *source*
    // in a single position-based pass.
    const {content, unresolvedBlockUids} = rewriteRoamContent(
      '{{embed: ((vgkFNA64b))}} and [click](((3iAWxE3r8))) and ((vgkFNA64b))',
      uidMap,
    )
    expect(content).toBe(
      '!((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee)) and ' +
      '[click](((11111111-2222-4333-8444-555555555555))) and ' +
      '((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee))',
    )
    // No "leaked" uids — every roam uid was in the map.
    expect(unresolvedBlockUids).toEqual([])
  })

  it('records and preserves unresolved block uids', () => {
    const {content, unresolvedBlockUids} = rewriteRoamContent(
      '((nope_unknown)) and ((vgkFNA64b))',
      uidMap,
    )
    expect(content).toBe(
      '((nope_unknown)) and ((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee))',
    )
    expect(unresolvedBlockUids).toEqual(['nope_unknown'])
  })

  it('converts #tag to [[tag]]', () => {
    const {content} = rewriteRoamContent('drill #srm and #wcs/footwork', new Map())
    expect(content).toBe('drill [[srm]] and [[wcs/footwork]]')
  })

  it('converts #[[multi word]] to [[multi word]]', () => {
    const {content} = rewriteRoamContent('see #[[Get really good at dancing]]', new Map())
    expect(content).toBe('see [[Get really good at dancing]]')
  })

  it('does not match # inside URLs', () => {
    const {content} = rewriteRoamContent(
      'visit https://example.com/foo#bar and #realtag',
      new Map(),
    )
    expect(content).toBe('visit https://example.com/foo#bar and [[realtag]]')
  })

  it('does not rewrite hashes inside existing page refs', () => {
    const {content} = rewriteRoamContent(
      'see [[Promotion #L6]] and #todo',
      new Map(),
    )
    expect(content).toBe('see [[Promotion #L6]] and [[todo]]')
  })

  it('does not rewrite hashes inside code spans or code fences', () => {
    const {content} = rewriteRoamContent(
      '`#not-a-tag` and ```js\n#still-not\n``` and #tag',
      new Map(),
    )
    expect(content).toBe('`#not-a-tag` and ```js\n#still-not\n``` and [[tag]]')
  })

  it('does not rewrite URL fragments in markdown link destinations', () => {
    const {content} = rewriteRoamContent(
      '[comments](https://vlad.roam.garden/post?#comments) #tag',
      new Map(),
    )
    expect(content).toBe('[comments](https://vlad.roam.garden/post?#comments) [[tag]]')
  })

  it('does not rewrite hash tokens inside markdown link labels', () => {
    const {content} = rewriteRoamContent(
      '[Reader Public Beta Update #5](https://read.readwise.io/read/abc) #tag',
      new Map(),
    )
    expect(content).toBe(
      '[Reader Public Beta Update #5](https://read.readwise.io/read/abc) [[tag]]',
    )
  })

  it('does not match # mid-identifier', () => {
    const {content} = rewriteRoamContent('a#b is not a tag, but #b is', new Map())
    expect(content).toBe('a#b is not a tag, but [[b]] is')
  })

  it('does not rewrite trailing hashes like door codes', () => {
    const {content} = rewriteRoamContent('door code:: 46612748# and #tag', new Map())
    expect(content).toBe('door code:: 46612748# and [[tag]]')
  })

  it('leaves [[Page]] page refs alone', () => {
    const {content} = rewriteRoamContent('see [[April 28th, 2026]]', uidMap)
    expect(content).toBe('see [[April 28th, 2026]]')
  })

  it('does not rewrite block refs inside code spans or code fences', () => {
    const {content, unresolvedBlockUids} = rewriteRoamContent(
      '`((vgkFNA64b))` and ```js\n((3iAWxE3r8))\n``` and ((vgkFNA64b))',
      uidMap,
    )
    expect(content).toBe(
      '`((vgkFNA64b))` and ```js\n((3iAWxE3r8))\n``` and ((aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee))',
    )
    expect(unresolvedBlockUids).toEqual([])
  })
})

describe('collectContentRefUids', () => {
  it('collects embed and embed-path directive spellings', () => {
    expect(collectContentRefUids(
      '{{embed: ((vgkFNA64b))}} {{[[embed]]: ((3iAWxE3r8))}} {{[[embed-path]]: ((pathUid))}}',
    )).toEqual(['pathUid', 'vgkFNA64b', '3iAWxE3r8'])
  })

  it('ignores block refs inside code spans or code fences', () => {
    expect(collectContentRefUids(
      '`((vgkFNA64b))` ```js\n((3iAWxE3r8))\n``` ((realUid))',
    )).toEqual(['realUid'])
  })
})

describe('applyHeading', () => {
  it('prepends # for heading 1', () => {
    expect(applyHeading('Title', 1)).toBe('# Title')
  })

  it('prepends ### for heading 3', () => {
    expect(applyHeading('Sub', 3)).toBe('### Sub')
  })

  it('caps at heading 6', () => {
    expect(applyHeading('Deep', 9)).toBe('###### Deep')
  })

  it('returns content unchanged when heading absent or 0', () => {
    expect(applyHeading('plain', undefined)).toBe('plain')
    expect(applyHeading('plain', 0)).toBe('plain')
  })
})
