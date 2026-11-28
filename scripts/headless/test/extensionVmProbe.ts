import assert from 'node:assert/strict'
import type {CompiledRecord} from '@/extensions/compiledModuleCache.js'
import {instantiateHostExtension} from '../extensionVm'

const manifest = {
  exactPageImports: {},
  sourceSpecifiers: ['@/extensions/core.js'],
}
const block = 'fixture'
const evaluate = (
  compiled: string, check: () => Promise<void>, dependency = async () => ({value: 42}),
) => instantiateHostExtension(block, {compiled} as CompiledRecord, manifest, dependency, check)

const result = await evaluate("import {value} from '@/extensions/core.js'; export default value", async () => {})
assert.equal(result.default, 42, 'positive control evaluates after linking')
await assert.rejects(evaluate("export default await import('node:fs')", async () => {}), /Extension import is not allowed/)
await assert.rejects(evaluate("import 'km-vendored:absent'; export default null", async () => {}), /Extension import is not allowed/)
await assert.rejects(evaluate("import {missing} from '@/extensions/core.js'; export default missing", async () => {}),
  /does not provide an export named 'missing'/)

let admitted = true
const check = async () => { if (!admitted) throw new Error('Writable admission ended during linking') }
await assert.rejects(
  evaluate("import {value} from '@/extensions/core.js'; export default value", check, async () => {
    admitted = false
    return {value: 42}
  }),
  /Writable admission ended during linking/,
)

admitted = true
const lazy = await evaluate("export default () => import('@/extensions/core.js')", check)
const invoke = lazy.default as () => Promise<{value: number}>
admitted = false
await assert.rejects(invoke(), /Writable admission ended during linking/)
const admittedLazy = await evaluate("export default () => import('@/extensions/core.js')", async () => {})
assert.equal((await (admittedLazy.default as typeof invoke)()).value, 42)
