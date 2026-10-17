/**
 * How the agent reaches the graph: the km MCP tools, or the agent CLI from a
 * shell. A surface is a run condition (`tools`): its prompt preamble and the
 * tools Claude Code offers are part of what a report measures, while the
 * MCP server's own tool list is recorded beside it, so a slice that adds a
 * tool stays comparable with the run before it.
 */
import { KM_MCP_ALLOWED_TOOLS } from '../../packages/agent-cli/src/mcpShared'
import { definitionHash } from './report'

export const SURFACE_NAMES = ['mcp', 'cli'] as const
export type SurfaceName = (typeof SURFACE_NAMES)[number]

const GRAPH = 'You have access to a Knowledge Medium notes graph (an outliner of pages and nested blocks, '
  + 'with [[wikilinks]] and one daily note per day)'

interface Surface {
  preamble: string
  /** Claude Code's built-in tools on offer: `--tools`. */
  builtIn: string
  /** Shell commands the agent may run: the CLI, and filters to pipe it through. */
  commands: readonly string[]
  mcp: boolean
}

export const SURFACES: Record<SurfaceName, Surface> = {
  mcp: {
    preamble: `${GRAPH} through the km tools.`,
    builtIn: '',
    commands: [],
    mcp: true,
  },
  cli: {
    preamble: `${GRAPH} through the \`kmagent\` command-line tool; \`kmagent --help\` lists its commands.`,
    builtIn: 'Bash',
    commands: ['kmagent', 'head', 'tail', 'grep', 'jq', 'wc', 'sort'],
    mcp: false,
  },
}

export const surfaceHash = (surface: Surface): string => definitionHash(surface)

export const allowedTools = (surface: Surface): string[] =>
  [...(surface.mcp ? KM_MCP_ALLOWED_TOOLS : []), ...surface.commands.map(command => `Bash(${command}:*)`)]

/** `--tools` and `--allowedTools`; every other tool is refused without a prompt. */
export const toolArgs = (surface: Surface): string[] =>
  ['--tools', surface.builtIn, '--allowedTools', allowedTools(surface).join(',')]
