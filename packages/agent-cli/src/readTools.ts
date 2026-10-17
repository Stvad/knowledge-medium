/* The graph READ tools, defined once: the MCP tools (`mcpServer.ts`) and the
 * CLI verbs (`cli.ts`) are both generated from `GRAPH_READ_TOOLS`, so a flag
 * and its tool argument cannot drift. Input shapes come from the wire
 * schemas in `protocol.ts` (their `.describe()` text is the help text).
 *
 * Lives apart from `cli.ts` because that module self-executes on import. */
import {z} from 'zod'
import {isReadOnlySql, type KmMcpToolName} from './mcpShared.js'
import {
  AGENT_VIEW_DEFAULTS,
  dailyNoteCommandSchema,
  dataModelCommandSchema,
  getCommandMeta,
  type KnownCommand,
  type KnownCommandType,
  pageCommandSchema,
  viewBacklinksCommandSchema,
  viewBlockCommandSchema,
  viewGroupedBacklinksCommandSchema,
  viewOutlineCommandSchema,
  viewSearchCommandSchema,
} from './protocol.js'
import {workspaceAssertion} from './cliOptions.js'

type InputShape = Record<string, z.ZodType>
export type ToolInput = Record<string, unknown>

/** `--raw` sends the stored, unbounded command instead of the agent view.
 *  `rename` maps view fields to raw ones; `keep` lists fields that carry over
 *  unchanged. A view field in neither is refused rather than dropped. */
interface RawCommandSpec {
  type: string
  rename: Record<string, string>
  keep: readonly string[]
}

export interface GraphReadTool {
  name: KmMcpToolName
  wireType: KnownCommandType
  description: string
  shape: InputShape
  /** Absent for MCP-only tools. */
  cli?: {
    verb: string
    alias?: string
    /** `optional`: the field may be left out, or passed as its option instead. */
    positional?: {field: string, variadic: boolean, optional?: boolean}
  }
  raw?: RawCommandSpec
  buildCommand: (input: ToolInput) => KnownCommand
}

const WIRE_ONLY_FIELDS = ['type', 'commandId'] as const

/** A wire schema's fields minus the envelope ones. */
const inputShapeOf = (schema: z.ZodObject): InputShape => {
  const shape: InputShape = {...schema.shape}
  for (const key of WIRE_ONLY_FIELDS) delete shape[key]
  return shape
}

const wireCommand = (type: KnownCommandType) => (input: ToolInput): KnownCommand =>
  ({type, ...input}) as KnownCommand

const wireTool = (
  name: KmMcpToolName,
  wireType: KnownCommandType,
  schema: z.ZodObject,
  extra: Pick<GraphReadTool, 'cli' | 'raw'>,
): GraphReadTool => ({
  name,
  wireType,
  description: getCommandMeta(wireType).description,
  shape: inputShapeOf(schema),
  buildCommand: wireCommand(wireType),
  ...extra,
})

const sqlQueryShape: InputShape = {
  sql: z.string().describe('A single read-only SELECT (or WITH … SELECT) statement'),
  params: z.array(z.unknown()).optional().describe('Positional ? parameters'),
  maxRows: z.number().int().positive().optional().describe(
    `Max rows returned (default ${AGENT_VIEW_DEFAULTS.sqlMaxRows})`,
  ),
}

const sqlQueryTool: GraphReadTool = {
  name: 'sql_query',
  wireType: 'sql',
  description: 'Run a read-only SQL query (single SELECT/WITH statement) against the client database. '
    + 'Key tables: blocks(id, content, properties_json, parent_id, workspace_id). '
    + 'Rows are capped at maxRows and long string cells are cut (marked). '
    + 'Duplicate column names come back suffixed (id, id:1); alias them to tell them apart.',
  shape: sqlQueryShape,
  buildCommand: input => {
    const sql = input.sql as string
    if (!isReadOnlySql(sql)) {
      throw new Error('sql_query only accepts a single read-only statement (SELECT, or WITH without mutating keywords). Use create_block / update_block / move_block / delete_block / restore_block for writes.')
    }
    return {
      type: 'sql',
      mode: 'all',
      sql,
      params: (input.params as unknown[] | undefined) ?? [],
      maxRows: (input.maxRows as number | undefined) ?? AGENT_VIEW_DEFAULTS.sqlMaxRows,
    }
  },
}

