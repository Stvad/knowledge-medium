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
    {label: 'a missing value', args: ['--contributor']},
    {label: 'an empty value', args: ['--contributor', '']},
    {label: 'a whitespace-only value', args: ['--contributor', '   ']},
    {label: 'an option-looking value', args: ['--contributor', '--foo']},
    {label: 'duplicate selections', args: ['--contributor', 'id', '--contributor', 'other']},
  ])('rejects $label before starting MCP transport', async ({args}) => {
    await expect(execFileAsync(process.execPath, [mcpScript, ...args], {timeout: 2_000}))
      .rejects.toMatchObject({stderr: expect.stringContaining('Usage: km-mcp')})
  })
})
