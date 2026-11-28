import {
  collectModulePins, isHttpsModuleSpecifier, isRuntimeHttpsModuleReference, isStaticModuleReference,
  isUnpinnedHttpsModuleReference, isUnsupportedImportMeta, literalModuleSpecifier, moduleReference,
  staticModuleReferences, unpinnedHttpsDynamicImport, visitModuleSyntax, type Node,
} from '@knowledge-medium/agent-cli/extensionImportSyntax'

export interface ExtensionImportManifest {
  exactPageImports: Readonly<Record<string, string>>
  sourceSpecifiers: readonly string[]
}

export class ExtensionImportError extends Error {
  constructor(message: string, readonly reason: 'forbidden-import' | 'unpinned-import' = 'forbidden-import') {
    super(message)
  }
}

const buildManifest = typeof __EXTENSION_IMPORT_MANIFEST__ === 'undefined'
  ? {exactPageImports: {}, sourceSpecifiers: []}
  : __EXTENSION_IMPORT_MANIFEST__
const vendoredScheme = 'km-vendored:'
const liveScheme = 'km-live:'

export const vendoredImportSpecifier = (integrity: string): string => vendoredScheme + integrity
// Generated JSX specifiers append a slash and runtime subpath. Encode the
// entire URL so that suffix cannot match an authored import's placeholder.
const liveImportSpecifier = (url: string): string => liveScheme + encodeURIComponent(url)

type ExtensionImport =
  | {kind: 'page'; target: string}
  | {kind: 'source'; specifier: string}
  | {kind: 'vendored'; integrity: string}
  | {kind: 'live'; url: string}

interface ImportGrants {
  vendoredSpecifiers?: ReadonlySet<string>
  liveSpecifiers?: ReadonlySet<string>
}

function findExtensionImport(
  specifier: string,
  grants: ImportGrants,
  manifest: ExtensionImportManifest,
): ExtensionImport | undefined {
  const {exactPageImports, sourceSpecifiers} = manifest
  if (Object.hasOwn(exactPageImports, specifier)) return {kind: 'page', target: exactPageImports[specifier]}
  if (sourceSpecifiers.includes(specifier)) return {kind: 'source', specifier}
  if (grants.vendoredSpecifiers?.has(specifier)) {
    return {kind: 'vendored', integrity: specifier.slice(vendoredScheme.length)}
  }
  if (grants.liveSpecifiers?.has(specifier)) {
    return {kind: 'live', url: decodeURIComponent(specifier.slice(liveScheme.length))}
  }
}

function extensionImportHint(specifier: string): string {
  if (specifier.startsWith('@/')) return 'Use the .js path of an existing application module included in the build.'
  if (/^data:/i.test(specifier)) return 'Move the code into this extension or use a self-contained HTTPS module with an integrity pin.'
  if (isHttpsModuleSpecifier(specifier)) return 'Check @jsxImportSource for an HTTPS origin. Use an approved JSX runtime importmap key.'
  return 'Use an importmap key or the @/ path to a built application module.'
}

export function resolveExtensionImport(
  specifier: string,
  grants: ImportGrants = {},
  manifest: ExtensionImportManifest = buildManifest,
): ExtensionImport {
  const resolved = findExtensionImport(specifier, grants, manifest)
  if (!resolved) throw new ExtensionImportError(`Extension import is not allowed: ${specifier}. ${extensionImportHint(specifier)}`)
  return resolved
}

export function runnableSpecifier(specifier: string): boolean {
  return findExtensionImport(specifier, {}, buildManifest) !== undefined
}

function rejectAuthoredPlaceholder(specifier: string): void {
  if (specifier.startsWith(vendoredScheme) || specifier.startsWith(liveScheme)) {
    throw new ExtensionImportError('Extension source cannot use a reserved import specifier')
  }
}

