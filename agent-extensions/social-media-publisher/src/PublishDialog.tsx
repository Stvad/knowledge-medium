import {openDialog, type DialogContextProps} from '@/utils/dialogs.js'
import {showError, showSuccess} from '@/utils/toast.js'
import {Button} from '@/components/ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.js'
import {useEffect, useMemo, useState} from 'react'

import {
  BLUESKY_CHAR_LIMIT,
  TWITTER_CHAR_LIMIT,
} from './constants'
import {
  configuredPlatforms,
  loadConfig,
  platformsForTarget,
} from './credentials'
import {
  AlertCircleIcon,
  CheckCircleIcon,
  ExternalLinkIcon,
  SendIcon,
} from './icons'
import {annotateParent} from './publishHistory'
import {
  countForPlatform,
  validateThread,
} from './platformCounts'
import {postToPlatform} from './platforms'
import {
  processBlocks,
  readChildBlocks,
} from './textProcessing'
import type {
  PlatformConfig,
  PlatformId,
  PostBlock,
  PostResult,
  ProcessedBlock,
  TargetPlatform,
} from './types'
import {
  PLATFORM_LABELS,
  PLATFORM_ORDER,
  PLATFORM_SHORT_LABELS,
} from './types'

interface PublishDialogProps {
  repo: any
  blockId: string
  target: TargetPlatform
}

export const publishFromBlock = async (
  repo: any,
  blockId: string,
  target: TargetPlatform,
): Promise<void> => {
  await openDialog(PublishDialog, {repo, blockId, target})
}

