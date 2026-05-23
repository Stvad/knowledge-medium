/**
 * Tests for the .d.ts renderer used by `kmagent types`. The formatter
 * is pure (no I/O) so we can test it in isolation — keeping the test
 * fast and the format spec explicit.
 */
import {describe, expect, it} from 'vitest'
import {renderKernelDts} from '../src/kernelDts'

const fixedTime = '2026-05-22T20:00:00.000Z'

describe('renderKernelDts', () => {
  it('emits `declare module` with `export const X: any` per name', () => {
    const out = renderKernelDts({
      moduleSpec: '@/extensions/api.js',
      exports: ['useRepo', 'defineProperty', 'ChangeScope'],
      cliVersion: '0.1.0',
      generatedAt: fixedTime,
    })
    expect(out).toContain("declare module '@/extensions/api.js' {")
    expect(out).toContain('  export const useRepo: any')
    expect(out).toContain('  export const defineProperty: any')
    expect(out).toContain('  export const ChangeScope: any')
  })

  it('embeds the CLI version + generation timestamp in the header', () => {
    const out = renderKernelDts({
      moduleSpec: '@/extensions/api.js',
      exports: [],
      cliVersion: '0.1.0',
      generatedAt: fixedTime,
    })
    expect(out).toContain('CLI v0.1.0')
    expect(out).toContain(fixedTime)
  })

  it('also declares the no-`.js` form of the spec as a re-export', () => {
    const out = renderKernelDts({
      moduleSpec: '@/extensions/api.js',
      exports: ['foo'],
      cliVersion: '0.1.0',
      generatedAt: fixedTime,
    })
    // Authors writing `import {foo} from '@/extensions/api'` (no
    // suffix) should still resolve — we declare the alias module.
    expect(out).toContain("declare module '@/extensions/api' {")
    expect(out).toContain("export * from '@/extensions/api.js'")
  })

  it('omits the alias when the moduleSpec has no `.js` suffix', () => {
    const out = renderKernelDts({
      moduleSpec: '@kernel/api',
      exports: ['foo'],
      cliVersion: '0.1.0',
      generatedAt: fixedTime,
    })
    expect(out).toContain("declare module '@kernel/api' {")
    expect(out).not.toContain('export * from')
  })

  it('filters out names that are not valid JS identifiers', () => {
    // The runtime is unlikely to surface non-identifier export keys
    // (ESM forbids them at the source level) but a hostile bridge
    // could try; emitting them verbatim would yield a syntactically
    // broken .d.ts.
    const out = renderKernelDts({
      moduleSpec: '@/extensions/api.js',
      exports: ['useRepo', 'a-with-dash', '42invalid', '$valid', '_alsoValid', 'with space'],
      cliVersion: '0.1.0',
      generatedAt: fixedTime,
    })
    expect(out).toContain('export const useRepo: any')
    expect(out).toContain('export const $valid: any')
    expect(out).toContain('export const _alsoValid: any')
    expect(out).not.toContain('a-with-dash')
    expect(out).not.toContain('42invalid')
    expect(out).not.toContain('with space')
  })

  it('deduplicates exports even if the input has repeats', () => {
    const out = renderKernelDts({
      moduleSpec: '@/extensions/api.js',
      exports: ['useRepo', 'useRepo', 'useRepo'],
      cliVersion: '0.1.0',
      generatedAt: fixedTime,
    })
    const matches = out.match(/export const useRepo: any/g)
    expect(matches).toHaveLength(1)
  })

  it('handles an empty exports list (empty module body)', () => {
    const out = renderKernelDts({
      moduleSpec: '@/extensions/api.js',
      exports: [],
      cliVersion: '0.1.0',
      generatedAt: fixedTime,
    })
    expect(out).toContain("declare module '@/extensions/api.js' {")
    expect(out).toMatch(/declare module '@\/extensions\/api\.js' \{\s*\}/)
  })

  it('defaults `generatedAt` to the current time when omitted', () => {
    const before = Date.now()
    const out = renderKernelDts({
      moduleSpec: '@/extensions/api.js',
      exports: [],
      cliVersion: '0.1.0',
    })
    const after = Date.now()
    const match = out.match(/at (\S+)\./)
    expect(match).toBeTruthy()
    const stamp = match ? Date.parse(match[1]!) : NaN
    expect(stamp).toBeGreaterThanOrEqual(before)
    expect(stamp).toBeLessThanOrEqual(after)
  })
})
