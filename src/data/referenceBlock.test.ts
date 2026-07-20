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
    expect(parseExactReferenceBlockContent(content)).toEqual({kind: 'blockRef', id: UUID})
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
    expect(parseExactReferenceBlockContent(content)).toEqual({kind: 'blockRef', id: 'field-status'})
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
    expect(parseExactReferenceBlockContent(`((${upper}))`)).toEqual({kind: 'blockRef', id: lower})
    expect(() => referenceBlockContentForId(upper)).toThrow(/does not round-trip/)
    expect(referenceBlockContentForId(lower)).toBe(`((${lower}))`)
  })
})

describe('referenceBlockContentForLabel', () => {
  it('renders a label and parses it back', () => {
    expect(parseExactReferenceBlockContent(referenceBlockContentForLabel('Status')))
      .toEqual({kind: 'alias', alias: 'Status'})
  })

  // Lossy by design (documented on the helper): `]]` can't survive the round
  // trip, which is why `addSchema` rejects such names up front rather than
  // rendering them here.
  it('escapes `]]` rather than emitting an unparseable wikilink', () => {
    expect(referenceBlockContentForLabel('foo]]bar')).toBe('[[foo] ]bar]]')
  })
})
