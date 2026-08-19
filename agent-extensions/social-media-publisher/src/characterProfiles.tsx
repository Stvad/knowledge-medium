import {useContent} from '@/hooks/block.js'
import type {CharacterCountProfile} from '@/plugins/character-counter/index.js'
import {useEffect, useState} from 'react'

import {
  BLUESKY_COUNT_PROFILE_ID,
  TWITTER_COUNT_PROFILE_ID,
} from './constants'
import {
  blueskyGraphemeLength,
  twitterWeightedLength,
} from './platformCounts'
import {processBlockText} from './textProcessing'

const useProcessedSocialText = (block: any): string => {
  const content = useContent(block)
  const [processed, setProcessed] = useState<{content: string, text: string}>({
    content: '',
    text: '',
  })

  useEffect(() => {
    let cancelled = false
    setProcessed(current =>
      current.content === content ? current : {content, text: ''})
    void processBlockText(content, block.repo)
      .then(result => {
        if (!cancelled) setProcessed({content, text: result.text})
      })
      .catch(() => {
        if (!cancelled) setProcessed({content, text: content.trim()})
      })
    return () => { cancelled = true }
  }, [block, content])

  return processed.content === content ? processed.text : ''
}

const useTwitterSocialCount = (block: any): number =>
  twitterWeightedLength(useProcessedSocialText(block))

const useBlueskySocialCount = (block: any): number =>
  blueskyGraphemeLength(useProcessedSocialText(block))

export const twitterCountProfile: CharacterCountProfile = {
  id: TWITTER_COUNT_PROFILE_ID,
  useCount: useTwitterSocialCount,
}

export const blueskyCountProfile: CharacterCountProfile = {
  id: BLUESKY_COUNT_PROFILE_ID,
  useCount: useBlueskySocialCount,
}
