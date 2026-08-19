import { cac } from 'cac'
import { describe, expect, it } from 'vitest'
import { workspaceAssertion } from '../src/cliOptions.js'

/** Parse argv the way the real CLI does and hand back what the option
 *  actually became — so this pins CAC's behaviour too, not just our handling
 *  of a value we assumed it produces. */
const parseWorkspaceOption = (argv: string[]): unknown => {
  const cli = cac('t')
  let seen: unknown
  cli.command('page <name>', 'x').option('--workspace <id>', 'w').action((_name, options) => {
    seen = (options as {workspace?: unknown}).workspace
  })
  cli.parse(['node', 't', ...argv])
  return seen
}

describe('workspaceAssertion', () => {
  it('keeps an EMPTY --workspace as an assertion so the command layer can refuse it', () => {
    // The whole bug: a shell expanding an unset variable yields `--workspace
    // ""`, CAC turns that into the number 0, and a truthiness test drops it —
    // silently answering about the active workspace instead of the named one.
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
