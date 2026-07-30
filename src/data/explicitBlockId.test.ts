// @vitest-environment node
/**
 * Write-boundary guard for caller-supplied block ids (issue #456). See
 * explicitBlockId.ts's module docblock for why this validator exists and
 * why it is NOT wired into internal minting (tx.create, createChild, the
 * deterministic v5 helpers).
 */
import { describe, expect, it } from 'vitest'
import { assertCanonicalBlockId, CANONICAL_BLOCK_ID_RE, InvalidBlockIdError } from './explicitBlockId.ts'

const VALID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('assertCanonicalBlockId', () => {
  it('accepts a canonical lowercase UUID', () => {
    expect(() => assertCanonicalBlockId(VALID, 'test')).not.toThrow()
  })

  it('rejects an uppercase UUID (case is part of the contract, not just shape)', () => {
    expect(() => assertCanonicalBlockId(VALID.toUpperCase(), 'test')).toThrow(InvalidBlockIdError)
  })

  it('rejects a mixed-case UUID', () => {
    // Index 1 is 'f' — a hex LETTER, so uppercasing it actually changes the
    // string (uppercasing a digit like index 0's '3' would be a no-op).
    const mixed = VALID.slice(0, 1) + VALID[1].toUpperCase() + VALID.slice(2)
    expect(mixed).not.toBe(VALID)
    expect(() => assertCanonicalBlockId(mixed, 'test')).toThrow(InvalidBlockIdError)
  })

  // Every case below except the shape/length ones is the SAME LENGTH as
  // VALID (36) — swapping one hex digit out for the offending character —
  // so only the character class is under test, not accidentally the
  // length/hyphen-position check.
  it.each([
    ['empty string', ''],
    ['too short', VALID.slice(0, -1)],
    ['too long', `${VALID}0`],
    ['missing hyphens', VALID.replaceAll('-', '')],
    ['hyphens in the wrong place', VALID.replaceAll('-', '').replace(/^(.{4})/, '$1-')],
    ['a trailing newline in place of the last hex digit', `${VALID.slice(0, -1)}\n`],
    ['a leading tab in place of the first hex digit', `\t${VALID.slice(1)}`],
    ['an embedded C0 escape control character', `${VALID.slice(0, 5)}\x1b${VALID.slice(6)}`],
    ['an embedded C1 control character', `${VALID.slice(0, 5)}\u0080${VALID.slice(6)}`],
    ['a closing-bracket (outline-grammar) character in place of the last hex digit', `${VALID.slice(0, -1)}]`],
    ['a percent (encoding-grammar) character in place of the last hex digit', `${VALID.slice(0, -1)}%`],
    ['an embedded non-ASCII accented letter', `${VALID.slice(0, -1)}é`],
    ['a bidi-reordering RTL letter', `${VALID.slice(0, -1)}א`],
    ['a mnemonic test-style id', 'block-1'],
    ['a bare hex string with no hyphens at all', 'deadbeefdeadbeefdeadbeefdeadbeefdead'],
  ])('rejects an id with %s', (_label, id) => {
    let error: unknown
    try {
      assertCanonicalBlockId(id, 'createBlock')
      throw new Error('expected assertCanonicalBlockId to throw')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(InvalidBlockIdError)
    const invalid = error as InvalidBlockIdError
    // The message is the UX (surfaces to agents and the CLI): it must name
    // both what was supplied and the shape that's required, not just "invalid".
    expect(invalid.message).toContain('createBlock')
    expect(invalid.message).toContain(JSON.stringify(id))
    expect(invalid.message).toMatch(/canonical UUID/i)
    expect(invalid.id).toBe(id)
  })

  it('CANONICAL_BLOCK_ID_RE has no "i" flag — lowercase is required, not merely matched', () => {
    expect(CANONICAL_BLOCK_ID_RE.flags).not.toContain('i')
  })
})
