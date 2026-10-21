import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('isMainModule', () => {
  const helper = new URL('./is-main-module.mjs', import.meta.url).href
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'is-main-module-')))
  writeFileSync(join(dir, 'probe.mjs'), `import { isMainModule } from '${helper}'\nconsole.log(isMainModule(import.meta.url))\n`)
  writeFileSync(join(dir, 'importer.mjs'), `import './probe.mjs'\n`)
  const linked = join(realpathSync(mkdtempSync(join(tmpdir(), 'is-main-module-link-'))), 'dir')
  symlinkSync(dir, linked)
  const run = (file: string) => spawnSync('node', [file], { encoding: 'utf8' }).stdout.trim()

  it('is true for the script node was started with', () => {
    expect(run(join(dir, 'probe.mjs'))).toBe('true')
  })

  it('is true when that script is reached through a symlinked directory', () => {
    expect(run(join(linked, 'probe.mjs'))).toBe('true')
  })

  it('is false for a module the entry script imports', () => {
    expect(run(join(dir, 'importer.mjs'))).toBe('false')
  })
})
