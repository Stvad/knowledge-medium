/** Small helpers for the compiled declaration tree that `kmagent types`
 * materializes for extension authors. The declarations themselves are
 * emitted by TypeScript during the package build and kept as a normal
 * file tree under `dist/kernel-types/`. */

export const kernelTypeAssetDeclarations = `declare module '*.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.png' {
  const url: string
  export default url
}
`

export interface KernelTypesInstallSummaryOptions {
  outDir: string
  fileCount: number
  pathsTarget: string
}

export const renderKernelTypesInstallSummary = (
  options: KernelTypesInstallSummaryOptions,
): string => `${JSON.stringify({
  ok: true,
  outDir: options.outDir,
  files: options.fileCount,
  tsconfig: {
    compilerOptions: {
      paths: {
        '@/*': [`${options.pathsTarget}/*`],
      },
    },
  },
}, null, 2)}\n`
