import { describe, expect, it, vi } from 'vitest'
import { ensureExtensionUtilitiesCss } from '@/extensions/extensionUtilitiesCss'

// Vite rejects the dynamic import when the stylesheet's <link> errors.
vi.mock('../extension-utilities.css', () => { throw new Error('Unable to preload CSS') })

describe('ensureExtensionUtilitiesCss', () => {
  it('settles when the stylesheet fails to load, so a waiting runtime apply is not rejected', async () => {
    await expect(ensureExtensionUtilitiesCss()).resolves.toBeUndefined()
  })
})
