export type PlatformId = 'twitter' | 'bluesky' | 'lesswrong'
export type TargetPlatform = PlatformId | 'all'

export interface PostBlock {
  id: string
  content: string
}

export interface ProcessedBlock {
  id: string
  raw: string
  text: string
  mediaUrls: string[]
}

export interface PlatformConfig {
  bufferToken: string | null
  blueskyHandle: string
  blueskyAppPassword: string | null
  lesswrongToken: string | null
  corsProxyUrl: string
}

export interface PostResult {
  platform: PlatformId
  success: boolean
  url?: string
  error?: string
}

export const PLATFORM_LABELS: Record<PlatformId, string> = {
  twitter: 'X / Twitter',
  bluesky: 'Bluesky',
  lesswrong: 'LessWrong',
}

export const PLATFORM_SHORT_LABELS: Record<PlatformId, string> = {
  twitter: 'X',
  bluesky: 'Bluesky',
  lesswrong: 'LW',
}

export const PLATFORM_ORDER: PlatformId[] = ['twitter', 'bluesky', 'lesswrong']
