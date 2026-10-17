import { cac } from 'cac'
import { describe, expect, it } from 'vitest'
import { appendPositionOption, editArgumentsOption, limitOption, markdownText, scopeAssertion, workspaceAssertion } from '../src/cliOptions.js'

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

describe('appendPositionOption', () => {
  const parseAppend = (argv: string[]): Record<string, unknown> => {
    const cli = cac('t')
    let seen: Record<string, unknown> = {}
    cli.command('append-markdown <target>', 'x')
      .option('--first', 'f')
      .option('--after <id>', 'a')
      .option('--before <id>', 'b')
      .action((_target, options) => { seen = options as Record<string, unknown> })
    cli.parse(['node', 't', 'append-markdown', 'today', ...argv])
    return seen
  }

  it('refuses a digits-only anchor CAC turned into a number, rather than a different id prefix', () => {
    const options = parseAppend(['--after', '01234567'])
    expect(options.after).toBe(1234567)
    let message = ''
    try { appendPositionOption(options) } catch (error) { message = (error as Error).message }
    expect(message).toMatch(/--after got the number 1234567/)
    // The hint must not offer the numberified value back as an id prefix.
    expect(message).not.toMatch(/\^1234567/)
  })

  it('passes a ^-prefixed anchor through as text', () => {
    expect(appendPositionOption(parseAppend(['--before', '^01234567'])))
      .toEqual({position: {kind: 'before', siblingId: '^01234567'}})
  })

  it.each([
    [['--after', 'abc', '--after', 'def'], /--after expects a single value/],
    [['--before', 'abc', '--before', 'def'], /--before expects a single value/],
    [['--first', '--first'], /--first expects a single value/],
  ])('refuses a repeated position flag %j rather than joining or dropping it', (argv, refusal) => {
    expect(() => appendPositionOption(parseAppend(argv))).toThrow(refusal)
  })

  it('refuses more than one position flag', () => {
    expect(() => appendPositionOption(parseAppend(['--first', '--after', 'abc']))).toThrow(/at most one/)
  })
})

describe('markdownText', () => {
  const parseAppend = (argv: string[]): {markdown: unknown, options: Record<string, unknown>} => {
    const cli = cac('t')
    let seen = {markdown: undefined as unknown, options: {} as Record<string, unknown>}
    cli.command('append-markdown <target> [markdown]', 'x')
      .action((_target, markdown, options) => { seen = {markdown, options} })
    cli.parse(['node', 't', 'append-markdown', 'today', ...argv])
    return seen
  }
  const textOf = (argv: string[]) => {
    const {markdown, options} = parseAppend(argv)
    return markdownText(markdown, options['--'])
  }

  it('reads stdin (undefined) with no text, or a lone - on either side of --', () => {
    expect(textOf([])).toBeUndefined()
    expect(textOf(['-'])).toBeUndefined()
    expect(textOf(['--', '-'])).toBeUndefined()
  })

  it('joins the texts before and after -- in order, never dropping one side', () => {
    expect(textOf(['buy milk'])).toBe('buy milk')
    expect(textOf(['--', '- a', 'b'])).toBe('- a b')
    expect(textOf(['draft', '--', '- item'])).toBe('draft - item')
  })
})

describe('editArgumentsOption', () => {
  const parseEdit = (argv: string[]): {old: unknown, replacement: unknown, options: Record<string, unknown>} => {
    const cli = cac('t')
    let seen = {old: undefined as unknown, replacement: undefined as unknown, options: {} as Record<string, unknown>}
    cli.command('edit-block <id> [old] [new]', 'x')
      .action((_id, old, replacement, options) => { seen = {old, replacement, options} })
    cli.parse(['node', 't', 'edit-block', 'b1', ...argv])
    return seen
  }
  const editOf = (argv: string[]) => {
    const {old, replacement, options} = parseEdit(argv)
    return editArgumentsOption(old, replacement, options['--'])
  }

  it('takes <old> and <new> positionally, or after -- when either starts with -', () => {
    expect(editOf(['milk', 'oat milk'])).toEqual({old: 'milk', new: 'oat milk'})
    expect(editOf(['--', '- [ ]', '- [x]'])).toEqual({old: '- [ ]', new: '- [x]'})
  })

  it('keeps digits-only text as typed — CAC leaves positionals and `--` text as strings', () => {
    expect(editOf(['007', '008'])).toEqual({old: '007', new: '008'})
    expect(editOf(['--', '007', '008'])).toEqual({old: '007', new: '008'})
  })

  it('refuses anything but exactly two texts', () => {
    expect(() => editOf(['only-old'])).toThrow(/exactly <old> and <new>/)
    expect(() => editOf(['--', 'a', 'b', 'c'])).toThrow(/exactly <old> and <new>/)
  })

  it('reads texts before and after -- as one list, so a second pair is refused, not swapped in', () => {
    expect(editOf(['milk', '--', '-oat'])).toEqual({old: 'milk', new: '-oat'})
    expect(() => editOf(['milk', 'oat', '--', 'later-old', 'later-new'])).toThrow(/exactly <old> and <new>/)
  })
})
