/**
 * Per-run metrics from a `claude -p --output-format stream-json --verbose`
 * transcript: every tool call with the bytes it sent and got back, token
 * usage, turns, and the final reply.
 *
 * Usage arrives once per API call but the stream repeats an assistant
 * message's line for each of its content blocks, so per-call usage is keyed
 * by message id. The `result` line's totals win when present.
 */

export interface ToolCallRecord {
  id: string
  name: string
  inputBytes: number
  /** null when the transcript ended before the tool returned. */
  outputBytes: number | null
  isError: boolean
}

export interface TokenUsage {
  input: number
  cacheCreation: number
  cacheRead: number
  output: number
  /** Context tokens read across all API calls (input + cache creation + cache read). */
  contextTotal: number
  /** The largest single API call's context — the conversation's high-water mark. */
  peakContext: number
}

export interface TranscriptMetrics {
  sessionId: string | null
  model: string | null
  claudeCodeVersion: string | null
  toolCalls: ToolCallRecord[]
  apiCalls: number
  tokens: TokenUsage
  numTurns: number | null
  durationMs: number | null
  /** List-price equivalent the CLI reports; under subscription billing nothing is charged. */
  costUsd: number | null
  resultText: string
  isError: boolean
  terminalReason: string | null
}

interface MessageUsage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  output_tokens?: number
}

type Json = Record<string, unknown>

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8')
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
const contextOf = (usage: MessageUsage) =>
  num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens)

const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && typeof (part as Json).text === 'string' ? (part as Json).text as string : ''))
    .join('')
}

export const parseTranscript = (raw: string): TranscriptMetrics => {
  const metrics: TranscriptMetrics = {
    sessionId: null,
    model: null,
    claudeCodeVersion: null,
    toolCalls: [],
    apiCalls: 0,
    tokens: {input: 0, cacheCreation: 0, cacheRead: 0, output: 0, contextTotal: 0, peakContext: 0},
    numTurns: null,
    durationMs: null,
    costUsd: null,
    resultText: '',
    isError: false,
    terminalReason: null,
  }
  const usageByMessage = new Map<string, MessageUsage>()
  const callsById = new Map<string, ToolCallRecord>()
  let resultUsage: MessageUsage | null = null

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let event: Json
    try {
      event = JSON.parse(line) as Json
    } catch {
      continue
    }

    if (event.type === 'system' && event.subtype === 'init') {
      metrics.sessionId = typeof event.session_id === 'string' ? event.session_id : null
      metrics.model = typeof event.model === 'string' ? event.model : null
      metrics.claudeCodeVersion = typeof event.claude_code_version === 'string' ? event.claude_code_version : null
    } else if (event.type === 'assistant') {
      const message = (event.message ?? {}) as Json
      if (typeof message.id === 'string' && message.usage) usageByMessage.set(message.id, message.usage as MessageUsage)
      for (const block of Array.isArray(message.content) ? message.content as Json[] : []) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || callsById.has(block.id)) continue
        const call: ToolCallRecord = {
          id: block.id,
          name: typeof block.name === 'string' ? block.name : '?',
          inputBytes: byteLength(JSON.stringify(block.input ?? {})),
          outputBytes: null,
          isError: false,
        }
        callsById.set(call.id, call)
        metrics.toolCalls.push(call)
      }
    } else if (event.type === 'user') {
      const message = (event.message ?? {}) as Json
      for (const block of Array.isArray(message.content) ? message.content as Json[] : []) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
        const call = callsById.get(block.tool_use_id)
        if (!call) continue
        call.outputBytes = byteLength(toolResultText(block.content))
        call.isError = block.is_error === true
      }
    } else if (event.type === 'result') {
      metrics.resultText = typeof event.result === 'string' ? event.result : ''
      metrics.isError = event.is_error === true
      metrics.numTurns = typeof event.num_turns === 'number' ? event.num_turns : null
      metrics.durationMs = typeof event.duration_ms === 'number' ? event.duration_ms : null
      metrics.costUsd = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
      metrics.terminalReason = typeof event.terminal_reason === 'string' ? event.terminal_reason : null
      resultUsage = (event.usage ?? null) as MessageUsage | null
    }
  }

  const perCall = [...usageByMessage.values()]
  const totals = resultUsage ?? perCall.reduce<MessageUsage>((sum, usage) => ({
    input_tokens: num(sum.input_tokens) + num(usage.input_tokens),
    cache_creation_input_tokens: num(sum.cache_creation_input_tokens) + num(usage.cache_creation_input_tokens),
    cache_read_input_tokens: num(sum.cache_read_input_tokens) + num(usage.cache_read_input_tokens),
    output_tokens: num(sum.output_tokens) + num(usage.output_tokens),
  }), {})
  metrics.apiCalls = perCall.length
  metrics.tokens = {
    input: num(totals.input_tokens),
    cacheCreation: num(totals.cache_creation_input_tokens),
    cacheRead: num(totals.cache_read_input_tokens),
    output: num(totals.output_tokens),
    contextTotal: contextOf(totals),
    peakContext: perCall.reduce((peak, usage) => Math.max(peak, contextOf(usage)), 0),
  }
  return metrics
}

/** The JSON on the reply's last `ANSWER:` line, or undefined when there is
 *  none or it does not parse. Tolerates a fenced or backticked line. */
export const extractAnswer = (resultText: string): unknown => {
  const lines = resultText.split('\n').map(line => line.trim().replace(/^`+|`+$/g, '').trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = /^\**ANSWER:\**\s*(.+)$/.exec(lines[i])
    if (!match) continue
    try {
      return JSON.parse(match[1].replace(/`+$/, '').trim()) as unknown
    } catch {
      return undefined
    }
  }
  return undefined
}
