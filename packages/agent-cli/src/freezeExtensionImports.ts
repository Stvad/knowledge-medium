import {base64} from '@scure/base'
import {
  extensionImportIntegrity,
  isHttpsModuleSpecifier,
  isRuntimeHttpsModuleReference,
  isStaticModuleReference,
  isUnsupportedImportMeta,
  literalModuleSpecifier,
  parseExtensionSource,
  recordImportPin,
  readModuleIntegrity,
  staticModuleReferences,
  visitModuleSyntax,
} from './extensionImportSyntax.js'

const MAX_MODULE_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

function httpsModuleUrl(specifier: string): URL {
  const url = new URL(specifier)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Module URLs must use HTTPS without credentials')
  }
  return url
}

async function fetchModule(url: URL): Promise<Uint8Array<ArrayBuffer>> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS)
  const response = await fetch(url, {
    credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer', signal,
  })
  if (response.type === 'opaqueredirect' || response.redirected || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => {})
    const target = response.headers.get('location')
    const destination = target ? ` Pin the canonical HTTPS module URL (${new URL(target, url).href}).` :
      ' Pin the canonical HTTPS module URL directly.'
    throw new Error(`${url.href} redirected.${destination}`)
  }
  if (!response.ok || !response.body) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`Could not fetch ${url.href} (HTTP ${response.status})`)
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const {done, value} = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_MODULE_BYTES) {
        throw new Error(`${url.href} exceeds the ${MAX_MODULE_BYTES}-byte module limit`)
      }
      chunks.push(value)
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function parseModule(bytes: Uint8Array<ArrayBuffer>) {
  const {parse} = await import('@babel/parser')
  return parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes), {sourceType: 'module', createImportExpressions: true})
}

type ModuleAst = Awaited<ReturnType<typeof parseModule>>

// Only a pure forwarding entry can be replaced without dropping initialization or changing named exports.
function forwardingTarget(ast: ModuleAst, url: URL): {url: URL, forwardsDefault: boolean} | undefined {
  if (ast.program.directives.length > 0) return
  const statements = ast.program.body
  const [all, named] = statements
  if (statements.length > 2 || all?.type !== 'ExportAllDeclaration' || all.attributes?.length) return
  if (named && (named.type !== 'ExportNamedDeclaration' || named.attributes?.length ||
    named.source?.value !== all.source.value || named.specifiers.length !== 1 ||
    named.specifiers[0].type !== 'ExportSpecifier' || named.specifiers[0].local.type !== 'Identifier' ||
    named.specifiers[0].local.name !== 'default' ||
    named.specifiers[0].exported.type !== 'Identifier' || named.specifiers[0].exported.name !== 'default')) return
  if (!/^(?:https:\/\/|\.{0,2}\/)/i.test(all.source.value)) return
  const target = new URL(all.source.value, url)
  if (target.origin === url.origin && !target.username && !target.password && target.href !== url.href) {
    return {url: target, forwardsDefault: named !== undefined}
  }
}

function exportsDefault(ast: ModuleAst): boolean {
  return ast.program.body.some(node => node.type === 'ExportDefaultDeclaration' ||
    (node.type === 'ExportNamedDeclaration' && node.specifiers.some(specifier =>
      specifier.type === 'ExportSpecifier' &&
      (specifier.exported.type === 'Identifier' ? specifier.exported.name : specifier.exported.value) === 'default')))
}

function assertSelfContained(ast: ModuleAst, url: URL): void {
  visitModuleSyntax(ast, (node, parent) => {
    if (node.type === 'ImportExpression' || isStaticModuleReference(node)) {
      const canonical = forwardingTarget(ast, url)
      const suggestion = canonical ? ` Pin the canonical module URL (${canonical.url.href}).`
        : url.origin === 'https://esm.sh' && !url.pathname.endsWith('.mjs') && !url.searchParams.has('bundle')
          ? ' Request a self-contained esm.sh build with ?bundle.' : ''
      throw new Error(`${url.href} is not self-contained.${suggestion}`)
    }
    if (isUnsupportedImportMeta(node, parent)) {
      throw new Error(`${url.href} may only use import.meta.url`)
    }
  })
}

export type VendoredExtensionModules = Record<string, Uint8Array<ArrayBuffer>>

async function moduleIntegrity(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return `sha256-${base64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))}`
}

async function verifyModule(
  url: URL,
  bytes: Uint8Array<ArrayBuffer>,
  expectedIntegrity?: string,
) {
  const integrity = await moduleIntegrity(bytes)
  if (expectedIntegrity !== undefined && integrity !== expectedIntegrity) {
    throw new Error(`SHA-256 integrity mismatch for ${url.href}`)
  }
  assertSelfContained(await parseModule(bytes), url)
  return {url: url.href, integrity, bytes}
}

