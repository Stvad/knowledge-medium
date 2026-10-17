/**
 * Representative km MCP tool calls on the eval fixture, each with a budget
 * in characters, the unit Claude Code's MCP output cap counts. The budgets
 * are a RATCHET taken from the baseline run: they stop a tool's output from
 * growing, and the read-path work (#1236) is expected to lower them. A
 * probe's call shape follows the tool's current arguments; when a tool's
 * inputs change, update the probe here rather than deleting it — its hash
 * changes with it, so reports stop comparing its size with older runs.
 */
import { DESIGN_PAGE, PASTED_SOURCE_PAGE, PROJECT_PAGE, READING_LOG_PAGE } from './fixture'
import { definitionHash } from './report'

export interface ProbeContext {
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>
  /** Page id by exact title, resolved through the raw `page` wire command. */
  pageId: (title: string) => Promise<string>
  /** Daily-note block id for an ISO date, through the raw `daily-note` command. */
  dailyNoteId: (iso: string) => Promise<string>
}

export interface OutputProbe {
  id: string
  /** The shape this call stands for — what an agent would be doing. */
  standsFor: string
  run: (context: ProbeContext) => Promise<string>
  maxChars: number
}

export const outputProbeHash = (probe: OutputProbe): string => definitionHash(probe.run.toString())

/** Each probe's output size in characters. */
export const measureProbes = async (context: ProbeContext): Promise<Record<string, number>> => {
  const sizes: Record<string, number> = {}
  for (const probe of OUTPUT_PROBES) sizes[probe.id] = (await probe.run(context)).length
  return sizes
}

export const OUTPUT_PROBES: readonly OutputProbe[] = [
  {
    id: 'search:pricing',
    standsFor: 'a topic search whose hits include one pasted-source block',
    run: ({callTool}) => callTool('search', {query: 'pricing', limit: 10}),
    maxChars: 128_600,
  },
  {
    id: 'search:kestrel',
    standsFor: 'a topic search over short daily-note blocks',
    run: ({callTool}) => callTool('search', {query: 'Kestrel', limit: 10}),
    maxChars: 2_600,
  },
  {
    id: 'backlinks:Meeting',
    standsFor: 'backlinks of a page with ~600 bare [[Meeting]] references',
    run: async ({callTool, pageId}) => callTool('backlinks', {id: await pageId('Meeting')}),
    maxChars: 151_000,
  },
  {
    id: 'backlinks:Kestrel',
    standsFor: 'backlinks of a page referenced from a few dozen places',
    run: async ({callTool, pageId}) => callTool('backlinks', {id: await pageId('Kestrel')}),
    maxChars: 3_600,
  },
  {
    id: 'subtree:Reading Log',
    standsFor: 'the outline of a page with 2,000 direct children carrying importer metadata',
    run: async ({callTool, pageId}) => callTool('subtree', {rootId: await pageId(READING_LOG_PAGE)}),
    maxChars: 676_400,
  },
  {
    id: 'subtree:pasted source',
    standsFor: 'the outline of a page holding one ~100 KB pasted block',
    run: async ({callTool, pageId}) => callTool('subtree', {rootId: await pageId(PASTED_SOURCE_PAGE)}),
    maxChars: 129_800,
  },
  {
    id: 'subtree:daily note',
    standsFor: 'one daily note with standup and meeting blocks',
    run: async ({callTool, dailyNoteId}) => callTool('subtree', {rootId: await dailyNoteId('2026-06-04')}),
    maxChars: 3_000,
  },
  {
    id: 'subtree:project page',
    standsFor: 'a project page with nested todos',
    run: async ({callTool, pageId}) => callTool('subtree', {rootId: await pageId(PROJECT_PAGE)}),
    maxChars: 4_300,
  },
  {
    id: 'subtree:design doc',
    standsFor: 'a ~30-block design document',
    run: async ({callTool, pageId}) => callTool('subtree', {rootId: await pageId(DESIGN_PAGE)}),
    maxChars: 4_000,
  },
  {
    id: 'page:Project Orchard',
    standsFor: 'resolving a page by title',
    run: ({callTool}) => callTool('page', {name: PROJECT_PAGE}),
    maxChars: 600,
  },
]
