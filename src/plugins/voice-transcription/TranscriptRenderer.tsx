import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useEffect,
  type ReactNode,
} from 'react'
import { Copy, Gauge, SkipForward, Volume2 } from 'lucide-react'
import type { BlockData } from '@/data/api'
import {
  DefaultBlockRenderer,
} from '@/components/renderer/DefaultBlockRenderer.tsx'
import { MarkdownContentRenderer } from '@/components/renderer/MarkdownContentRenderer.tsx'
import { Button } from '@/components/ui/button.tsx'
import { Checkbox } from '@/components/ui/checkbox.tsx'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useContent, useHandle, usePropertyValue } from '@/hooks/block.ts'
import type { Block } from '@/data/block'
import type { BlockRenderer, BlockRendererProps } from '@/types.ts'
import { hasBlockType } from '@/data/properties.ts'
import {
  formatTranscriptTime,
  formatTranscriptTimeRange,
} from './model.ts'
import {
  TRANSCRIPT_SEGMENT_TYPE,
  VOICE_TRANSCRIPT_TYPE,
  transcriptAudioUrlProp,
  transcriptEndedAtProp,
  transcriptErrorProp,
  transcriptSegmentEndMsProp,
  transcriptSegmentStartMsProp,
  transcriptStartedAtProp,
  transcriptStatusProp,
} from './schema.ts'

interface TimedSegment {
  id: string
  startMs: number
  endMs: number
}

interface TranscriptPlaybackContextValue {
  activeMs: number
  currentSegmentId: string | null
  requestSeek: (ms: number) => void
  seekRequest: {id: number; ms: number} | null
  segments: readonly TimedSegment[]
  setActiveMs: (ms: number) => void
  skipGaps: boolean
  setSkipGaps: (value: boolean) => void
}

const TranscriptPlaybackContext = createContext<TranscriptPlaybackContextValue | null>(null)

const decodeOptionalNumber = (
  data: BlockData,
  schema: typeof transcriptSegmentStartMsProp | typeof transcriptSegmentEndMsProp,
): number | undefined => {
  const stored = data.properties[schema.name]
  return stored === undefined ? undefined : schema.codec.decode(stored)
}

const useTimedSegments = (block: Block): readonly TimedSegment[] =>
  useHandle(block.repo.query.children({id: block.id}), {
    selector: rows => (rows ?? [])
      .filter(row => hasBlockType(row, TRANSCRIPT_SEGMENT_TYPE))
      .map(row => {
        const startMs = decodeOptionalNumber(row, transcriptSegmentStartMsProp)
        const endMs = decodeOptionalNumber(row, transcriptSegmentEndMsProp)
        return startMs === undefined || endMs === undefined
          ? null
          : {id: row.id, startMs, endMs}
      })
      .filter((row): row is TimedSegment => row !== null),
  })

const segmentAt = (
  segments: readonly TimedSegment[],
  ms: number,
): TimedSegment | undefined =>
  segments.find(segment => ms >= segment.startMs && ms <= segment.endMs)

const nextSegmentAfter = (
  segments: readonly TimedSegment[],
  ms: number,
): TimedSegment | undefined =>
  segments.find(segment => segment.startMs > ms)

const TranscriptPlaybackProvider = ({
  block,
  children,
}: {
  block: Block
  children: ReactNode
}) => {
  const segments = useTimedSegments(block)
  const [activeMs, setActiveMs] = useState(0)
  const [skipGaps, setSkipGaps] = useState(true)
  const [seekRequest, setSeekRequest] = useState<{id: number; ms: number} | null>(null)

  const currentSegmentId = useMemo(
    () => segmentAt(segments, activeMs)?.id ?? null,
    [activeMs, segments],
  )

  const requestSeek = useCallback((ms: number) => {
    setActiveMs(ms)
    setSeekRequest(current => ({
      id: (current?.id ?? 0) + 1,
      ms,
    }))
  }, [])

  const value = useMemo<TranscriptPlaybackContextValue>(() => ({
    activeMs,
    currentSegmentId,
    requestSeek,
    seekRequest,
    segments,
    setActiveMs,
    skipGaps,
    setSkipGaps,
  }), [
    activeMs,
    currentSegmentId,
    requestSeek,
    seekRequest,
    segments,
    skipGaps,
  ])

  return (
    <TranscriptPlaybackContext.Provider value={value}>
      {children}
    </TranscriptPlaybackContext.Provider>
  )
}

const useTranscriptPlayback = () => useContext(TranscriptPlaybackContext)

const isTypedBlock = (block: Block, typeId: string): boolean => {
  const data = block.peek()
  return Boolean(data && hasBlockType(data, typeId))
}