export async function vendorModule(
  specifier: string, expectedIntegrity?: string, storedBytes?: Uint8Array<ArrayBuffer>,
) {
  const url = httpsModuleUrl(specifier)
  if (expectedIntegrity !== undefined && !extensionImportIntegrity.test(expectedIntegrity)) {
    throw new Error(`Invalid SHA-256 integrity pin for ${url.href}`)
  }
  if (storedBytes && storedBytes.byteLength > MAX_MODULE_BYTES) {
    throw new Error(`${url.href} exceeds the ${MAX_MODULE_BYTES}-byte module limit`)
  }
  const bytes = storedBytes ? new Uint8Array(storedBytes) : await fetchModule(url)
  return verifyModule(url, bytes, expectedIntegrity)
}

export const freezeExtensionImport = vendorModule

export function verifyFrozenExtensionImport(
  specifier: string, bytes: Uint8Array<ArrayBuffer>, expectedIntegrity: string,
) {
  return vendorModule(specifier, expectedIntegrity, bytes)
}

async function pinModule(specifier: string) {
  let url = httpsModuleUrl(specifier)
  if (url.origin === 'https://esm.sh' && !url.pathname.endsWith('.mjs') && !url.searchParams.has('target')) {
    url.search += url.search ? '&target=es2024' : '?target=es2024'
  }
  let bytes = await fetchModule(url)
  let ast = await parseModule(bytes)
  const canonical = forwardingTarget(ast, url)
  if (canonical) {
    url = canonical.url
    bytes = await fetchModule(url)
    ast = await parseModule(bytes)
  }
  assertSelfContained(ast, url)
  if (canonical && canonical.forwardsDefault !== exportsDefault(ast)) {
    throw new Error(`Pinning ${specifier} to ${url.href} would change whether it exports default`)
  }
  return {url: url.href, integrity: await moduleIntegrity(bytes), bytes}
}

export async function pinExtensionImports(source: string): Promise<{
  source: string
  vendored: VendoredExtensionModules
  rewrittenImports: string[]
}> {
  const ast = await parseExtensionSource(source, true)
  const references = staticModuleReferences(ast)
    .filter(isRuntimeHttpsModuleReference)
    .map(node => ({node, existingIntegrity: readModuleIntegrity(node)}))
  if (!references.some(({existingIntegrity}) => existingIntegrity === undefined)) {
    visitModuleSyntax(ast, node => {
      if (node.type !== 'ImportExpression') return
      const specifier = literalModuleSpecifier(node.source)
      if (specifier && isHttpsModuleSpecifier(specifier)) {
        throw new Error(`Use a static import to pin ${specifier}`)
      }
    })
  }
  const modules = new Map<string, Awaited<ReturnType<typeof freezeExtensionImport>>>()
  const pins = new Map<string, string>()
  const vendored: VendoredExtensionModules = {}
  const edits: {start: number, end: number, replacement: string}[] = []
  const tokens = ast.tokens?.filter(token => typeof token.type !== 'string') ?? []
  const tokenIndexByEnd = new Map(tokens.map((token, index) => [token.end, index]))
  for (const {node, existingIntegrity} of references) {
    const specifier = node.source.value
    const key = JSON.stringify([specifier, existingIntegrity])
    let module = modules.get(key)
    if (!module) {
      module = existingIntegrity ? await vendorModule(specifier, existingIntegrity) : await pinModule(specifier)
      modules.set(key, module)
    }
    recordImportPin(pins, module.url, module.integrity)
    vendored[module.integrity] = module.bytes
    if (existingIntegrity) continue
    const {start, end} = node.source
    if (start == null || end == null || node.start == null || node.end == null) {
      throw new Error('Missing import source offsets')
    }
    const quote = source[start] === "'" ? "'" : '"'
    const escapedUrl = module.url.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`)
    const literal = module.url === specifier ? source.slice(start, end) : `${quote}${escapedUrl}${quote}`
    const pin = `integrity: '${module.integrity}'`
    // Babel represents both absent attributes and `with {}` as an empty array.
    const literalIndex = tokenIndexByEnd.get(end)
    const [withToken, openingBrace] = literalIndex === undefined ? [] : tokens.slice(literalIndex + 1, literalIndex + 3)
    const suffix = typeof withToken?.start === 'number' && withToken.type.label === 'with' && withToken.start < node.end
      ? source.slice(end, openingBrace.end) + pin + source.slice(openingBrace.end, node.end)
      : ` with {${pin}}${source.slice(end, node.end)}`
    edits.push({start: node.start, end: node.end, replacement: source.slice(node.start, start) + literal + suffix})
  }
  const rewrittenImports = edits.map(edit => edit.replacement)
  for (const {start, end, replacement} of edits.reverse()) {
    source = source.slice(0, start) + replacement + source.slice(end)
  }
  return {source, vendored, rewrittenImports}
}
