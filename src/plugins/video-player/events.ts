export interface SeekToEventDetail {
  seconds: number
  blockId: string
}

export interface CurrentTimeRequestEventDetail {
  blockId: string
  respond: (seconds: number) => void
}

export const seekToEventName = 'video-seek-to'
export const currentTimeRequestEventName = 'video-current-time-request'

export const seekTo = (seconds: number, blockId: string) => {
  const event = new CustomEvent<SeekToEventDetail>(seekToEventName, {
    detail: {seconds, blockId},
  })
  window.dispatchEvent(event)
}

export const requestCurrentTime = (blockId: string): number | undefined => {
  let currentTime: number | undefined
  const event = new CustomEvent<CurrentTimeRequestEventDetail>(currentTimeRequestEventName, {
    detail: {
      blockId,
      respond: seconds => {
        currentTime = seconds
      },
    },
  })
  window.dispatchEvent(event)
  return currentTime
}
