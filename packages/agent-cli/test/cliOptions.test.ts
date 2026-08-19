import { cac } from 'cac'
import { describe, expect, it } from 'vitest'
import { limitOption, workspaceAssertion } from '../src/cliOptions.js'

/** Parse argv the way the real CLI does and hand back what the option
 *  actually became — so this pins CAC's behaviour too, not just our handling
 *  of a value we assumed it produces. */
const parseOption = (name: 'workspace' | 'limit', argv: string[]): unknown => {
  const cli = cac('t')
  let seen: unknown
  cli.command('page <name>', 'x')
    .option('--workspace <id>', 'w')
    .option('--limit <n>', 'l')
    .action((_name, options) => {
      seen = (options as Record<string, unknown>)[name]
    })
  cli.parse(['node', 't', ...argv])
  return seen
}

const parseWorkspaceOption = (argv: string[]): unknown => parseOption('workspace', argv)

describe('workspaceAssertion', () => {
  it('keeps an EMPTY --workspace as an assertion so the command layer can refuse it', () => {
    const parsed = parseWorkspaceOption(['page', 'x', '--workspace', ''])
    expect(parsed).toBe(0)

    expect(workspaceAssertion(parsed as number)).toEqual({workspaceId: ''})
  })

  it('omits the field entirely when the option is absent', () => {
    expect(parseWorkspaceOption(['page', 'x'])).toBeUndefined()
    expect(workspaceAssertion(undefined)).toEqual({})
  })

  it('passes a real workspace id through unchanged', () => {
    const parsed = parseWorkspaceOption(['page', 'x', '--workspace', 'ws-1'])
    expect(workspaceAssertion(parsed as string)).toEqual({workspaceId: 'ws-1'})
  })
})

describe('limitOption', () => {
  it('refuses an EMPTY --limit instead of running the query with LIMIT 0', () => {
    // Same CAC artifact as `--workspace`, but a truthiness check would MASK
    // this one: 0 is a valid-looking bound, so it flows all the way to SQL
    // and reports "nothing found" for a page that exists.
    const parsed = parseOption('limit', ['page', 'x', '--limit', ''])
    expect(parsed).toBe(0)

    expect(() => limitOption(parsed as number)).toThrow(/positive integer/i)
  })

  it.each([['0', 0], ['-1', -1], ['1.5', 1.5], ['abc', 'abc']] as const)(
    'refuses a non-positive-integer --limit (%s)',
    (_label, value) => {
      expect(() => limitOption(value)).toThrow(/positive integer/i)
    },
  )

  it('omits the field entirely when the option is absent', () => {
    expect(parseOption('limit', ['page', 'x'])).toBeUndefined()
    expect(limitOption(undefined)).toEqual({})
  })

  it('passes a real limit through as a number', () => {
    expect(limitOption(parseOption('limit', ['page', 'x', '--limit', '25']) as number))
      .toEqual({limit: 25})
  })
})
