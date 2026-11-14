// Whether the USER is active, as opposed to the main thread: `requestIdleCallback`
// fires between keystrokes, so it cannot tell background work to stand aside
// while someone is typing. This watches input events and says how long ago the
// last one arrived.

/** Input that means someone is at the keyboard, pointer or screen. `scroll` is
 *  caught in the capture phase, so a scroll inside any element counts. */
const ACTIVITY_EVENTS = ['keydown', 'pointerdown', 'wheel', 'scroll', 'input'] as const

export interface UserActivity {
  /** Resolves once no input has arrived for `quietMs`, at once if none has. */
  whenQuiet: (quietMs: number) => Promise<void>
}

export const createUserActivity = (target: EventTarget): UserActivity => {
  let lastInputAt = Number.NEGATIVE_INFINITY
  const onInput = () => { lastInputAt = Date.now() }
  for (const type of ACTIVITY_EVENTS) {
    target.addEventListener(type, onInput, {capture: true, passive: true})
  }
  return {
    whenQuiet: async quietMs => {
      for (;;) {
        const remaining = lastInputAt + quietMs - Date.now()
        if (remaining <= 0) return
        await new Promise<void>(resolve => setTimeout(resolve, remaining))
      }
    },
  }
}

let windowActivity: UserActivity | undefined

/** The app-wide tracker, listening on `window` from its first call for the
 *  life of the page. Call it early: input before that call is not seen. */
export const userActivity = (): UserActivity =>
  windowActivity ??= createUserActivity(window)