export const GRAPH_READ_TOOLS: readonly GraphReadTool[] = [
  wireTool('get_block', 'view-block', viewBlockCommandSchema, {
    cli: {verb: 'get-block', positional: {field: 'ref', variadic: false}},
    raw: {type: 'get-block', rename: {ref: 'id'}, keep: ['workspaceId']},
  }),
  wireTool('subtree', 'view-outline', viewOutlineCommandSchema, {
    cli: {verb: 'subtree', positional: {field: 'ref', variadic: false}},
    raw: {type: 'get-subtree', rename: {ref: 'rootId'}, keep: ['workspaceId']},
  }),
  wireTool('backlinks', 'view-backlinks', viewBacklinksCommandSchema, {
    cli: {verb: 'backlinks', positional: {field: 'ref', variadic: false}},
    raw: {type: 'backlinks', rename: {ref: 'id'}, keep: ['filter', 'workspaceId']},
  }),
  wireTool('grouped_backlinks', 'view-grouped-backlinks', viewGroupedBacklinksCommandSchema, {
    cli: {verb: 'grouped-backlinks', positional: {field: 'ref', variadic: false}},
    raw: {type: 'grouped-backlinks', rename: {ref: 'id'}, keep: ['filter', 'grouping', 'workspaceId']},
  }),
  wireTool('search', 'view-search', viewSearchCommandSchema, {
    // No --raw: the stored search answer is whole rows, the unbounded shape
    // this view exists to replace (`kmagent raw` still sends one).
    cli: {verb: 'search', positional: {field: 'query', variadic: true}},
  }),
  wireTool('page', 'page', pageCommandSchema, {
    cli: {verb: 'page', positional: {field: 'name', variadic: true}},
  }),
  wireTool('daily_note', 'daily-note', dailyNoteCommandSchema, {
    cli: {verb: 'daily-note', positional: {field: 'date', variadic: true}},
  }),
  wireTool('guide', 'data-model', dataModelCommandSchema, {
    cli: {verb: 'data-model', alias: 'guide', positional: {field: 'topic', variadic: true, optional: true}},
  }),
  sqlQueryTool,
]

// ---------- results ----------

/** Views answer with a string in text mode and an object in json mode. */
export const renderToolResult = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value, null, 2)

export const toolCommand = (tool: GraphReadTool, input: ToolInput): KnownCommand =>
  tool.buildCommand(input)

/** The stored-shape command for `--raw`, or a refusal naming any view-only
 *  field that was also set (dropping it would silently change the question). */
export const rawToolCommand = (tool: GraphReadTool, input: ToolInput): KnownCommand => {
  const spec = tool.raw
  if (!spec) throw new Error(`${tool.cli?.verb ?? tool.name} has no --raw form`)
  const out: Record<string, unknown> = {type: spec.type}
  for (const [field, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (field in spec.rename) out[spec.rename[field]] = value
    else if (spec.keep.includes(field)) out[field] = value
    else throw new Error(`${field === 'format' ? '--json' : flagOf(field)} cannot be combined with --raw`)
  }
  return out as KnownCommand
}

// ---------- CLI options ----------

type OptionKind = 'number' | 'boolean' | 'string' | 'string-array' | 'spec'

export interface CliOptionSpec {
  field: string
  /** The cac option name without dashes (cac camel-cases it on parse). */
  key: string
  /** Full cac declaration, e.g. `--max-chars <value>`. */
  flag: string
  description: string
  kind: OptionKind
  /** Keyword values of a `spec` union (the rest is parsed as JSON). */
  keywords: readonly string[]
}

const kebab = (name: string): string => name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)

/** `workspaceId` is spelled `--workspace` everywhere else in the CLI. */
const flagName = (field: string): string => (field === 'workspaceId' ? 'workspace' : kebab(field))
const flagOf = (field: string): string => `--${flagName(field)}`

const unwrapOptional = (type: z.ZodType): z.ZodType =>
  type instanceof z.ZodOptional ? (type.unwrap() as z.ZodType) : type

const classify = (field: string, type: z.ZodType): {kind: OptionKind, keywords: readonly string[]} => {
  const inner = unwrapOptional(type)
  if (inner instanceof z.ZodBoolean) return {kind: 'boolean', keywords: []}
  if (inner instanceof z.ZodNumber) return {kind: 'number', keywords: []}
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) return {kind: 'string', keywords: []}
  if (inner instanceof z.ZodArray) return {kind: 'string-array', keywords: []}
  if (inner instanceof z.ZodUnion) {
    const options = inner.options as z.ZodType[]
    const enumOption = options.find(o => o instanceof z.ZodEnum) as z.ZodEnum | undefined
    if (enumOption && options.some(o => o instanceof z.ZodRecord)) {
      return {kind: 'spec', keywords: enumOption.options.map(String)}
    }
  }
  throw new Error(`readTools: no CLI option mapping for field "${field}"`)
}

/** A field the CLI takes only as the positional argument. */
const positionalOnly = (tool: GraphReadTool, field: string): boolean =>
  field === tool.cli?.positional?.field && tool.cli.positional.optional !== true

/** Every field but a positional-only one and `format` becomes an option. */
export const cliOptionsFor = (tool: GraphReadTool): CliOptionSpec[] =>
  Object.entries(tool.shape)
    .filter(([field]) => !positionalOnly(tool, field) && field !== 'format')
    .map(([field, type]) => {
      const {kind, keywords} = classify(field, type)
      const name = flagName(field)
      return {
        field,
        key: name,
        flag: kind === 'boolean' ? `--${name}` : `--${name} <${field === 'workspaceId' ? 'id' : 'value'}>`,
        description: type.description ?? '',
        kind,
        keywords,
      }
    })