export function createExtensionImportTransform() {
  const transform = {
    pinnedImports: new Map<string, string>(),
    unpinnedImports: new Set<string>(),
    plugin: () => ({visitor: {Program: rewriteProgram}}),
  }

  function rewriteLive(url: string): string {
    transform.unpinnedImports.add(url)
    return liveImportSpecifier(url)
  }

  // Read only the original program. A generated HTTPS import must never
  // inherit the grant of an authored import with the same URL.
  function rewriteProgram({node: ast}: {node: unknown}) {
    const references = staticModuleReferences(ast)
    transform.pinnedImports = collectModulePins(references)
    for (const reference of references) {
      const url = reference.source.value
      rejectAuthoredPlaceholder(url)
      const integrity = transform.pinnedImports.get(url)
      if (isUnpinnedHttpsModuleReference(reference)) {
        reference.source.value = rewriteLive(url)
      } else if (integrity && isRuntimeHttpsModuleReference(reference)) {
        reference.source.value = vendoredImportSpecifier(integrity)
        reference.attributes = []
      }
    }
    visitModuleSyntax(ast, node => {
      if (node.type !== 'ImportExpression') return
      const specifier = literalModuleSpecifier(node.source)
      if (specifier === undefined) return
      rejectAuthoredPlaceholder(specifier)
      const liveUrl = unpinnedHttpsDynamicImport(node)
      if (!liveUrl) return
      if (node.options) throw new ExtensionImportError('Pin HTTPS dynamic imports by moving them to a static import')
      node.source = {type: 'StringLiteral', value: rewriteLive(liveUrl)}
    })
  }
  return transform
}

interface ImportReference {
  start: number
  end: number
}

interface ExtensionImportReplacement extends ImportReference {
  value: string
}

function referenceRange(node: Node): ImportReference {
  if (node.start == null || node.end == null) throw new ExtensionImportError('Extension import has no source range')
  return {start: node.start, end: node.end}
}

function replaceExtensionImportReferences(
  compiled: string,
  replacements: readonly ExtensionImportReplacement[],
): string {
  let end = compiled.length
  let code = ''
  for (const replacement of [...replacements].sort((a, b) => b.start - a.start)) {
    code = JSON.stringify(replacement.value) + compiled.slice(replacement.end, end) + code
    end = replacement.start
  }
  return compiled.slice(0, end) + code
}

type ParseCompiled = (compiled: string, options: {sourceType: 'module'}) => unknown

interface CompiledImportGrants {
  pinnedImports: ReadonlyMap<string, string>
  unpinnedImports: ReadonlySet<string>
  allowUnpinnedLive: boolean
  manifest?: ExtensionImportManifest
}

export function assertCompiledExtensionImports(
  parse: ParseCompiled,
  compiled: string,
  grants: CompiledImportGrants,
) {
  const liveReplacements: ExtensionImportReplacement[] = []
  let hasStaticUnpinnedImports = false
  const importGrants = {
    vendoredSpecifiers: new Set([...grants.pinnedImports.values()].map(vendoredImportSpecifier)),
    liveSpecifiers: new Set([...grants.unpinnedImports].map(liveImportSpecifier)),
  }

  function check(source: Node, isStatic: boolean) {
    const specifier = literalModuleSpecifier(source)
    if (specifier === undefined) {
      throw new ExtensionImportError('Extension import() requires a literal module specifier. Replace the computed argument with a quoted path or a template literal without interpolations.')
    }
    const resolved = resolveExtensionImport(specifier, importGrants, grants.manifest)
    if (resolved.kind === 'live') {
      if (!grants.allowUnpinnedLive) throw new ExtensionImportError(`Extension import requires an integrity pin: ${resolved.url}`, 'unpinned-import')
      liveReplacements.push({...referenceRange(source), value: resolved.url})
      hasStaticUnpinnedImports ||= isStatic
    }
  }

  visitModuleSyntax(parse(compiled, {sourceType: 'module'}), (node, parent) => {
    const reference = moduleReference(node)
    if (reference?.source) check(reference.source, reference.kind === 'static')
    if (isUnsupportedImportMeta(node, parent)) throw new ExtensionImportError('Extensions can only access import.meta.url. Replace other import.meta properties with explicit constants or literal import paths.')
  })

  return {
    compiled: replaceExtensionImportReferences(compiled, liveReplacements),
    importsUnpinned: liveReplacements.length > 0,
    hasStaticUnpinnedImports,
  }
}

export function linkVendoredImports(
  parse: ParseCompiled,
  compiled: string,
  urlFor: (integrity: string) => string,
): string {
  if (!compiled.includes(vendoredScheme)) return compiled
  const replacements: ExtensionImportReplacement[] = []
  visitModuleSyntax(parse(compiled, {sourceType: 'module'}), node => {
    if (!isStaticModuleReference(node)) return
    const specifier = node.source.value
    if (specifier.startsWith(vendoredScheme)) {
      replacements.push({
        ...referenceRange(node.source),
        value: urlFor(specifier.slice(vendoredScheme.length)),
      })
    }
  })
  return replaceExtensionImportReferences(compiled, replacements)
}
