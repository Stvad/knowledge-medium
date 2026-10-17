import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { getCommandMeta } from '../src/protocol.js'
import { commandSummary } from '../src/cliHelp.js'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const cliScript = path.resolve(here, '../dist/cli.js')

const help = async (...args: string[]): Promise<string> =>
  (await execFileAsync(process.execPath, [cliScript, ...args, '--help'])).stdout

/** An agent reads the top-level help before anything else, so it is a ratchet
 *  like the eval's output budgets: it may shrink, never grow back. */
const TOP_LEVEL_HELP_BUDGET = 5_500
/** A summary longer than this crowds the top-level list. */
const SUMMARY_MAX_CHARS = 160

/** The `Commands:` section's lines: `  <rawName>  <summary>`. */
const commandLines = (text: string): string[] => {
  const start = text.indexOf('Commands:\n') + 'Commands:\n'.length
  return text.slice(start, text.indexOf('\n\n', start)).split('\n')
}

describe('kmagent help', () => {
  it('lists every command on one short line, inside the top-level budget', async () => {
    const text = await help()
    const lines = commandLines(text)

    expect(text.length).toBeLessThanOrEqual(TOP_LEVEL_HELP_BUDGET)
    expect(lines.map(line => line.trim().split(/\s/)[0])).toEqual(expect.arrayContaining([
      'connect', 'health', 'sql', 'get-block', 'subtree', 'search', 'data-model', 'rematerialize-workspace', 'types',
    ]))
    for (const line of lines) {
      const summary = line.trim().replace(/^\S+(?: [<[]\S*)*\s{2,}/, '')
      expect(summary.length, `"${summary}" is the first sentence of its command's description; keep it under ${SUMMARY_MAX_CHARS} characters`)
        .toBeLessThanOrEqual(SUMMARY_MAX_CHARS)
    }
  }, 20_000)

  it('prints a command\'s whole description under its own --help', async () => {
    const {description} = getCommandMeta('rematerialize-workspace')
    const text = await help('rematerialize-workspace')

    expect(text).toContain(description)
    expect(text).toContain('--scope <scope>')
  }, 20_000)

  it('gives a graph read verb its tool description under its own --help', async () => {
    expect(await help('subtree')).toContain(getCommandMeta('view-outline').description)
  }, 20_000)
})

describe('kmagent arguments', () => {
  /** Runs a verb against a bridge that is not there: parsing has run by the
   *  time the call fails, so its refusals are what this shows. */
  const run = async (...args: string[]): Promise<string> => {
    const result = await execFileAsync(process.execPath, [cliScript, ...args], {
      env: {...process.env, AGENT_RUNTIME_URL: 'http://127.0.0.1:9', AGENT_RUNTIME_TOKEN: 'x'},
    }).catch((error: {stdout: string, stderr: string}) => error)
    return `${result.stdout}${result.stderr}`
  }

  it('takes a topic of several words', async () => {
    expect(await run('data-model', 'daily', 'notes')).not.toMatch(/Unused args/)
  }, 20_000)

  it('refuses a word a boolean flag swallowed, naming it', async () => {
    expect(await run('search', '--include-extensions', 'foo', 'bar')).toMatch(/--include-extensions took "foo" as its value/)
  }, 20_000)
})

describe('commandSummary', () => {
  it('takes the first sentence, not a dot inside a name or a parenthesis', () => {
    expect(commandSummary('Run SQL (mode: all|get|optional|execute). Refuses a raw write.'))
      .toBe('Run SQL (mode: all|get|optional|execute).')
    expect(commandSummary('Set window.location.hash (with or without leading #)'))
      .toBe('Set window.location.hash (with or without leading #)')
    expect(commandSummary('Run JS in the app. `--data <path>` reads JSON.')).toBe('Run JS in the app.')
  })
})
