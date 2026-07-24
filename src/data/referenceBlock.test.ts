// @vitest-environment node
/**
 * Whole-block reference content: the `((id))` / `[[name]]` forms property
 * field rows and ref-typed values are written in (PR #288 §7).
 */

import { describe, expect, it } from 'vitest'
import {
  parseExactReferenceBlockContent,
  referenceBlockContentForId,
  referenceBlockContentForLabel,
} from './referenceBlock.ts'

const UUID = '11111111-1111-4111-8111-111111111111'

describe('referenceBlockContentForId', () => {
  it('renders an id as whole-block ref content that parses back', () => {
    const content = referenceBlockContentForId(UUID)
    expect(content).toBe(`((${UUID}))`)
    expect(parseExactReferenceBlockContent(content)).toEqual({kind: 'blockRef', id: UUID, fieldForm: false})
  })

  // Ids are normally UUIDs, but `tx.create` and the bridge's `create-block`
  // take a caller-supplied id. One with whitespace or parens renders as a
  // `((…))` the parser rejects — and in a child-backed workspace that lands as
  // silent corruption: the property child is written with a prefilled
  // `referenceTargetId`, then `core.deriveReferenceTarget` runs afterwards,
  // can't parse the same text, clears the column, and the owner's cell quietly
  // loses the key. Failing at render time keeps it loud and local.
  it.each([
    ['a space', 'block id'],
    ['an opening paren', 'block(id'],
    ['a closing paren', 'block)id'],
    ['a tab', 'block\tid'],
    ['empty', ''],
  ])('refuses an id containing %s', (_label, id) => {
    expect(() => referenceBlockContentForId(id)).toThrow(/cannot address block id/)
  })

  // Non-UUID ids that DO round-trip stay supported: the exact-ref grammar is
  // deliberately broader than the inline references plugin's UUID-only one.
  it('accepts a non-UUID id that round-trips', () => {
    const content = referenceBlockContentForId('field-status')
    expect(parseExactReferenceBlockContent(content)).toEqual({kind: 'blockRef', id: 'field-status', fieldForm: false})
  })

  // A case-variant UUID passes the no-parens/no-whitespace check but does NOT
  // round-trip: the parser canonicalizes UUID-looking ids to lowercase, so the
  // ref reads back as a DIFFERENT id (PR #386 review). Same silent-corruption
  // shape as the unparseable case, except the derived stamp lands on a wrong or
  // nonexistent block instead of clearing.
  it('refuses a UUID id that is not already lowercase', () => {
    // Must contain hex LETTERS — an all-digit UUID is unchanged by upper-casing
    // and would vacuously pass.
    const lower = 'abcdef01-1111-4111-8111-1111111111ab'
    const upper = lower.toUpperCase()
    expect(upper).not.toBe(lower)
    expect(parseExactReferenceBlockContent(`((${upper}))`)).toEqual({kind: 'blockRef', id: lower, fieldForm: false})
    expect(() => referenceBlockContentForId(upper)).toThrow(/does not round-trip/)
    expect(referenceBlockContentForId(lower)).toBe(`((${lower}))`)
  })
})

describe('referenceBlockContentForLabel', () => {
  it('renders a label and parses it back', () => {
    expect(parseExactReferenceBlockContent(referenceBlockContentForLabel('Status')))
      .toEqual({kind: 'alias', alias: 'Status', fieldForm: false})
  })

  // Lossy by design (documented on the helper): `]]` can't survive the round
  // trip, which is why `addSchema` rejects such names up front rather than
  // rendering them here.
  it('escapes `]]` rather than emitting an unparseable wikilink', () => {
    expect(referenceBlockContentForLabel('foo]]bar')).toBe('[[foo] ]bar]]')
  })
})

// ──── §7 grammar box: the `::` field marker + the three span forms ────

describe('parseExactReferenceBlockContent — marked field forms', () => {
  const UUID = '0f7b3c1a-9d2e-4f60-8a1b-2c3d4e5f6a7b'

  it('parses ::((uuid)) as a marked blockRef (canonical field form)', () => {
    expect(parseExactReferenceBlockContent(`::((${UUID}))`))
      .toEqual({kind: 'blockRef', id: UUID, fieldForm: true})
  })

  it('parses ::[[name]] as a marked alias (pure syntax — resolution-independent)', () => {
    expect(parseExactReferenceBlockContent('::[[status]]'))
      .toEqual({kind: 'alias', alias: 'status', fieldForm: true})
  })

  it('parses ::[label](((uuid))) as a marked aliasedBlockRef', () => {
    expect(parseExactReferenceBlockContent(`::[status](((${UUID})))`))
      .toEqual({kind: 'aliasedBlockRef', id: UUID, label: 'status', fieldForm: true})
  })

  it('parses the unmarked aliased blockref too (target stamps for every form)', () => {
    expect(parseExactReferenceBlockContent(`[status](((${UUID})))`))
      .toEqual({kind: 'aliasedBlockRef', id: UUID, label: 'status', fieldForm: false})
  })

  it('canonicalizes the aliased form id to lowercase, mirroring the plugin regex', () => {
    expect(parseExactReferenceBlockContent(`[x](((${UUID.toUpperCase()})))`))
      .toEqual({kind: 'aliasedBlockRef', id: UUID, label: 'x', fieldForm: false})
  })

  it('keeps the aliased form UUID-only (plugin-mirrored) while exact refs stay broad', () => {
    expect(parseExactReferenceBlockContent('[x](((not-a-uuid)))')).toBeNull()
    expect(parseExactReferenceBlockContent('::((not-a-uuid))'))
      .toEqual({kind: 'blockRef', id: 'not-a-uuid', fieldForm: true})
  })

  it('allows an empty aliased-form label (renders like a plain ref)', () => {
    expect(parseExactReferenceBlockContent(`::[](((${UUID})))`))
      .toEqual({kind: 'aliasedBlockRef', id: UUID, label: '', fieldForm: true})
  })

  it('matches on trimmed content (outer whitespace policy is pinned — a pasted trailing newline must not flicker classification)', () => {
    expect(parseExactReferenceBlockContent(`  ::((${UUID}))\n`))
      .toEqual({kind: 'blockRef', id: UUID, fieldForm: true})
  })

  it('admits no space between marker and span', () => {
    expect(parseExactReferenceBlockContent(':: [[status]]')).toBeNull()
    expect(parseExactReferenceBlockContent(`:: ((${UUID}))`)).toBeNull()
  })

  it('never reads prose starting with :: as a reference', () => {
    expect(parseExactReferenceBlockContent('::not a span')).toBeNull()
    expect(parseExactReferenceBlockContent('::')).toBeNull()
    expect(parseExactReferenceBlockContent(`::((${UUID})) trailing`)).toBeNull()
  })

  it('excludes embeds — a transclusion directive, not a marker', () => {
    expect(parseExactReferenceBlockContent(`::!((${UUID}))`)).toBeNull()
    expect(parseExactReferenceBlockContent(`!((${UUID}))`)).toBeNull()
  })
})
