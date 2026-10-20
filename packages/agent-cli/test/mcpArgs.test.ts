import {describe, expect, it} from 'vitest'
import {execFile} from 'node:child_process'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const mcpScript = path.resolve(here, '../dist/mcp.js')

describe('km-mcp contributor argument parsing', {timeout: 15_000}, () => {
  it.each([
    ['--contributor'],
    ['--contributor', '--foo'],
    ['--contributor', 'id', '--contributor', 'other'],
  ])('rejects malformed arguments before starting MCP transport (%j)', async (...args) => {
    await expect(execFileAsync(process.execPath, [mcpScript, ...args], {timeout: 2_000}))
      .rejects.toMatchObject({stderr: expect.stringContaining('Usage: km-mcp')})
  })
})
