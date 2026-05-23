import {describe, expect, it} from 'vitest'
import {
  kernelTypeAssetDeclarations,
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
})