export const PublishDialog = ({
  repo,
  blockId,
  target,
  resolve,
  cancel,
}: DialogContextProps<boolean> & PublishDialogProps) => {
  const [rawBlocks, setRawBlocks] = useState<PostBlock[]>([])
  const [processedBlocks, setProcessedBlocks] = useState<ProcessedBlock[]>([])
  const [config, setConfig] = useState<PlatformConfig | null>(null)
  const [selected, setSelected] = useState<Set<PlatformId>>(new Set())
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [results, setResults] = useState<PostResult[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setLoadError(null)
      try {
        const nextConfig = await loadConfig(repo)
        const blocks = await readChildBlocks(repo, blockId)
        const processed = await processBlocks(blocks, repo)
        if (cancelled) return
        setConfig(nextConfig)
        setRawBlocks(blocks)
        setProcessedBlocks(processed)
        setSelected(new Set(platformsForTarget(target, nextConfig)))
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [repo, blockId, target])

  const availablePlatforms = useMemo(() => configuredPlatforms(config ?? {
    bufferToken: null,
    blueskyHandle: '',
    blueskyAppPassword: null,
    lesswrongToken: null,
    corsProxyUrl: '',
  }), [config])

  const validations = useMemo(() => {
    const errors: string[] = []
    if (rawBlocks.length === 0) errors.push('No child blocks found under the focused block')
    for (const platform of selected) {
      if (config && !configuredPlatforms(config).includes(platform)) {
        errors.push(`${PLATFORM_LABELS[platform]} is not configured`)
      }
      errors.push(...validateThread(processedBlocks, platform))
    }
    if (selected.size === 0) errors.push('No platform selected')
    return errors
  }, [config, processedBlocks, rawBlocks.length, selected])

  const togglePlatform = (platform: PlatformId): void => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(platform)) next.delete(platform)
      else next.add(platform)
      return next
    })
  }

  const submit = async (): Promise<void> => {
    if (!config) return
    setSending(true)
    setResults([])
    const platforms = Array.from(selected)
    try {
      const nextResults = await Promise.all(platforms.map(platform =>
        postToPlatform(platform, processedBlocks, rawBlocks, repo, config)))
      setResults(nextResults)
      await annotateParent(repo, blockId, nextResults)
      const failures = nextResults.filter(result => !result.success)
      if (failures.length === 0) showSuccess('Published social posts')
      else showError(`Publishing finished with ${failures.length} failure${failures.length === 1 ? '' : 's'}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open onOpenChange={open => { if (!open) cancel() }}>
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle>Publish to social media</DialogTitle>
          <DialogDescription>
            Publishes each child block as a thread item; LessWrong receives one combined shortform post.
          </DialogDescription>
        </DialogHeader>

        {loading && <div className='text-sm text-muted-foreground'>Loading draft...</div>}
        {loadError && (
          <div className='flex items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive'>
            <AlertCircleIcon className='h-4 w-4' />
            {loadError}
          </div>
        )}
        {!loading && !loadError && (
          <div className='grid gap-4'>
            <div className='grid gap-2'>
              <div className='text-sm font-medium'>Platforms</div>
              <div className='flex flex-wrap gap-2'>
                {PLATFORM_ORDER.map(platform => {
                  const configured = availablePlatforms.includes(platform)
                  const active = selected.has(platform)
                  return (
                    <Button
                      key={platform}
                      type='button'
                      size='sm'
                      variant={active ? 'default' : 'outline'}
                      onClick={() => togglePlatform(platform)}
                      disabled={target !== 'all' && target !== platform}
                      title={configured ? PLATFORM_LABELS[platform] : `${PLATFORM_LABELS[platform]} is not configured`}
                    >
                      {configured ? <CheckCircleIcon className='mr-2 h-4 w-4' /> : <AlertCircleIcon className='mr-2 h-4 w-4' />}
                      {PLATFORM_SHORT_LABELS[platform]}
                    </Button>
                  )
                })}
              </div>
            </div>

            <div className='max-h-56 overflow-auto rounded-md border'>
              {processedBlocks.length === 0 ? (
                <div className='p-3 text-sm text-muted-foreground'>No child posts to preview.</div>
              ) : processedBlocks.map((block, index) => (
                <div key={block.id} className='border-b p-3 last:border-b-0'>
                  <div className='mb-1 text-xs text-muted-foreground'>Post {index + 1}</div>
                  <div className='whitespace-pre-wrap text-sm'>{block.text || '(media only)'}</div>
                  {block.mediaUrls.length > 0 && (
                    <div className='mt-1 text-xs text-muted-foreground'>
                      {block.mediaUrls.length} image{block.mediaUrls.length === 1 ? '' : 's'}
                    </div>
                  )}
                  <div className='mt-2 flex gap-3 text-xs text-muted-foreground'>
                    <span>X {countForPlatform(block, 'twitter')}/{TWITTER_CHAR_LIMIT}</span>
                    <span>Bluesky {countForPlatform(block, 'bluesky')}/{BLUESKY_CHAR_LIMIT}</span>
                  </div>
                </div>
              ))}
            </div>

            {validations.length > 0 && (
              <div className='rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive'>
                {validations.map(error => <div key={error}>{error}</div>)}
              </div>
            )}

            {results.length > 0 && (
              <div className='grid gap-2 rounded-md border p-3 text-sm'>
                {results.map(result => (
                  <div key={result.platform} className='flex items-center gap-2'>
                    {result.success ? (
                      <CheckCircleIcon className='h-4 w-4 text-green-600' />
                    ) : (
                      <AlertCircleIcon className='h-4 w-4 text-destructive' />
                    )}
                    <span>{PLATFORM_LABELS[result.platform]}</span>
                    {result.url && (
                      <a
                        className='inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline'
                        href={result.url}
                        target='_blank'
                        rel='noreferrer'
                      >
                        View
                        <ExternalLinkIcon className='h-3 w-3' />
                      </a>
                    )}
                    {result.error && <span className='text-destructive'>{result.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type='button' variant='outline' onClick={() => resolve(false)} disabled={sending}>
            Close
          </Button>
          <Button type='button' onClick={submit} disabled={loading || sending || validations.length > 0}>
            <SendIcon className='mr-2 h-4 w-4' />
            {sending ? 'Publishing...' : 'Publish'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
