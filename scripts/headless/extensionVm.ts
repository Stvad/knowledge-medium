import {resolveExtensionImport, vendoredImportSpecifier, ExtensionImportError, type ExtensionImportManifest} from '@/extensions/extensionImportPolicy.js'
import type {CompiledRecord} from '@/extensions/compiledModuleCache.js'
import {SourceTextModule, SyntheticModule, type Module} from 'node:vm'

const blockedSources = new Set([
  '@/extensions/approveExtensionHere.js',
  '@/extensions/buildApprovalRecord.js',
  '@/extensions/compileExtensionModule.js',
  '@/extensions/compiledModuleCache.js',
  '@/extensions/dynamicExtensions.js',
  '@/extensions/appRuntimeController.js',
  '@/extensions/AppRuntimeProvider.js',
  '@/plugins/agent-runtime/bridge.js',
  '@/plugins/agent-runtime/commands.js',
  '@/plugins/agent-runtime/index.js',
])

export type ImportNamespace = (specifier: string) => Promise<Record<string, unknown>>

export async function instantiateHostExtension(
  blockId: string,
  record: CompiledRecord,
  manifest: ExtensionImportManifest,
  importNamespace: ImportNamespace,
  checkAdmission: () => void,
): Promise<Record<string, unknown>> {
  const modules = new Map<string, Promise<Module>>()
  const dynamicEvaluations = new Map<Module, Promise<unknown>>()
  const vendoredSpecifiers = new Set(Object.keys(record.vendored ?? {}).map(vendoredImportSpecifier))

  async function createDependency(specifier: string): Promise<Module> {
    const resolved = resolveExtensionImport(specifier, {vendoredSpecifiers}, manifest)
    if (resolved.kind === 'vendored') {
      const bytes = record.vendored![resolved.integrity]
      return new SourceTextModule(new TextDecoder('utf-8', {fatal: true}).decode(bytes), {
        identifier: specifier,
        initializeImportMeta(meta, module) { meta.url = module.identifier },
      })
    }
    if (resolved.kind === 'live') throw new ExtensionImportError('Live imports are unavailable', 'unpinned-import')
    const source = resolved.kind === 'page'
      ? resolved.target.replace(/^\.\/src\//, '@/')
      : resolved.specifier
    if (blockedSources.has(source)) throw new ExtensionImportError('Module is unavailable on the host')
    const namespace = await importNamespace(source)
    const names = Object.keys(namespace)
    return new SyntheticModule(names, function () {
      for (const name of names) this.setExport(name, namespace[name])
    }, {identifier: source})
  }

  function link(specifier: string): Promise<Module> {
    const existing = modules.get(specifier)
    if (existing) return existing
    const dependency = createDependency(specifier)
    modules.set(specifier, dependency)
    return dependency
  }

  const entry = new SourceTextModule(record.compiled, {
    identifier: `km-extension://${blockId.replace(/[^A-Za-z0-9._-]/g, '_')}.tsx`,
    initializeImportMeta(meta, module) { meta.url = module.identifier },
    async importModuleDynamically(specifier) {
      const dependency = await link(specifier)
      if (dependency.status !== 'evaluated') {
        let evaluation = dynamicEvaluations.get(dependency)
        if (!evaluation) {
          evaluation = (async () => {
            if (dependency.status === 'unlinked') await dependency.link(link)
            checkAdmission()
            await dependency.evaluate()
          })()
          dynamicEvaluations.set(dependency, evaluation)
        }
        await evaluation
      }
      return dependency
    },
  })
  await entry.link(link)
  checkAdmission()
  await entry.evaluate()
  return entry.namespace as Record<string, unknown>
}
