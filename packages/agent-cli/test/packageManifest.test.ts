import {describe, expect, it} from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packageJsonPath = path.resolve(here, '../package.json')

interface PackageJson {
  name: string
  bin?: Record<string, string>
}

const readPackageJson = async (): Promise<PackageJson> => {
  const raw = await fs.readFile(packageJsonPath, 'utf8')
  return JSON.parse(raw) as PackageJson
}

describe('@knowledge-medium/agent-cli package manifest', () => {
  it('exposes a bin matching the unscoped package name for npm exec', async () => {
    const pkg = await readPackageJson()
    const unscopedName = pkg.name.split('/').at(-1)

    expect(unscopedName).toBe('agent-cli')
    expect(pkg.bin?.[unscopedName]).toBe('./dist/cli.js')
  })
})
