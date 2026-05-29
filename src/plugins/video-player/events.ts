export interface SeekToEventDetail {
  seconds: number
  blockId: string
}

export interface CurrentTimeRequestEventDetail {
  blockId: string
  respond: (seconds: number) => void
}

export interface FocusVideoPlayerEventDetail {
  blockId: string
  respond: (handled: boolean) => void
}

export interface VideoPlayerFocusStateRequestEventDetail {
  blockId: string
  respond: (focused: boolean) => void
}

export const seekToEventName = 'video-seek-to'
export const currentTimeRequestEventName = 'video-current-time-request'
export const focusVideoPlayerEventName = 'video-focus-player-request'
export const videoPlayerFocusStateRequestEventName = 'video-player-focus-state-request'

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

export const requestVideoPlayerFocus = (blockId: string): boolean => {
  let handled = false
  const event = new CustomEvent<FocusVideoPlayerEventDetail>(focusVideoPlayerEventName, {
    detail: {
      blockId,
      respond: didHandle => {
        handled = handled || didHandle
      },
    },
  })
  window.dispatchEvent(event)
  return handled
}

export const isVideoPlayerFocusActive = (blockId: string): boolean => {
  let focused = false
  const event = new CustomEvent<VideoPlayerFocusStateRequestEventDetail>(
    videoPlayerFocusStateRequestEventName,
    {
      detail: {
        blockId,
        respond: isFocused => {
          focused = focused || isFocused
        },
      },
    },
  )
  window.dispatchEvent(event)
  return focused
}
