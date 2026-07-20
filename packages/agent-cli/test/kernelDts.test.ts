import {describe, expect, it} from 'vitest'
import {
  kernelTypeAssetDeclarations,
  kernelTypeDeclarationCandidates,
  renderKernelTypesInstallSummary,
} from '../src/kernelDts'

describe('kernel type tree helpers', () => {
  it('ships asset module declarations alongside the emitted tree', () => {
    expect(kernelTypeAssetDeclarations).toContain("declare module '*.css'")
    expect(kernelTypeAssetDeclarations).toContain("declare module '*.svg'")
    expect(kernelTypeAssetDeclarations).toContain("declare module '*.png'")
  })

  it('prints the tsconfig paths mapping for a materialized declaration tree', () => {
    const out = renderKernelTypesInstallSummary({
      outDir: '/tmp/project/agent-extensions/kernel-types',
      fileCount: 42,
      pathsTarget: 'agent-extensions/kernel-types/src',
    })

    expect(JSON.parse(out)).toEqual({
      ok: true,
      outDir: '/tmp/project/agent-extensions/kernel-types',
      files: 42,
      tsconfig: {
        compilerOptions: {
          paths: {
            '@/*': ['agent-extensions/kernel-types/src/*'],
          },
        },
      },
    })
  })

  it('maps browser-style @/ module specifiers to declaration candidates', () => {
    expect(kernelTypeDeclarationCandidates('@/extensions/core.js')).toEqual([
      'src/extensions/core.d.ts',
      'src/extensions/core/index.d.ts',
    ])
    expect(kernelTypeDeclarationCandidates('@/data/api')).toEqual([
      'src/data/api.d.ts',
      'src/data/api/index.d.ts',
    ])
    expect(kernelTypeDeclarationCandidates('@/data/api/index.js')).toEqual([
      'src/data/api/index.d.ts',
      'src/data/api/index/index.d.ts',
    ])
  })

  it('rejects non-@/ and path-escaping module specifiers', () => {
    expect(() => kernelTypeDeclarationCandidates('react')).toThrow('must start with "@/"')
    expect(() => kernelTypeDeclarationCandidates('@/../secrets')).toThrow('Invalid @/ module specifier')
  })
})
