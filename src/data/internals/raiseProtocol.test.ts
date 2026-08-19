import {describe, expect, it} from 'vitest'
import {
  ALIAS_COLLISION_RAISE_PREFIX,
  RAISE_FIELD_SEP,
  parseAliasCollisionError,
} from './raiseProtocol.js'

/** Build the RAISE message the uniqueness trigger emits: the three field
 *  values uppercase-hex-encoded (SQLite's `hex()`) and unit-separated. */
const raiseError = (workspaceId: string, alias: string, attemptedBlockId: string) => {
  const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()
  const fields = [workspaceId, alias, attemptedBlockId].map(hex).join(RAISE_FIELD_SEP)
  return new Error(
    `SQLITE_CONSTRAINT: ${ALIAS_COLLISION_RAISE_PREFIX}${RAISE_FIELD_SEP}${fields}`,
  )
}

describe('parseAliasCollisionError', () => {
  it('decodes a leading U+FEFF in the alias instead of eating it as a byte-order mark', () => {
    // The hex decode is an exact byte round-trip of what the row holds, not
    // a document read: a default `new TextDecoder()` strips a leading
    // U+FEFF, which would hand the repair path an alias one character short
    // of the one that actually collided — so it would look up the wrong
    // alias. Same defect class as the AEAD one in issue #534. The doubled
    // case pins that the decoder strips at most one, at offset 0 only.
    for (const alias of ['\ufeff', '\ufeffdaily', '\ufeff\ufeffdaily', 'a\ufeffb']) {
      expect(parseAliasCollisionError(raiseError('ws-A', alias, 'block-1'))).toEqual({
        workspaceId: 'ws-A',
        alias,
        attemptedBlockId: 'block-1',
      })
    }
  })
})
