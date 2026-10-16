/**
 * Per-run metrics from a `claude -p --output-format stream-json --verbose`
 * transcript: every tool call with the bytes it sent and got back, token
 * usage, turns, and the final reply.
 *
 * Usage arrives once per API call but the stream repeats an assistant
 * message's line for each of its content blocks, so per-call usage is keyed
 * by message id. The `result` line's totals win when present; without one
 * (a timed-out run) output tokens come out low, because the per-message
 * `output_tokens` the stream carries are partial.
 *
 * A tool result over Claude Code's MCP output cap never reaches the model:
 * it is replaced by a short notice naming the size. Such a call is recorded
 * as `capped`, with the bytes the model saw and the size the server returned
 * kept apart — otherwise a tool that shrinks its output below the cap would
 * read as a regression.
 */

export interface ToolCallRecord {
  id: string
  name: string
  /** Bytes the model saw; null when the transcript ended before the tool returned. */
  outputBytes: number | null
  /** Replaced by Claude Code's over-the-cap notice. */
  capped: boolean
  /** Size the server returned: the notice's character count when capped,
   *  else `outputBytes`. */
  returnedBytes: number | null
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

const CAP_NOTICE = /^Error: result \(([\d,]+) characters across [\d,]+ lines\) exceeds maximum allowed tokens/

const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => (part && typeof part === 'object' && typeof (part as Json).text === 'string' ? (part as Json).text as string : ''))
    .join('')
}

export const parseTranscript = (raw: string): TranscriptMetrics => {
  const metrics: TranscriptMetrics = {
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
          outputBytes: null,
          capped: false,
          returnedBytes: null,
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
        const text = toolResultText(block.content)
        const cap = CAP_NOTICE.exec(text)
        call.outputBytes = byteLength(text)
        call.capped = cap !== null
        call.returnedBytes = cap ? Number(cap[1].replace(/,/g, '')) : call.outputBytes
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

/** The first balanced `{…}` in `text`, honoring JSON strings. */
const firstJsonObject = (text: string): string | null => {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const char = text[i]
    if (inString) {
      if (char === '\\') i++
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/** The JSON after the reply's last `ANSWER:` marker, or undefined when there
 *  is none or it does not parse. Tolerates the decoration models add: bold or
 *  code around the marker or the JSON, a list or quote prefix, a trailing
 *  period, JSON spread over several lines. */
export const extractAnswer = (resultText: string): unknown => {
  const markers = [...resultText.matchAll(/\bANSWER\b[*_`]*\s*:/g)]
  const last = markers.at(-1)
  if (!last) return undefined
  const json = firstJsonObject(resultText.slice(last.index + last[0].length))
  if (json === null) return undefined
  try {
    return JSON.parse(json) as unknown
  } catch {
    return undefined
  }
}
