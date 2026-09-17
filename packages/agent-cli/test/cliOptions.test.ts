import { cac } from 'cac'
import { describe, expect, it } from 'vitest'
import { limitOption, scopeAssertion, workspaceAssertion } from '../src/cliOptions.js'

/** Parse argv the way the real CLI does and hand back what the option
 *  actually became — so this pins CAC's behaviour too, not just our handling
 *  of a value we assumed it produces. */
const parseOption = (name: 'workspace' | 'limit' | 'scope', argv: string[]): unknown => {
  const cli = cac('t')
  let seen: unknown
  cli.command('page <name>', 'x')
    .option('--workspace <id>', 'w')
    .option('--limit <n>', 'l')
    .option('--scope <scope>', 's')
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

  it('refuses a repeated --workspace instead of joining it into a bogus id', () => {
    // CAC collects a repeated flag into an array. Coercing it with String()
    // yields 'a,b', which the wire schema's `z.string()` accepts — so the
    // command answers confidently about a workspace that does not exist.
    const parsed = parseWorkspaceOption(['page', 'x', '--workspace', 'a', '--workspace', 'b'])
    expect(parsed).toEqual(['a', 'b'])

    expect(() => workspaceAssertion(parsed)).toThrow(/single workspace id/i)
  })
})

describe('limitOption', () => {
  it('refuses an EMPTY --limit instead of running the query with LIMIT 0', () => {
    const parsed = parseOption('limit', ['page', 'x', '--limit', ''])
    expect(parsed).toBe(0)

    expect(() => limitOption(parsed as number)).toThrow(/positive integer/i)
  })

  it.each([0, -1, 1.5, 'abc'] as const)('refuses a non-positive-integer --limit (%s)', value => {
    expect(() => limitOption(value)).toThrow(/positive integer/i)
  })

  it('omits the field entirely when the option is absent', () => {
    expect(parseOption('limit', ['page', 'x'])).toBeUndefined()
    expect(limitOption(undefined)).toEqual({})
  })

  it('passes a real limit through as a number', () => {
    expect(limitOption(parseOption('limit', ['page', 'x', '--limit', '25']) as number))
      .toEqual({limit: 25})
  })
})

describe('scopeAssertion', () => {
  // Driven through CAC, like its neighbours: the values this normalizes are
  // CAC artifacts, so a test that hand-feeds them pins only our half.
  it('keeps an EMPTY --scope as a value the kernel can name back', () => {
    // Left as CAC's 0 it stringifies to '0' and the refusal quotes a value the
    // operator never typed.
    const parsed = parseOption('scope', ['page', 'x', '--scope', ''])
    expect(parsed).toBe(0)

    expect(scopeAssertion(parsed)).toEqual({scope: ''})
  })

  it('omits the field when absent, so the kernel default is the only default', () => {
    expect(scopeAssertion(parseOption('scope', ['page', 'x']))).toEqual({})
  })

  it('refuses a repeated flag rather than coercing the array', () => {
    const parsed = parseOption('scope', ['page', 'x', '--scope', 'all', '--scope', 'unapplied'])
    expect(parsed).toEqual(['all', 'unapplied'])

    expect(() => scopeAssertion(parsed)).toThrow(/single value/)
  })
})