const VoiceTranscriptContentRenderer = ({block}: BlockRendererProps) => {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const content = useContent(block)
  const [status] = usePropertyValue(block, transcriptStatusProp)
  const [startedAt] = usePropertyValue(block, transcriptStartedAtProp)
  const [endedAt] = usePropertyValue(block, transcriptEndedAtProp)
  const [audioUrl] = usePropertyValue(block, transcriptAudioUrlProp)
  const [error] = usePropertyValue(block, transcriptErrorProp)
  const playback = useTranscriptPlayback()
  const startedLabel = startedAt ? new Date(startedAt).toLocaleString() : ''
  const durationLabel = startedAt && endedAt
    ? formatTranscriptTime(endedAt - startedAt)
    : ''

  useEffect(() => {
    if (!playback?.seekRequest) return
    const audio = audioRef.current
    if (!audio) return

    audio.currentTime = Math.max(0, playback.seekRequest.ms) / 1000
    void audio.play().catch(() => {
      // Browser autoplay policies can reject this; the explicit seek still applied.
    })
  }, [playback?.seekRequest])

  const handleTimeUpdate = useCallback(() => {
    if (!playback) return
    const audio = audioRef.current
    if (!audio) return

    const currentMs = Math.round(audio.currentTime * 1000)
    if (playback.skipGaps && audio.paused === false && !segmentAt(playback.segments, currentMs)) {
      const next = nextSegmentAfter(playback.segments, currentMs + 250)
      if (next && next.startMs - currentMs > 700) {
        audio.currentTime = next.startMs / 1000
        playback.setActiveMs(next.startMs)
        return
      }
    }

    playback.setActiveMs(currentMs)
  }, [playback])

  return (
    <div className="flex min-w-0 flex-col gap-2 py-1">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground"/>
        <span className="min-w-0 flex-1 truncate font-medium">
          {content || 'Voice transcript'}
        </span>
        <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
          {status}
        </span>
        {durationLabel && (
          <span className="text-xs text-muted-foreground">{durationLabel}</span>
        )}
      </div>

      {audioUrl && playback && (
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-muted/35 p-2">
          <audio
            ref={audioRef}
            src={audioUrl}
            controls
            className="w-full"
            onTimeUpdate={handleTimeUpdate}
          />
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={playback.skipGaps}
              onCheckedChange={value => playback.setSkipGaps(value === true)}
              aria-label="Skip transcript gaps"
            />
            <SkipForward className="h-3.5 w-3.5"/>
            <span>Skip gaps</span>
          </label>
        </div>
      )}

      {(startedLabel || error) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {startedLabel && <span>{startedLabel}</span>}
          {error && <span className="text-destructive">{error}</span>}
        </div>
      )}
    </div>
  )
}

const TranscriptSegmentContentRenderer = ({block}: BlockRendererProps) => {
  const content = useContent(block)
  const [startMs] = usePropertyValue(block, transcriptSegmentStartMsProp)
  const [endMs] = usePropertyValue(block, transcriptSegmentEndMsProp)
  const playback = useTranscriptPlayback()
  const active = playback?.currentSegmentId === block.id

  const copyTimedExcerpt = () => {
    const excerpt = `[${formatTranscriptTimeRange(startMs, endMs)}] ${content}`.trim()
    void navigator.clipboard?.writeText(excerpt).catch(() => {
      // Clipboard permissions are browser-controlled; failing silently keeps editing uninterrupted.
    })
  }

  return (
    <div
      className={`group/transcript flex min-w-0 items-start gap-2 rounded-sm py-0.5 ${active ? 'bg-primary/10' : ''}`}
    >
      <button
        type="button"
        className="mt-0.5 inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1 text-xs tabular-nums text-muted-foreground no-underline hover:bg-accent hover:text-foreground"
        title="Seek to transcript segment"
        aria-label="Seek to transcript segment"
        data-block-interaction="ignore"
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          if (startMs !== undefined) playback?.requestSeek(startMs)
        }}
      >
        <Gauge className="h-3 w-3"/>
        {formatTranscriptTime(startMs)}
      </button>
      <div className="min-w-0 flex-1">
        <MarkdownContentRenderer
          block={block}
          containerClassName="min-h-[1.7em] whitespace-pre-wrap overflow-x-hidden max-w-full"
        />
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-6 w-6 shrink-0 opacity-0 group-hover/transcript:opacity-100 focus-visible:opacity-100"
        title="Copy timed excerpt"
        aria-label="Copy timed excerpt"
        data-block-interaction="ignore"
        onClick={event => {
          event.preventDefault()
          event.stopPropagation()
          copyTimedExcerpt()
        }}
      >
        <Copy className="h-3.5 w-3.5"/>
      </Button>
    </div>
  )
}

export const VoiceTranscriptRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <NestedBlockContextProvider overrides={{voiceTranscriptBlockId: props.block.id}}>
    <TranscriptPlaybackProvider block={props.block}>
      <DefaultBlockRenderer
        {...props}
        ContentRenderer={VoiceTranscriptContentRenderer}
      />
    </TranscriptPlaybackProvider>
  </NestedBlockContextProvider>
)

VoiceTranscriptRenderer.canRender = ({block}: BlockRendererProps) =>
  isTypedBlock(block, VOICE_TRANSCRIPT_TYPE)

VoiceTranscriptRenderer.priority = () => 8

export const TranscriptSegmentRenderer: BlockRenderer = (props: BlockRendererProps) => (
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={TranscriptSegmentContentRenderer}
  />
)

TranscriptSegmentRenderer.canRender = ({block}: BlockRendererProps) =>
  isTypedBlock(block, TRANSCRIPT_SEGMENT_TYPE)

TranscriptSegmentRenderer.priority = () => 8
