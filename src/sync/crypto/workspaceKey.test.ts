import { describe, expect, it } from 'vitest'
import {
  WK_BYTES,
  WK_PREFIX,
  formatWorkspaceKey,
  generateWorkspaceKeyBytes,
  importWorkspaceKey,
  parseWorkspaceKey,
} from './workspaceKey.js'

describe('workspace key', () => {
  it('generates 256 bits', () => {
    expect(generateWorkspaceKeyBytes()).toHaveLength(WK_BYTES)
  })

  it('round-trips format/parse and yields a kmp-wk-1: string', () => {
    const bytes = generateWorkspaceKeyBytes()
    const formatted = formatWorkspaceKey(bytes)
    expect(formatted.startsWith(WK_PREFIX)).toBe(true)
    expect(parseWorkspaceKey(formatted)).toEqual(bytes)
  })

  it('tolerates surrounding whitespace and case on paste', () => {
    const bytes = generateWorkspaceKeyBytes()
    const formatted = formatWorkspaceKey(bytes)
    expect(parseWorkspaceKey(`  ${formatted}\n`)).toEqual(bytes)
    const lowered = WK_PREFIX + formatted.slice(WK_PREFIX.length).toLowerCase()
    expect(parseWorkspaceKey(lowered)).toEqual(bytes)
  })

  it('rejects a string without the prefix', () => {
    expect(() => parseWorkspaceKey('AAAA')).toThrow(/prefix/)
  })

  it('rejects a wrong-length payload', () => {
    expect(() => parseWorkspaceKey(`${WK_PREFIX}AAAA`)).toThrow(/bytes/)
  })

  it('imports a non-extractable AES-GCM CryptoKey usable for both ops (§5)', async () => {
    const key = await importWorkspaceKey(generateWorkspaceKeyBytes())
    expect(key.extractable).toBe(false)
    expect((key.algorithm as { name: string }).name).toBe('AES-GCM')
    expect(key.usages.sort()).toEqual(['decrypt', 'encrypt'])
  })
})