export const hasJsonFormat = (tool: GraphReadTool): boolean => 'format' in tool.shape

// ---------- CLI coercion ----------

const cacKey = (key: string): string => key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

const EMPTY_VALUE_HINT = ' An empty value (a shell expanding an unset variable) arrives as 0.'

/** cac numberifies every digits-only option value before this code sees it,
 *  so `00123` arrives as 123 and its text is gone: turning it back into a
 *  string would name something else (another id prefix, another type). */
const refuseNumberified = (flag: string, value: unknown): void => {
  if (typeof value !== 'number') return
  throw new Error(
    `${flag} got the number ${value}: the CLI reads a digits-only value as a number, which drops leading zeros. `
    + `Send it as text with \`kmagent raw '<json>'\`; a block ref can also be written as its printed id prefix (^${value}).`,
  )
}

const coerceOption = (spec: CliOptionSpec, value: unknown): unknown => {
  const flag = flagOf(spec.field)
  switch (spec.kind) {
    case 'boolean':
      if (typeof value === 'boolean') return value
      // cac lists a two-word boolean by its camelCased name and the parser
      // looks it up by the dashed one, so the word after the flag is its value.
      throw new Error(`${flag} took ${JSON.stringify(String(value))} as its value: put the flag after the arguments.`)
    case 'number': {
      const parsed = Number(value)
      if (!Number.isInteger(parsed)) {
        throw new Error(`${flag} expects an integer; got ${JSON.stringify(value)}.`)
      }
      return parsed
    }
    case 'string': {
      if (spec.field === 'workspaceId') return workspaceAssertion(value).workspaceId
      if (Array.isArray(value)) {
        throw new Error(`${flag} expects a single value; got ${JSON.stringify(value)}.`)
      }
      if (value === 0) return ''
      refuseNumberified(flag, value)
      return String(value)
    }
    case 'string-array': {
      // Each occurrence is one value, never split on commas (repeat the flag
      // for more): a type label can contain one.
      const items = Array.isArray(value) ? value : [value]
      for (const item of items) refuseNumberified(flag, item)
      return items.map(item => String(item).trim()).filter(item => item !== '')
    }
    case 'spec': {
      if (Array.isArray(value)) {
        throw new Error(`${flag} expects a single value; got ${JSON.stringify(value)}.`)
      }
      const text = String(value)
      if (spec.keywords.includes(text)) return text
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`${flag} must be one of ${spec.keywords.join('|')} or valid JSON; got ${JSON.stringify(text)}.`)
      }
    }
  }
}

const formatZodError = (error: z.ZodError, input: ToolInput): string =>
  error.issues.map(issue => {
    const field = String(issue.path[0] ?? '')
    const label = field in input ? flagOf(field) : field
    const empty = input[field] === 0 ? EMPTY_VALUE_HINT : ''
    return `${label}: ${issue.message}.${empty}`
  }).join(' ')

/** Build the tool input from what cac hands the action. `positional` is the
 *  positional argument (a string, or the variadic array). */
export const cliInputFrom = (
  tool: GraphReadTool,
  positional: unknown,
  options: Record<string, unknown>,
): ToolInput => {
  const input: ToolInput = {}
  const verb = tool.cli?.verb ?? tool.name
  const spec = tool.cli?.positional
  if (spec) {
    // A word right after a one-word boolean (--json, --raw) comes back as a
    // number, its leading zeros already gone.
    const numbered = (Array.isArray(positional) ? positional : [positional]).find(item => typeof item === 'number')
    if (numbered !== undefined) {
      throw new Error(`${verb} got ${numbered} as a number, the way the parser reads a word right after a flag: put the flags after the arguments.`)
    }
    const text = (Array.isArray(positional) ? positional.map(String).join(' ') : String(positional ?? '')).trim()
    if (text) input[spec.field] = text
    else if (!spec.optional) throw new Error(`${verb} requires a <${spec.field}> (see \`kmagent ${verb} --help\`)`)
  }
  for (const option of cliOptionsFor(tool)) {
    const value = options[cacKey(option.key)]
    if (value === undefined) continue
    if (option.field in input) {
      throw new Error(`Pass the ${option.field} once: as \`kmagent ${verb} <${option.field}>\` or as --${option.key}.`)
    }
    input[option.field] = coerceOption(option, value)
  }
  if (hasJsonFormat(tool) && options.json) input.format = 'json'

  const parsed = z.object(tool.shape).safeParse(input)
  if (!parsed.success) throw new Error(formatZodError(parsed.error, input))
  return parsed.data
}

/** The wire command a CLI invocation sends (the agent view, or the stored
 *  shape under `--raw`). */
export const cliCommandFrom = (
  tool: GraphReadTool,
  positional: unknown,
  options: Record<string, unknown>,
): KnownCommand => {
  const input = cliInputFrom(tool, positional, options)
  return options.raw ? rawToolCommand(tool, input) : toolCommand(tool, input)
}
