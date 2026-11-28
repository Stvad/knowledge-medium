import {mkdir, readFile, rename, writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {buildApprovalRecord, VendoredImportError} from '@/extensions/buildApprovalRecord.js'
import {ExtensionImportError, type ExtensionImportManifest} from '@/extensions/extensionImportPolicy.js'
import {InMemoryCompiledModuleCache} from '@/extensions/compiledModuleCache.js'
import {normalizeExtensionSource} from '@/extensions/normalizeExtensionSource.js'
import type {HeadlessConfig} from './config'
import {OperatorFilePermissionsError, readOperatorFile} from './operatorFile'

export type ApprovalRefusal = 'reviewed-file-unreadable' | 'reviewed-file-permissions' | 'compile-error' | 'invalid-pinned-import'
  | ExtensionImportError['reason']

export const approvalRefusal = (error: unknown): ApprovalRefusal => {
  if (error instanceof ExtensionImportError) return error.reason
  if (error instanceof VendoredImportError) return 'invalid-pinned-import'
  return 'compile-error'
}

export async function buildHostApproval(
  block: string, source: string, cacheDir: string, manifest: ExtensionImportManifest,
) {
  const cacheFile = (integrity: string) => join(cacheDir, Buffer.from(integrity.slice('sha256-'.length), 'base64').toString('hex'))
  const fromDisk = new Set<string>()
  const record = await buildApprovalRecord(block, normalizeExtensionSource(source), {
    manifest, allowUnpinnedLive: false,
    async frozen(integrity) {
      try {
        const bytes = await readFile(cacheFile(integrity))
        fromDisk.add(integrity)
        return new Uint8Array(bytes)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    },
  })
  for (const [integrity, bytes] of Object.entries(record.vendored ?? {})) {
    if (fromDisk.has(integrity)) continue
    await mkdir(cacheDir, {recursive: true, mode: 0o700})
    const file = cacheFile(integrity)
    // A restart must see a whole verified module or a cache miss.
    await writeFile(file + '.tmp', bytes, {mode: 0o600})
    await rename(file + '.tmp', file)
  }
  return record
}

export async function prepareExtensionApprovals(config: HeadlessConfig, manifest: ExtensionImportManifest) {
  const persistent = new InMemoryCompiledModuleCache()
  const refusals = new Map<string, ApprovalRefusal>()
  for (const {block, file} of config.extensions ?? []) {
    let source: string
    try {
      source = await readOperatorFile(file, 'reviewed')
    } catch (error) {
      refusals.set(block, error instanceof OperatorFilePermissionsError ? 'reviewed-file-permissions' : 'reviewed-file-unreadable')
      continue
    }
    try {
      const record = await buildHostApproval(block, source, join(config.stateDir, 'extension-imports'), manifest)
      await persistent.write(block, record)
    } catch (error) {
      refusals.set(block, approvalRefusal(error))
    }
  }
  return {persistent, refusals}
}
