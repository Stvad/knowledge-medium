export interface SeekToEventDetail {
  seconds: number
  blockId: string
}

export const seekToEventName = 'video-seek-to'

export const seekTo = (seconds: number, blockId: string) => {
  const event = new CustomEvent<SeekToEventDetail>(seekToEventName, {
    detail: {seconds, blockId},
  })
  window.dispatchEvent(event)
}
