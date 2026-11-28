import {execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {promisify} from 'node:util'
import {afterEach, beforeEach, describe, expect, it} from 'vitest'

const execFileAsync = promisify(execFile)
const cli = path.resolve(import.meta.dirname, '../dist/cli.js')
const url = 'https://cdn.example.test/dependency.js'
const moduleSource = 'export default 42'
const digest = createHash('sha256').update(moduleSource).digest('base64')
const original = `import value from '${url}'\nexport default value\n`

let directory: string
let sourceFile: string

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kmagent-pin-imports-'))
  sourceFile = path.join(directory, 'fixture.ts')
  await fs.writeFile(sourceFile, original)
})

afterEach(async () => {
  await fs.rm(directory, {recursive: true, force: true})
})

const runWithFetch = (fetchImplementation: string, ...args: string[]) =>
  execFileAsync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${fetchImplementation}`)}`, cli, ...args,
  ], {
    env: {...process.env, AGENT_RUNTIME_URL: 'https://bridge.example.test', AGENT_RUNTIME_TOKEN: 'test-token'},
  })

const moduleResponse = (source: string): string =>
  `async () => new Response(${JSON.stringify(source)}, {headers: {'content-type': 'application/javascript'}})`

describe('kmagent pin-imports', () => {
  // Starting a fresh CLI process and its parser took about 900 ms on its own.
  it('writes the verified pin and prints only the rewritten import with its canonical URL and hash', {timeout: 20_000}, async () => {
    const entry = 'https://cdn.example.test/entry'
    const canonical = 'https://cdn.example.test/implementation.js'
    const unchanged = `import '${url}' with {integrity: 'sha256-${digest}'};`
    const expectedRewrite = `import value from '${canonical}' with {integrity: 'sha256-${digest}'};`
    await fs.writeFile(sourceFile, `${unchanged} import value from '${entry}';\nexport default value\n`)
    const fetch = `async url => new Response(url.href === ${JSON.stringify(entry)}
      ? "export * from './implementation.js'; export {default} from './implementation.js';"
      : ${JSON.stringify(moduleSource)})`
    const {stdout} = await runWithFetch(fetch, 'pin-imports', sourceFile)

    const pinned = await fs.readFile(sourceFile, 'utf8')
    expect(pinned).toBe(`${unchanged} ${expectedRewrite}\nexport default value\n`)
    expect(stdout).toBe(`${expectedRewrite}\n`)
  })

  it('preserves the input file when a remote module is refused', async () => {
    const bundled = "import './other.js'; export default 42"
    await expect(runWithFetch(moduleResponse(bundled), 'pin-imports', sourceFile)).rejects.toThrow('not self-contained')
    expect(await fs.readFile(sourceFile, 'utf8')).toBe(original)
  })

  // Starts the same standalone CLI and parser as the verified pin case.
  it('preserves a source edit made while fetching the dependency', {timeout: 20_000}, async () => {
    const edited = `${original}// An edit made during the fetch\n`
    const fetchWhileEditing = `async () => {
      const {writeFile} = await import('node:fs/promises')
      await writeFile(${JSON.stringify(sourceFile)}, ${JSON.stringify(edited)})
      return new Response(${JSON.stringify(moduleSource)})
    }`

    await expect(runWithFetch(fetchWhileEditing, 'pin-imports', sourceFile)).rejects.toMatchObject({
      message: expect.stringContaining('source changed while pinning'),
      stdout: '',
    })
    expect(await fs.readFile(sourceFile, 'utf8')).toBe(edited)
  })
})

const bridge = `async (url, init) => {
  const path = new URL(url).pathname
  if (path === '/health') return Response.json({ok: true})
  if (path === '/runtime/commands') {
    return Response.json({id: encodeURIComponent(JSON.parse(init.body).source)})
  }
  if (path.startsWith('/runtime/commands/')) {
    return Response.json({status: 'completed', result: {ok: true, value: decodeURIComponent(path.split('/').at(-1))}})
  }
  throw new Error('Unexpected bridge request: ' + url)
}`

const install = () => runWithFetch(bridge, 'install-extension', sourceFile, '--contributor', 'none')

describe('kmagent install-extension', () => {
  it('warns about unpinned imports on stderr while submitting the original source', async () => {
    const {stdout, stderr} = await install()
    expect(JSON.parse(stdout)).toBe(original)
    expect(stderr).toContain('kmagent pin-imports <file>')
  })

  it('installs an already-pinned import without a warning', async () => {
    const pinned = original.replace(`'${url}'`, `'${url}' with {integrity: 'sha256-${digest}'}`)
    await fs.writeFile(sourceFile, pinned)

    const {stdout, stderr} = await install()
    expect(JSON.parse(stdout)).toBe(pinned)
    expect(stderr).not.toContain('kmagent pin-imports <file>')
  })
})
